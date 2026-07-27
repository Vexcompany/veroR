const express = require('express');
const app     = express();

if (process.env.NODE_ENV !== 'production') {
  try { require('dotenv').config(); } catch (_) {}
}

// ── CORS ─────────────────────────────────────────────────────────
const ALLOWED = (process.env.ALLOWED_ORIGINS || '')
  .split(',').map((s) => s.trim()).filter(Boolean);

app.use((req, res, next) => {
  const origin = req.headers.origin;
  if (!ALLOWED.length) {
    res.setHeader('Access-Control-Allow-Origin', '*');
  } else if (origin && ALLOWED.includes(origin)) {
    res.setHeader('Access-Control-Allow-Origin', origin);
    res.setHeader('Vary', 'Origin');
  }
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, HEAD, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Range');
  res.setHeader('Access-Control-Expose-Headers', 'Content-Length, Content-Range, Accept-Ranges');
  if (req.method === 'OPTIONS') return res.status(204).end();
  next();
});

app.use(express.json({ limit: '1mb' }));
app.use(express.urlencoded({ extended: true }));

// ── Routes ───────────────────────────────────────────────────────
// Semua route: /api/search, /api/home, /api/stream, /api/audio, /api/related
app.use('/api', require('../routes/stream'));

app.get('/', (_, res) => res.json({
  service: 'veroR',
  storage: '0 byte',
  endpoints: [
    'GET  /api/search?q=',
    'GET  /api/suggest?q=',
    'GET  /api/status',
    'GET  /api/stream?id=VIDEO_ID',
    'POST /api/stream  { videoId } atau { title, artist }',
    'GET  /api/audio/:videoId',
    'GET  /api/related/:videoId',
  ],
}));

app.use((req, res) => res.status(404).json({ ok: false, message: 'Tidak ditemukan' }));
app.use((err, req, res, _next) => res.status(500).json({ ok: false, message: err.message }));

module.exports = app;

if (!process.env.VERCEL && require.main === module) {
  const PORT = process.env.PORT || 3001;
  app.listen(PORT, () => console.log(`veroR running → http://localhost:${PORT}`));
}
