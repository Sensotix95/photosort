// Pipeline orchestrator — ties together CLIP, EXIF, sessions, geocoding, and Gemini.
// Returns a Plan: Array<{ handle, destPath }> ready for fileCopier.

import { makeFileKey, getCached, putCached, evictExpired } from './idbCache.js';
import { readExif } from './exifReader.js';
import { clusterSessions, detectTrips, detectHomeCity, detectHomeCentroid, resetTripCounter, MIN_PHOTOS_FOR_LLM } from './sessionBuilder.js';
import { reverseGeocode, sessionCentroid } from './geocoder.js';
import { getAuthHeaders } from './auth.js';

const VIDEO_EXT        = new Set(['.mp4', '.mov', '.avi', '.mkv', '.m4v']);
const VIDEO_BUFFER_DAYS = 1; // match videos to events within ±this many days

// Safety-net timeout: if any single async operation hangs (IDB, file read, worker
// inference), this ensures it fails fast rather than blocking the pipeline forever.
function withTimeout(promise, ms) {
  let id;
  return Promise.race([
    promise,
    new Promise((_, reject) => { id = setTimeout(() => reject(new Error('timeout')), ms); }),
  ]).finally(() => clearTimeout(id));
}

// ── CLIP Worker Pool ──────────────────────────────────────────────────────────
// Runs WORKER_COUNT parallel workers, each recycled every RECYCLE_AFTER images
// to prevent memory from accumulating and crashing the worker.

const WORKER_COUNT  = Math.min(Math.max(navigator.hardwareConcurrency || 2, 2), 4);
const RECYCLE_AFTER = 100;

class ClipWorkerPool {
  constructor() {
    this._slots      = [];  // [{ worker, pending, msgId, imageCount, recycling, recyclePromise }]
    this._queue      = [];  // [{ file, resolve, reject }]
    this._progressCb = null;
  }

  async init(onProgress) {
    this._progressCb = onProgress;
    await Promise.all(
      Array.from({ length: WORKER_COUNT }, (_, i) => this._spawnSlot(i))
    );
  }

  _spawnSlot(idx) {
    const slot = { idx, worker: null, pending: new Map(), msgId: 0, imageCount: 0, recycling: false, recyclePromise: null };
    this._slots[idx] = slot;
    return this._bootWorker(slot);
  }

  _bootWorker(slot) {
    return new Promise((resolve, reject) => {
      if (slot.worker) { try { slot.worker.terminate(); } catch {} }
      const w         = new Worker('/js/workers/clipWorker.js', { type: 'module' });
      slot.worker     = w;
      slot.pending    = new Map();
      slot.imageCount = 0;

      w.onmessage = ({ data }) => {
        if (data.type === 'READY')    { resolve(); return; }
        if (data.type === 'PROGRESS') { if (slot.idx === 0) this._progressCb?.(data); return; }
        if (data.type === 'ERROR') {
          const p = slot.pending.get(data.id);
          if (p) { slot.pending.delete(data.id); p.reject(new Error(data.message)); }
          this._drain();
          return;
        }
        const key = data.id ?? data.sessionId;
        const p   = slot.pending.get(key);
        if (p) { slot.pending.delete(key); p.resolve(data); }
      };

      w.onerror = e => {
        const err = new Error(e.message || 'Worker crashed');
        for (const [, p] of slot.pending) { if (p?.reject) p.reject(err); }
        slot.pending.clear();
        reject(err); // no-op if already resolved
        // Auto-restart
        slot.recycling = true;
        slot.recyclePromise = this._bootWorker(slot).finally(() => {
          slot.recycling      = false;
          slot.recyclePromise = null;
          this._drain();
        });
      };

      w.postMessage({ type: 'INIT' });
    });
  }

  classify(file) {
    return new Promise((resolve, reject) => {
      this._queue.push({ file, resolve, reject });
      this._drain();
    });
  }

  _drain() {
    for (const slot of this._slots) {
      if (!this._queue.length) break;
      if (slot.pending.size > 0 || slot.recycling) continue;
      this._dispatch(slot, this._queue.shift());
    }
  }

