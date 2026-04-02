const router = require('express').Router();
const jwt = require('jsonwebtoken');
const { GoogleGenerativeAI } = require('@google/generative-ai');
const { TRIP_NAME_PROMPT, HOME_EVENTS_PROMPT } = require('../utils/prompts');

// Simple per-customer rate limiting: max 20 Gemini calls per hour
const callLog = new Map(); // customerId → [timestamp, ...]
const RATE_LIMIT = 20;
const RATE_WINDOW_MS = 3_600_000;

function checkRateLimit(customerId) {
  const now = Date.now();
  const window = now - RATE_WINDOW_MS;
  const calls = (callLog.get(customerId) || []).filter(t => t > window);
  if (calls.length >= RATE_LIMIT) return false;
  calls.push(now);
  callLog.set(customerId, calls);
  return true;
}

function requireAuth(req, res, next) {
  const auth = req.headers.authorization;
  if (!auth?.startsWith('Bearer ')) return res.status(401).json({ error: 'Unauthorized' });
  try {
    const payload = jwt.verify(auth.slice(7), process.env.JWT_SECRET);
    if (!payload.paid) return res.status(401).json({ error: 'Unauthorized' });
    req.user = payload;
    next();
  } catch {
    res.status(401).json({ error: 'Unauthorized' });
  }
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
router.post('/plan', requireAuth, async (req, res) => {
  const { year, trips = [], homeSessions = [] } = req.body;
  if (!year) return res.status(400).json({ error: 'Missing year' });

  const customerId = req.user.customerId || req.user.email || 'anonymous';
  if (!checkRateLimit(customerId)) {
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
