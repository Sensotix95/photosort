require('dotenv').config({ path: require('path').join(__dirname, '../.env') });
const express = require('express');
const path = require('path');

const app = express();

// Stripe webhook needs raw body — mount before express.json()
app.use('/api/auth/webhook', express.raw({ type: 'application/json' }));
app.use(express.json({ limit: '10mb' }));

// Static frontend files
app.use(express.static(path.join(__dirname, '../public')));

// API routes
app.use('/api/auth',     require('./routes/auth'));
app.use('/api/gemini',   require('./routes/gemini'));
app.use('/api/download', require('./routes/download'));

app.get('/api/health', (_req, res) => res.json({ ok: true, version: '1.0.0' }));

// Route fallback: serve subdirectory index.html if it exists, else serve main index.html
app.get('*', (req, res) => {
  const fs = require('fs');
  const requestedPage = path.join(__dirname, '../public', req.path, 'index.html');
  if (fs.existsSync(requestedPage)) {
    res.sendFile(requestedPage);
  } else {
    res.sendFile(path.join(__dirname, '../public/index.html'));
  }
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`PhotoSort server running at http://localhost:${PORT}`);
  if (!process.env.GEMINI_API_KEY) console.warn('WARNING: GEMINI_API_KEY not set');
  if (!process.env.STRIPE_SECRET_KEY) console.warn('WARNING: STRIPE_SECRET_KEY not set');
});
