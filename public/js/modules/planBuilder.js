// Pipeline orchestrator — ties together CLIP, EXIF, sessions, geocoding, and Gemini.
// Returns a Plan: Array<{ handle, destPath }> ready for fileCopier.

import { makeFileKey, getCached, putCached, evictExpired } from './idbCache.js';
import { readExif } from './exifReader.js';
import { clusterSessions, detectTrips, detectHomeCity, detectHomeCentroid, resetTripCounter, MIN_PHOTOS_FOR_LLM } from './sessionBuilder.js';
import { reverseGeocode, sessionCentroid } from './geocoder.js';
import { getAuthHeaders } from './auth.js';

const VIDEO_EXT        = new Set(['.mp4', '.mov', '.avi', '.mkv', '.m4v']);
const VIDEO_BUFFER_DAYS = 1; // match videos to events within ±this many days

// ── CLIP Worker bridge ────────────────────────────────────────────────────────

let worker = null;
let workerReady = false;
const pending = new Map(); // id → { resolve, reject }
let msgCounter = 0;

function initWorker(onModelProgress) {
  return new Promise((resolve, reject) => {
    worker = new Worker('/js/workers/clipWorker.js', { type: 'module' });
    worker.onmessage = ({ data }) => {
      if (data.type === 'READY') { workerReady = true; resolve(); return; }
      if (data.type === 'PROGRESS') { onModelProgress?.(data); return; }
      if (data.type === 'ERROR') {
        const p = pending.get(data.id);
        if (p) { p.reject(new Error(data.message)); pending.delete(data.id); }
        return;
      }
      const p = pending.get(data.id ?? data.sessionId);
      if (p) { p.resolve(data); pending.delete(data.id ?? data.sessionId); }
    };
    worker.onerror = e => reject(new Error(e.message));
    worker.postMessage({ type: 'INIT' });
  });
}

async function classifyImage(file) {
  const id  = String(++msgCounter);
  const buf = await file.arrayBuffer();
  return new Promise((resolve, reject) => {
    pending.set(id, { resolve, reject });
    worker.postMessage({ type: 'CLASSIFY', id, buffer: buf, mimeType: file.type || 'image/jpeg' }, [buf]);
  });
}

async function tagSession(sessionId, files) {
  const buffers   = [];
  const mimeTypes = [];
  // Pre-read files before transfer (can't re-read after transfer)
  for (const f of files) {
    buffers.push(await f.arrayBuffer());
    mimeTypes.push(f.type || 'image/jpeg');
  }
  return new Promise((resolve, reject) => {
    pending.set(sessionId, { resolve, reject });
    worker.postMessage(
      { type: 'TAG_SESSION', sessionId, buffers, mimeTypes },
      buffers
    );
  });
}

// ── Main pipeline ─────────────────────────────────────────────────────────────

