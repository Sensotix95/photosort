const router = require('express').Router();
const { GoogleGenerativeAI } = require('@google/generative-ai');
const { TRIP_NAME_PROMPT, HOME_EVENTS_PROMPT } = require('../utils/prompts');

// Per-IP rate limiting: max 20 Gemini calls per hour (preview is free, but limit abuse)
const callLog = new Map(); // ip → [timestamp, ...]
const RATE_LIMIT = 20;
const RATE_WINDOW_MS = 3_600_000;

function checkRateLimit(ip) {
  const now = Date.now();
  const window = now - RATE_WINDOW_MS;
  const calls = (callLog.get(ip) || []).filter(t => t > window);
  if (calls.length >= RATE_LIMIT) return false;
  calls.push(now);
  callLog.set(ip, calls);
  return true;
}

const genAI = new GoogleGenerativeAI(process.env.GEMINI_API_KEY);

async function callGemini(prompt) {
  const model = genAI.getGenerativeModel({
    model: 'gemini-2.5-flash',
    generationConfig: { responseMimeType: 'application/json', temperature: 0.1 },
  });
  const result = await model.generateContent(prompt);
  const raw = result.response.text().trim().replace(/^```(?:json)?\n?/, '').replace(/\n?```$/, '');
  return JSON.parse(raw);
}

// POST /api/gemini/plan
// Body: { year, trips: [...], homeSessions: [...] }
// Returns: { tripNames: { id: folderName }, events: [...], flatSessionIds: [...] }
router.post('/plan', async (req, res) => {
  const { year, trips = [], homeSessions = [] } = req.body;
  if (!year) return res.status(400).json({ error: 'Missing year' });

  const ip = req.ip || req.connection?.remoteAddress || 'unknown';
  if (!checkRateLimit(ip)) {
    return res.status(429).json({ error: 'Rate limit exceeded', retryAfter: 3600 });
  }

  const output = { tripNames: {}, events: [], flatSessionIds: [] };

  try {
    // ── 1. Name trips ──────────────────────────────────────────────────────────
    if (trips.length > 0) {
      const tripsCompact = trips.map(t => {
        const locs = t.locations?.join(', ') || t.location || '—';
        const tags = t.content_tags?.join(', ') || '—';
        return `${t.id}: ${t.date_start}..${t.date_end}, ${t.photo_count}p, ${locs}, [${tags}]`;
      }).join('\n');

      const tripPrompt = TRIP_NAME_PROMPT
        .replace('{year}', year)
        .replace('{trips_compact}', tripsCompact);

      const tripResult = await callGemini(tripPrompt);
      for (const item of tripResult.trips || []) {
        output.tripNames[item.id] = item.folder_name;
      }
    }

    // ── 2. Detect home events ──────────────────────────────────────────────────
    if (homeSessions.length > 0) {
      const sessionsCompact = homeSessions.map(s => {
        const tags = s.content_tags?.join(',') || '—';
        return `${s.id},${s.date},${s.photo_count}p,${tags}`;
      }).join('\n');

      const homePrompt = HOME_EVENTS_PROMPT
        .replace('{year}', year)
        .replace('{sessions_compact}', sessionsCompact);

      const homeResult = await callGemini(homePrompt);
      output.events = homeResult.events || [];
      output.flatSessionIds = homeResult.flat_session_ids || [];
    }

    res.json(output);
  } catch (err) {
    console.error('Gemini plan error:', err.message);
    // Graceful fallback: all sessions go flat
    output.flatSessionIds = [
      ...trips.map(t => t.id),
      ...homeSessions.map(s => s.id),
    ];
    res.json({ ...output, fallback: true });
  }
});

module.exports = router;
