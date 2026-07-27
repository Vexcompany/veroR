// controllers/streamController.js
const yt = require('../lib/ytStream');

const LOCALE = { hl: process.env.YT_HL || 'id', gl: process.env.YT_GL || 'ID' };
const CHUNK  = 1024 * 1024; // 1 MB

const isId = (v) => /^[A-Za-z0-9_-]{11}$/.test(v || '');

function base(req) {
  const proto = req.headers['x-forwarded-proto'] || 'https';
  const host  = req.headers['x-forwarded-host'] || req.headers.host;
  return `${proto}://${host}`;
}

/* GET /api/search?q= */
exports.search = async (req, res) => {
  const q = (req.query.q || '').trim();
  if (!q) return res.status(400).json({ ok: false, message: 'q diperlukan' });
  try {
    const items = await yt.searchSongs(q, LOCALE);
    res.setHeader('Cache-Control', 'public, max-age=300, s-maxage=3600');
    return res.json({
      ok: true, total: items.length,
      result: items.map((i) => ({
        videoId:     i.videoId,
        title:       i.title,
        artist:      i.artist,
        thumbnail:   i.thumbnail,
        duration:    yt.formatDuration(i.duration),
        durationSec: i.duration,
      })),
    });
  } catch (e) {
    return res.status(502).json({ ok: false, message: e.message });
  }
};

/* GET /api/suggest?q= */
exports.suggest = async (req, res) => {
  const q = (req.query.q || '').trim();
  if (!q) return res.json({ ok: true, result: [] });
  try {
    const items = await yt.searchSongs(q, LOCALE);
    res.setHeader('Cache-Control', 'public, max-age=600');
    return res.json({
      ok: true,
      result: [...new Set(items.slice(0, 6).map((i) => `${i.title} — ${i.artist}`))],
    });
  } catch {
    return res.json({ ok: true, result: [] });
  }
};

/* GET|POST /api/stream?id= atau body {videoId, title, artist} */
exports.resolve = async (req, res) => {
  const body = req.method === 'POST' ? req.body : req.query;
  const { title, artist, duration, thumbnail } = body;
  const rawId = body.id || body.videoId;

  try {
    let videoId = null;
    let meta    = null;

    if (isId(rawId)) {
      videoId = rawId;
    } else if (title) {
      meta    = await yt.matchAppleToYouTube({ title, artist, duration }, LOCALE);
      videoId = meta?.videoId || null;
    }

    if (!videoId) {
      return res.status(404).json({ ok: false, message: 'Lagu tidak ditemukan' });
    }

    const s  = await yt.resolveStream(videoId, { locale: LOCALE });
    const B  = base(req);

    return res.json({
      ok: true,
      result: {
        videoId,
        title:       title       || meta?.title  || s.title  || 'Unknown',
        artist:      artist      || meta?.artist || s.artist || 'Unknown',
        thumbnail:   thumbnail   || meta?.thumbnail || s.thumbnail || null,
        duration:    duration    || yt.formatDuration(meta?.duration || s.durationSec),
        durationSec: s.durationSec,
        directUrl:   s.url,                          // CDN Google, ~6 jam
        proxyUrl:    `${B}/api/audio/${videoId}`,    // fallback proxy
        expiresAt:   s.expiresAt,
      },
    });
  } catch (e) {
    return res.status(502).json({ ok: false, message: e.message });
  }
};

/* GET /api/audio/:videoId — proxy + Range */
exports.audio = async (req, res) => {
  const { videoId } = req.params;
  if (!isId(videoId)) return res.status(400).json({ ok: false, message: 'videoId tidak valid' });

  const isHead = req.method === 'HEAD';
  try {
    let s = await yt.resolveStream(videoId, { locale: LOCALE });

    const clientRange = req.headers.range;
    const rm = clientRange ? /^bytes=(\d+)-(\d*)/.exec(clientRange) : null;
    const start = rm ? Number(rm[1]) : 0;
    const explicitEnd = rm && rm[2] ? Number(rm[2]) : null;
    const total = s.contentLength || null;

    if (isHead) {
      const probe = await fetch(s.url, { method: 'GET', headers: { range: 'bytes=0-0' } });
      const size = total || Number((probe.headers.get('content-range') || '').split('/')[1]) || null;
      try { probe.body?.cancel?.(); } catch (_) {}
      res.setHeader('Accept-Ranges', 'bytes');
      res.setHeader('Content-Type', (s.mimeType || 'audio/webm').split(';')[0]);
      if (size) res.setHeader('Content-Length', String(size));
      return res.status(200).end();
    }

    const last = explicitEnd !== null ? explicitEnd : (total ? total - 1 : null);
    res.setHeader('Accept-Ranges', 'bytes');
    res.setHeader('Cache-Control', 'public, max-age=3600');
    res.setHeader('Content-Type', (s.mimeType || 'audio/webm').split(';')[0]);

    if (clientRange && total) {
      res.setHeader('Content-Range', `bytes ${start}-${last}/${total}`);
      res.setHeader('Content-Length', String(last - start + 1));
      res.status(206);
    } else {
      if (total) res.setHeader('Content-Length', String(total));
      res.status(200);
    }

    let aborted = false;
    req.on('close', () => { aborted = true; });
    let cursor = start, refreshed = false;

    while (!aborted && (last === null || cursor <= last)) {
      const end = last === null ? cursor + CHUNK - 1 : Math.min(cursor + CHUNK - 1, last);
      let up = await fetch(s.url, { headers: { range: `bytes=${cursor}-${end}` } });

      if ((up.status === 403 || up.status === 410) && !refreshed) {
        refreshed = true;
        s  = await yt.resolveStream(videoId, { locale: LOCALE, force: true });
        up = await fetch(s.url, { headers: { range: `bytes=${cursor}-${end}` } });
      }

      if (!up.ok && up.status !== 206) {
        if (!res.headersSent) res.status(409).json({ ok: false, code: 'UPSTREAM_RESTRICTED', directUrl: s.url });
        break;
      }

      const buf = Buffer.from(await up.arrayBuffer());
      if (!buf.length) break;
      if (!res.write(buf)) await new Promise((r) => res.once('drain', r));
      cursor += buf.length;
      if (last === null && buf.length < CHUNK) break;
    }
    return res.end();

  } catch (e) {
    if (!res.headersSent) return res.status(404).json({ ok: false, message: e.message });
    return res.end();
  }
};

/* GET /api/related/:videoId */
exports.related = async (req, res) => {
  try {
    const items = await yt.getRelated(req.params.videoId, LOCALE);
    res.setHeader('Cache-Control', 'public, max-age=1800');
    return res.json({
      ok: true, total: items.length,
      result: items.map((i) => ({
        videoId:   i.videoId,
        title:     i.title,
        artist:    i.artist,
        thumbnail: i.thumbnail,
        duration:  yt.formatDuration(i.duration),
      })),
    });
  } catch (e) {
    return res.status(502).json({ ok: false, message: e.message });
  }
};

/* GET /api/status */
exports.status = (_, res) => res.json({
  ok: true,
  mode:    'innertube-stream',
  storage: '0 byte',
  cache:   yt._cache.size,
});