// scannedFiles: output of folderPicker.scanDirectory()
// homeCity: string (e.g. "Vienna") — used to detect away trips
// onStatus: (msg: string) => void — status text updates
// onProgress: ({ stage, done, total }) => void — progress updates
export async function buildPlan(scannedFiles, onStatus, onProgress) {
  await evictExpired();

  const images = scannedFiles.filter(f => !f.isVideo);
  const videos = scannedFiles.filter(f => f.isVideo);

  // ── Stage 1: CLIP trash detection ─────────────────────────────────────────
  onStatus('Loading AI model (first run: ~350MB download, cached forever after)…');
  await initWorker(info => {
    if (info.total) onProgress({ stage: 'model', done: info.loaded, total: info.total });
  });

  onStatus(`Classifying ${images.length} photos…`);
  const classified = []; // { entry, file, label, exif }

  let clipDone = 0;
  for (const entry of images) {
    let file;
    try { file = await entry.handle.getFile(); } catch { clipDone++; continue; }

    const fileKey = makeFileKey(file);
    let label, score;

    const cached = await getCached(fileKey);
    if (cached) {
      ({ label, score } = cached);
    } else {
      // Skip CLIP for HEIC — classify as real (browser can't decode HEIC)
      if (entry.ext === '.heic') {
        label = 'real'; score = 1;
      } else {
        try {
          const res = await classifyImage(file);
          label = res.label; score = res.score;
        } catch {
          label = 'real'; score = 1; // fail-safe: treat as real photo
        }
      }
      await putCached(fileKey, label, score);
    }

    classified.push({ entry, file, label });
    clipDone++;
    onProgress({ stage: 'clip', done: clipDone, total: images.length });
  }

  const realPhotos = classified.filter(c => c.label === 'real');
  const otherPhotos = classified.filter(c => c.label === 'other');

  // ── Stage 2: EXIF metadata ────────────────────────────────────────────────
  onStatus(`Reading metadata for ${realPhotos.length} photos…`);
  const photoData = [];
  for (let i = 0; i < realPhotos.length; i++) {
    const { entry, file } = realPhotos[i];
    const exif = await readExif(file);
    photoData.push({ handle: entry.handle, file, relativePath: entry.relativePath, ...exif });
    onProgress({ stage: 'exif', done: i + 1, total: realPhotos.length });
  }

  // ── Stage 3: Session clustering ───────────────────────────────────────────
  onStatus('Grouping photos into sessions…');
  resetTripCounter();
  const sessions = clusterSessions(photoData);

  // ── Stage 4: Geocoding ────────────────────────────────────────────────────
  onStatus('Looking up locations…');
  const sessionsWithGps = sessions.filter(s => s.lat != null);
  for (let i = 0; i < sessions.length; i++) {
    const s = sessions[i];
    const { lat, lon } = sessionCentroid(s.photos);
    s.location = await reverseGeocode(lat, lon);
    onProgress({ stage: 'geo', done: i + 1, total: sessions.length });
  }

  // Auto-detect home city and its coordinates from geocoded sessions
  const homeCity = detectHomeCity(sessions);
  const { lat: homeLat, lon: homeLon } = detectHomeCentroid(sessions, homeCity);

  // ── Stage 5: CLIP content tags ────────────────────────────────────────────
  onStatus('Tagging session content…');
  const taggableSessions = sessions.filter(s => s.photoCount >= MIN_PHOTOS_FOR_LLM);
  for (let i = 0; i < taggableSessions.length; i++) {
    const s = taggableSessions[i];
    const imageFiles = s.photos
      .filter(p => !VIDEO_EXT.has(getExt(p.relativePath)))
      .map(p => p.file)
      .filter(Boolean);

    if (imageFiles.length > 0) {
      try {
        const res = await tagSession(s.id, imageFiles);
        s.content_tags = res.tags;
      } catch {
        s.content_tags = [];
      }
    }
    onProgress({ stage: 'tags', done: i + 1, total: taggableSessions.length });
  }

  // ── Stage 6: Group by year, call Gemini per year ──────────────────────────
  onStatus('Asking AI to name your events…');
  const byYear = groupByYear(sessions);
  const yearPlans = {}; // year → { tripNames, events, flatSessionIds }

  for (const [year, yearSessions] of Object.entries(byYear)) {
    const { trips, homeSessions } = detectTrips(yearSessions, homeCity, homeLat, homeLon);

    // Sessions with too few photos skip Gemini and go flat
    const llmHomeSessions = homeSessions.filter(s => s.photoCount >= MIN_PHOTOS_FOR_LLM);
    const smallSessions   = homeSessions.filter(s => s.photoCount < MIN_PHOTOS_FOR_LLM);

    try {
      const res = await fetch('/api/gemini/plan', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', ...getAuthHeaders() },
        body: JSON.stringify({ year, trips, homeSessions: llmHomeSessions }),
      });
      const plan = await res.json();
      yearPlans[year] = {
        tripNames:      plan.tripNames || {},
        events:         plan.events || [],
        flatSessionIds: [
          ...(plan.flatSessionIds || []),
          ...smallSessions.map(s => s.id),
        ],
        trips,
        homeSessions,
      };
    } catch {
      // Fallback: everything flat
      yearPlans[year] = {
        tripNames: {}, events: [],
        flatSessionIds: yearSessions.map(s => s.id),
        trips, homeSessions,
      };
    }
  }

  // ── Stage 7: Pre-read video file dates (needed for year fallback) ─────────
  const videoYears = new Map();
  for (const entry of videos) {
    try {
      const f = await entry.handle.getFile();
      videoYears.set(entry.handle.name, new Date(f.lastModified).getFullYear());
    } catch {}
  }

  // ── Stage 8: Assemble file move plan ──────────────────────────────────────
  onStatus('Assembling file plan…');
  return assemblePlan({
    yearPlans, sessions, otherPhotos, videos, byYear, videoYears
  });
}

// ── Plan assembly ─────────────────────────────────────────────────────────────

