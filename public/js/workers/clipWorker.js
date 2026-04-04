// CLIP Web Worker
// Runs in a background thread. Loads the CLIP model via Transformers.js,
// pre-encodes all text prompts once, then classifies images on demand.
//
// Message protocol:
//   IN  { type: 'CLASSIFY',     id, buffer: ArrayBuffer, mimeType }
//   IN  { type: 'TAG_SESSION',  sessionId, buffers: ArrayBuffer[], mimeTypes: [] }
//   OUT { type: 'READY' }
//   OUT { type: 'PROGRESS',     loaded, total }
//   OUT { type: 'CLASSIFY_RESULT', id, label: 'real'|'other', score }
//   OUT { type: 'TAG_RESULT',   sessionId, tags: string[] }
//   OUT { type: 'ERROR',        message }

import { pipeline, env } from 'https://cdn.jsdelivr.net/npm/@xenova/transformers@2.17.2/dist/transformers.min.js';

env.allowLocalModels = false;

// ── CLIP prompts — exact match to Python photo_sorter.py ──────────────────────

const TRASH_PROMPTS = {
  'Real Photo': [
    'a personal photograph of people outdoors',
    'a travel or vacation photo',
    'a portrait or selfie taken by a person',
    'a candid photo of friends or family',
    'a landscape or nature photograph',
    'a food photo at a restaurant',
    'a street photography or travel photo',
    'a photo taken at a concert or festival with a large LED stage screen',
    'a speaker presenting on stage at a conference or event',
    'a keynote or presentation with a projection screen in the background',
    'people sitting in an audience watching a presentation or talk',
  ],
  'Screenshots & Documents': [
    'a screenshot of a computer desktop or phone screen',
    'a screen capture showing app icons or interface elements',
    'a screenshot of a chat conversation or social media feed',
    'a screenshot of a website or web browser',
    'a photo of a paper receipt or invoice from a store',
    'a photo of a printed document, letter, or contract',
    'a photo of an ID card, passport, or official government form',
    'a photo of handwritten notes or a piece of paper with writing',
    'a photo of a bill or financial document',
  ],
};

// Maps label string → category name for grouping scores
const TRASH_LABEL_TO_CAT = {};
const TRASH_ALL_LABELS = [];
for (const [cat, prompts] of Object.entries(TRASH_PROMPTS)) {
  for (const p of prompts) {
    TRASH_LABEL_TO_CAT[p] = cat;
    TRASH_ALL_LABELS.push(p);
  }
}

const CONTENT_LABELS = [
  { tag: 'pets',                 label: 'a photo of a cat or dog' },
  { tag: 'selfie or portrait',   label: 'a selfie or close-up portrait of a person' },
  { tag: 'food and dining',      label: 'food or a meal at a restaurant' },
  { tag: 'nightlife and bars',   label: 'people at a bar or nightclub at night' },
  { tag: 'concert or live show', label: 'a concert or live music show on stage' },
  { tag: 'nature and hiking',    label: 'people hiking or a mountain landscape' },
  { tag: 'beach and sea',        label: 'people at a beach with sand and sea' },
  { tag: 'skiing and winter sports', label: 'skiing or snowboarding on a snowy slope' },
  { tag: 'city sightseeing',     label: 'tourists visiting a landmark or historic city' },
  { tag: 'party and celebration',label: 'a birthday party or celebration gathering' },
  { tag: 'wedding',              label: 'a wedding ceremony with bride and groom' },
  { tag: 'shopping or errands',  label: 'person shopping in a store or retail environment' },
  { tag: 'home and indoor',      label: 'a casual photo taken inside a house or apartment' },
  { tag: 'airport or transport', label: 'at an airport, train station, or inside a plane' },
  { tag: 'sports and exercise',  label: 'people doing sports, running, or working out' },
];

const CONTENT_TAG_LABELS = CONTENT_LABELS.map(c => c.label);
const CONTENT_LABEL_TO_TAG = Object.fromEntries(CONTENT_LABELS.map(c => [c.label, c.tag]));