  async _dispatch(slot, { file, resolve, reject }) {
    const id = String(++slot.msgId);

    // Reserve the slot synchronously before the first await so _drain skips it.
    // Also store reject immediately so a crash during arrayBuffer() can still fail the task.
    let settled = false;
    slot.pending.set(id, {
      resolve: () => {},
      reject:  err => { if (!settled) { settled = true; reject(err); } },
    });

    let buf;
    try {
      buf = await file.arrayBuffer();
    } catch (err) {
      slot.pending.delete(id);
      if (!settled) { settled = true; reject(err); }
      this._drain();
      return;
    }

    if (settled) {
      // Worker crashed while the file was being read; reject was already called by onerror.
      this._drain();
      return;
    }

    // If the worker hangs on this image (no crash, just stuck inference),
    // recycle it after 20s so the pool slot doesn't stay occupied forever.
    const timeoutId = setTimeout(() => {
      if (!slot.pending.has(id)) return;
      slot.pending.delete(id);
      if (!settled) { settled = true; reject(new Error('classify timeout')); }
      if (!slot.recycling) {
        slot.recycling      = true;
        slot.recyclePromise = this._bootWorker(slot).finally(() => {
          slot.recycling      = false;
          slot.recyclePromise = null;
          this._drain();
        });
      }
    }, 20_000);

    // Upgrade to full callbacks now that we have the buffer.
    slot.pending.set(id, {
      resolve: data => {
        clearTimeout(timeoutId);
        if (!settled) { settled = true; resolve(data); }
        this._afterClassify(slot);
      },
      reject: err => {
        clearTimeout(timeoutId);
        if (!settled) { settled = true; reject(err); }
        this._drain();
      },
    });
    slot.worker.postMessage(
      { type: 'CLASSIFY', id, buffer: buf, mimeType: file.type || 'image/jpeg' },
      [buf]
    );
  }

  _afterClassify(slot) {
    slot.imageCount++;
    if (slot.imageCount >= RECYCLE_AFTER) {
      // Proactively restart to free accumulated memory before it can crash.
      slot.recycling      = true;
      slot.recyclePromise = this._bootWorker(slot).finally(() => {
        slot.recycling      = false;
        slot.recyclePromise = null;
        this._drain();
      });
    } else {
      this._drain();
    }
  }

  // Wait for any in-progress recycles before using slots for tagSession.
  awaitRecycles() {
    return Promise.all(this._slots.map(s => s.recyclePromise ?? Promise.resolve()));
  }

  async tagSession(sessionId, files) {
    await this.awaitRecycles();
    const slot = this._slots.find(s => !s.recycling && s.pending.size === 0) ?? this._slots[0];
    const buffers   = [];
    const mimeTypes = [];
    for (const f of files) {
      buffers.push(await f.arrayBuffer());
      mimeTypes.push(f.type || 'image/jpeg');
    }
    return new Promise((resolve, reject) => {
      slot.pending.set(sessionId, { resolve, reject });
      slot.worker.postMessage(
        { type: 'TAG_SESSION', sessionId, buffers, mimeTypes },
        buffers
      );
    });
  }
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
  const pool = new ClipWorkerPool();
  await pool.init(info => {
    if (info.total) onProgress({ stage: 'model', done: info.loaded, total: info.total });
  });

  onStatus(`Classifying ${images.length} photos…`);
  const classified = []; // { entry, file, label }

  // Limit outer concurrency to avoid overwhelming IndexedDB with thousands of
  // simultaneous transactions. Workers still run WORKER_COUNT tasks in parallel;
  // this just caps how many tasks are in-flight at once in the surrounding IDB layer.
  const OUTER_CONCURRENCY = WORKER_COUNT * 4;
  let inFlight = 0;
  const waitQueue = [];
  const acquire = () => {
    if (inFlight < OUTER_CONCURRENCY) { inFlight++; return Promise.resolve(); }
    return new Promise(r => waitQueue.push(r));
  };
  const release = () => {
    inFlight--;
    if (waitQueue.length) { inFlight++; waitQueue.shift()(); }
  };