function assemblePlan({ yearPlans, sessions, otherPhotos, videos, byYear, videoYears }) {
  const plan = [];          // { handle, destPath, label }
  const sessionFolders = {}; // sessionId → destPath prefix (for tree preview)

  for (const [year, plan_] of Object.entries(yearPlans)) {
    const { tripNames, events, flatSessionIds, trips, homeSessions } = plan_;

    // Build event session ID sets
    const eventBySid = {}; // sessionId → folderName
    for (const ev of events) {
      for (const sid of ev.session_ids) eventBySid[sid] = ev.folder_name;
    }

    // Count how many trips share the same destination name within this year
    const destCount = new Map();
    for (const trip of trips) {
      const name = tripNames[trip.id];
      if (name) destCount.set(name, (destCount.get(name) || 0) + 1);
    }

    // Track which sessions were emitted by the trip loop to avoid duplicates below
    const emittedByTrip = new Set(trips.flatMap(trip => trip.sessions.map(s => s.id)));

    // Trip sessions
    for (const trip of trips) {
      const name = tripNames[trip.id];
      // Only add month prefix if the same destination appears more than once this year
      const folderName = name
        ? destCount.get(name) > 1
          ? `${year}-${trip.date_start.slice(5, 7)} ${name}`
          : name
        : null;

      for (const session of trip.sessions) {
        const prefix = folderName ? `${year}/${folderName}` : String(year);
        for (const photo of session.photos) {
          plan.push({ handle: photo.handle, destPath: `${prefix}/${photo.handle.name}`, folder: prefix });
        }
        if (folderName) sessionFolders[session.id] = prefix;
      }
    }

    // Count how many times each event name appears to decide on month prefix
    const eventNameCount = new Map();
    for (const ev of events) {
      eventNameCount.set(ev.folder_name, (eventNameCount.get(ev.folder_name) || 0) + 1);
    }

    // Home sessions — events or flat
    for (const session of homeSessions) {
      if (emittedByTrip.has(session.id)) continue;
      if (eventBySid[session.id]) {
        const evName = eventBySid[session.id];
        const mm = session.date.slice(5, 7);
        const folder = eventNameCount.get(evName) > 1
          ? `${year}/${year}-${mm} ${evName}`
          : `${year}/${evName}`;
        for (const photo of session.photos) {
          plan.push({ handle: photo.handle, destPath: `${folder}/${photo.handle.name}`, folder });
        }
        sessionFolders[session.id] = folder;
      } else {
        // Flat — directly under year
        for (const photo of session.photos) {
          plan.push({ handle: photo.handle, destPath: `${year}/${photo.handle.name}`, folder: String(year) });
        }
      }
    }
  }

  // Other (screenshots & documents) → YEAR/other/
  for (const { entry, file } of otherPhotos) {
    const year = yearFromFilename(entry.relativePath)
      ?? new Date(file.lastModified).getFullYear();
    plan.push({ handle: entry.handle, destPath: `${year}/other/${entry.handle.name}`, folder: `${year}/other` });
  }

  // Videos → YEAR/Videos/ (dates pre-read in buildPlan to avoid async here)
  for (const entry of videos) {
    const year = yearFromFilename(entry.relativePath)
      ?? videoYears.get(entry.handle.name)
      ?? new Date().getFullYear();
    plan.push({ handle: entry.handle, destPath: `${year}/Videos/${entry.handle.name}`, folder: `${year}/Videos` });
  }

  return plan;
}

// ── Helpers ───────────────────────────────────────────────────────────────────

function groupByYear(sessions) {
  const map = {};
  for (const s of sessions) {
    const year = s.startDate.getFullYear();
    (map[year] = map[year] || []).push(s);
  }
  return map;
}

function getExt(name) {
  const idx = name.lastIndexOf('.');
  return idx >= 0 ? name.slice(idx).toLowerCase() : '';
}

function yearFromFilename(path) {
  // Try to extract year from path segments; returns null if not found
  const match = path.match(/\b(20\d{2}|19\d{2})\b/);
  return match ? match[1] : null;
}

export function buildFolderTree(plan) {
  // Returns nested object { folderName: { subfolders: {...}, count: N } }
  const tree = {};
  for (const item of plan) {
    const parts = item.destPath.split('/');
    parts.pop(); // remove filename
    let node = tree;
    for (const part of parts) {
      node[part] = node[part] || { _count: 0 };
      node = node[part];
    }
    node._count = (node._count || 0) + 1;
  }
  return tree;
}