// Thresholds
const TRASH_MARGIN = 0.20;       // trash score must beat real-photo score by this (softmax-adjusted)
const CONTENT_THRESHOLD = 0.19;  // min softmax score to include a content tag (adjusted for 15 labels)
const CONTENT_SAMPLES = 5;       // images sampled per session for content tags

// ── Model ─────────────────────────────────────────────────────────────────────

let clf = null;

async function loadModel() {
  if (clf) return;
  clf = await pipeline('zero-shot-image-classification', 'Xenova/clip-vit-base-patch32', {
    progress_callback: (info) => {
      if (info.status === 'progress') {
        self.postMessage({ type: 'PROGRESS', loaded: info.loaded, total: info.total });
      }
    },
  });
}

// ── Helpers ───────────────────────────────────────────────────────────────────

function bufferToBlobUrl(buffer, mimeType) {
  const blob = new Blob([buffer], { type: mimeType || 'image/jpeg' });
  return URL.createObjectURL(blob);
}

async function classifyTrash(blobUrl) {
  // Run zero-shot classification against all individual prompts
  const results = await clf(blobUrl, TRASH_ALL_LABELS);

  // Group scores by category, take the max per category
  const catScores = { 'Real Photo': 0, 'Screenshots & Documents': 0 };
  for (const { label, score } of results) {
    const cat = TRASH_LABEL_TO_CAT[label];
    if (score > catScores[cat]) catScores[cat] = score;
  }

  const realScore  = catScores['Real Photo'];
  const trashScore = catScores['Screenshots & Documents'];
  const margin     = trashScore - realScore;

  // Clearly real or clearly trash
  if (margin <= TRASH_MARGIN)  return { label: 'real',  score: realScore };
  if (margin >= 0.35)          return { label: 'other', score: trashScore };

  // Ambiguous zone (0.20–0.35): run a focused second pass to disambiguate
  const secondary = await clf(blobUrl, [
    'a screenshot of a phone or computer screen',
    'a photo taken at an event, concert, conference, or gathering',
  ]);
  const isTrash = secondary[0].score > secondary[1].score;
  return { label: isTrash ? 'other' : 'real', score: isTrash ? trashScore : realScore };
}

async function tagContent(blobUrl) {
  const results = await clf(blobUrl, CONTENT_TAG_LABELS);
  // results is sorted descending by score
  return results
    .filter(r => r.score >= CONTENT_THRESHOLD)
    .slice(0, 4)
    .map(r => CONTENT_LABEL_TO_TAG[r.label]);
}

// ── Message handler ───────────────────────────────────────────────────────────

self.onmessage = async ({ data }) => {
  try {
    if (data.type === 'INIT') {
      await loadModel();
      self.postMessage({ type: 'READY' });
      return;
    }

    if (!clf) await loadModel();

    if (data.type === 'CLASSIFY') {
      const { id, buffer, mimeType } = data;
      const url = bufferToBlobUrl(buffer, mimeType);
      try {
        const result = await classifyTrash(url);
        self.postMessage({ type: 'CLASSIFY_RESULT', id, ...result });
      } finally {
        URL.revokeObjectURL(url);
      }
      return;
    }

    if (data.type === 'TAG_SESSION') {
      const { sessionId, buffers, mimeTypes } = data;
      // Sample up to CONTENT_SAMPLES images
      const indices = Array.from({ length: buffers.length }, (_, i) => i);
      if (indices.length > CONTENT_SAMPLES) {
        indices.sort(() => Math.random() - 0.5);
        indices.length = CONTENT_SAMPLES;
      }

      const tagCounts = {};
      for (const i of indices) {
        const url = bufferToBlobUrl(buffers[i], mimeTypes?.[i]);
        try {
          const tags = await tagContent(url);
          for (const tag of tags) tagCounts[tag] = (tagCounts[tag] || 0) + 1;
        } finally {
          URL.revokeObjectURL(url);
        }
      }

      // Return tags that appeared in ≥1 sample, sorted by frequency
      const tags = Object.entries(tagCounts)
        .sort((a, b) => b[1] - a[1])
        .slice(0, 4)
        .map(([tag]) => tag);

      self.postMessage({ type: 'TAG_RESULT', sessionId, tags });
      return;
    }
  } catch (err) {
    self.postMessage({ type: 'ERROR', message: err.message });
  }
};