  let clipDone = 0;
  await Promise.all(images.map(async (entry) => {
    await acquire();
    try {
      await withTimeout((async () => {
        let file;
        try { file = await entry.handle.getFile(); } catch {
          classified.push({ entry, file: null, label: 'real' });
          return;
        }

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
              const res = await pool.classify(file);
              label = res.label; score = res.score;
            } catch {
              label = 'real'; score = 1; // fail-safe: treat as real photo
            }
          }
          await putCached(fileKey, label, score);
        }

        classified.push({ entry, file, label });
      })(), 30_000);
    } catch {
      // Covers thrown errors AND the 30s timeout — treat as real and continue.
      classified.push({ entry, file: null, label: 'real' });
    } finally {
      clipDone++;
      onProgress({ stage: 'clip', done: clipDone, total: images.length });
      release();
    }
  }));

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
        const res = await pool.tagSession(s.id, imageFiles);
        s.content_tags = res.tags;
      } catch {
        s.content_tags = [];
      }
    }
    onProgress({ stage: 'tags', done: i + 1, total: taggableSessions.length });
  }

  // ── Stage 6: Group by year, call Gemini per year ──────────────────────────

  // Determine Gemini mode once, before the loop:
  // - Web: always call the server (server uses its env key)
  // - Desktop + user key: call the server with X-Gemini-Key header
  // - Desktop + no key: skip Gemini, use local date/location fallback
  const isElectron = !!window.electronAPI;
  const geminiKey  = isElectron ? await window.electronAPI.getGeminiKey() : null;
  const useGemini  = !isElectron || !!geminiKey;

  onStatus(useGemini ? 'Asking AI to name your events…' : 'Naming folders by date and location…');

  const byYear = groupByYear(sessions);
  const yearPlans = {}; // year → { tripNames, events, flatSessionIds }

  for (const [year, yearSessions] of Object.entries(byYear)) {
    const { trips, homeSessions } = detectTrips(yearSessions, homeCity, homeLat, homeLon);

    // Sessions with too few photos skip Gemini and go flat
    const llmHomeSessions = homeSessions.filter(s => s.photoCount >= MIN_PHOTOS_FOR_LLM);
    const smallSessions   = homeSessions.filter(s => s.photoCount < MIN_PHOTOS_FOR_LLM);

    if (!useGemini) {
      yearPlans[year] = localFallbackPlan(trips, homeSessions, smallSessions);
      continue;
    }

    try {
      const headers = { 'Content-Type': 'application/json', ...getAuthHeaders() };
      if (geminiKey) headers['X-Gemini-Key'] = geminiKey;

      const res = await fetch('/api/gemini/plan', {
        method: 'POST',
        headers,
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
      // Network/parse error — fall back to local naming
      yearPlans[year] = localFallbackPlan(trips, homeSessions, smallSessions);
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

// ── Local fallback naming (no Gemini key) ─────────────────────────────────────
// Uses geocoded location names + dates instead of AI event naming.
// Home sessions are grouped by city. Within each city:
//   ≥ 5 photos → {year}/{city}/{year}-{mmdd}/   (date subfolder)
//   < 5 photos → {year}/{city}/                  (flat inside city folder)

const LOCAL_EVENT_THRESHOLD = 5;

function localFallbackPlan(trips, homeSessions /*, smallSessions — unused here */) {
  // Name trips by their primary location, or generic "Trip" if no GPS
  const tripNames = {};
  for (const t of trips) {
    const loc = (t.locations && t.locations[0]) || t.location || 'Trip';
    tripNames[t.id] = loc.split(',')[0].trim(); // "Rome, Italy" → "Rome"
  }

  // Group home sessions by city name
  const byLocation = {}; // city → [session]
  const noLocationIds = [];

  for (const s of homeSessions) {
    if (!s.location) { noLocationIds.push(s.id); continue; }
    const city = s.location.split(',')[0].trim();
    (byLocation[city] = byLocation[city] || []).push(s);
  }

  // Build locationGroups: big sessions get a date subfolder, small ones go flat
  const locationGroups = Object.entries(byLocation).map(([name, sessions]) => ({
    name,
    bigSessions:  sessions.filter(s => s.photoCount >= LOCAL_EVENT_THRESHOLD),
    flatSessions: sessions.filter(s => s.photoCount <  LOCAL_EVENT_THRESHOLD),
  }));

  // Sessions without any GPS location fall flat under the year folder
  const flatSessionIds = noLocationIds;

  return { tripNames, events: [], flatSessionIds, trips, homeSessions, locationGroups };
}

// ── Plan assembly ─────────────────────────────────────────────────────────────

function assemblePlan({ yearPlans, sessions, otherPhotos, videos, byYear, videoYears }) {
  const plan = [];          // { handle, destPath, label }
  const sessionFolders = {}; // sessionId → destPath prefix (for tree preview)

  for (const [year, plan_] of Object.entries(yearPlans)) {
    const { tripNames, events, flatSessionIds, trips, homeSessions, locationGroups } = plan_;

    // Build event session ID sets (Gemini path)
    const eventBySid = {}; // sessionId → folderName
    for (const ev of events) {
      for (const sid of ev.session_ids) eventBySid[sid] = ev.folder_name;
    }

    // Track which sessions were emitted by the trip loop to avoid duplicates below
    const emittedByTrip = new Set(trips.flatMap(trip => trip.sessions.map(s => s.id)));

    // Trip sessions
    for (const trip of trips) {
      const name = tripNames[trip.id];
      // Always prefix with start date so trips sort chronologically within the year folder
      const folderName = name
        ? `${year}-${trip.date_start.slice(5, 10)} ${name}`
        : null;

      for (const session of trip.sessions) {
        const prefix = folderName ? `${year}/${folderName}` : String(year);
        for (const photo of session.photos) {
          plan.push({ handle: photo.handle, destPath: `${prefix}/${photo.handle.name}`, folder: prefix });
        }
        if (folderName) sessionFolders[session.id] = prefix;
      }
    }

    if (locationGroups && locationGroups.length > 0) {
      // ── Local fallback path: city-bucketed structure ──────────────────────
      // Build a set of all session IDs handled by locationGroups
      const locationHandled = new Set(
        locationGroups.flatMap(g => [...g.bigSessions, ...g.flatSessions].map(s => s.id))
      );

      for (const group of locationGroups) {
        const cityFolder = `${year}/${group.name}`;

        // Big sessions (≥ threshold) → date subfolder inside city
        for (const session of group.bigSessions) {
          if (emittedByTrip.has(session.id)) continue;
          const mmdd = session.date.slice(5, 10);
          const folder = `${cityFolder}/${year}-${mmdd}`;
          for (const photo of session.photos) {
            plan.push({ handle: photo.handle, destPath: `${folder}/${photo.handle.name}`, folder });
          }
          sessionFolders[session.id] = folder;
        }

        // Small sessions (< threshold) → flat inside city folder
        for (const session of group.flatSessions) {
          if (emittedByTrip.has(session.id)) continue;
          for (const photo of session.photos) {
            plan.push({ handle: photo.handle, destPath: `${cityFolder}/${photo.handle.name}`, folder: cityFolder });
          }
        }
      }

      // Sessions with no GPS location go flat under the year folder
      for (const session of homeSessions) {
        if (emittedByTrip.has(session.id)) continue;
        if (locationHandled.has(session.id)) continue;
        for (const photo of session.photos) {
          plan.push({ handle: photo.handle, destPath: `${year}/${photo.handle.name}`, folder: String(year) });
        }
      }

    } else {
      // ── Gemini path: named events or flat ────────────────────────────────
      for (const session of homeSessions) {
        if (emittedByTrip.has(session.id)) continue;
        if (eventBySid[session.id]) {
          const evName = eventBySid[session.id];
          const mmdd = session.date.slice(5, 10);
          const folder = `${year}/${year}-${mmdd} ${evName}`;
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
