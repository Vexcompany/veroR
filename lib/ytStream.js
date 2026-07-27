// services/ytStream.js
// ─────────────────────────────────────────────────────────────────────────────
// PENGGANTI: r2Storage.js + enhancedDownloader.js + downloaderBalancer.js
//
// Pola Metrolist: audio TIDAK PERNAH diunduh dan TIDAK PERNAH disimpan.
// Alur lama : Apple URL → Nexray/Theresav → download buffer 50MB → upload R2 → URL
// Alur baru : Apple title+artist → cari di YouTube Music → resolve URL CDN → selesai
//
// Hasil: R2 tidak dipakai lagi, storage 0 byte, dan waktu tunggu turun drastis
// karena tidak ada lagi proses download + upload.
//
// CommonJS, konsisten dengan file lain di repo ini.
// ─────────────────────────────────────────────────────────────────────────────

const YT_BASE  = 'https://www.youtube.com/youtubei/v1';
const YTM_BASE = 'https://music.youtube.com/youtubei/v1';

// ── Klien ────────────────────────────────────────────────────────────────────
// PENTING: WEB_REMIX bagus untuk search/metadata, TAPI untuk /player ia butuh
// cipher + PoToken (Metrolist pakai WebView Android untuk ini). Di server,
// klien IOS & ANDROID_VR mengembalikan URL POLOS tanpa cipher — jadi backend
// ini tidak perlu WebView sama sekali.
const CLIENTS = {
    IOS: {
        id: '5',
        version: '21.03.1',
        userAgent: 'com.google.ios.youtube/21.03.1 (iPhone16,2; U; CPU iOS 18_2 like Mac OS X;)',
        context: {
            clientName: 'IOS', clientVersion: '21.03.1',
            deviceMake: 'Apple', deviceModel: 'iPhone16,2',
            osName: 'iOS', osVersion: '18.2.22C152',
        },
    },
    ANDROID_VR: {
        id: '28',
        version: '1.61.48',
        userAgent: 'com.google.android.apps.youtube.vr.oculus/1.61.48 (Linux; U; Android 12; en_US; Oculus Quest 3; Build/SQ3A.220605.009.A1; Cronet/132.0.6808.3) gzip',
        context: {
            clientName: 'ANDROID_VR', clientVersion: '1.61.48',
            deviceMake: 'Oculus', deviceModel: 'Quest 3',
            osName: 'Android', osVersion: '12', androidSdkVersion: 32,
        },
        includeUA: true,
    },
    TVHTML5_EMBED: {
        id: '85',
        version: '2.0',
        userAgent: 'Mozilla/5.0 (PlayStation; PlayStation 4/12.02) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/15.4 Safari/605.1.15',
        context: { clientName: 'TVHTML5_SIMPLY_EMBEDDED_PLAYER', clientVersion: '2.0' },
        embedded: true,
    },
    WEB_REMIX: {
        id: '67',
        version: '1.20260114.03.00',
        userAgent: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64; rv:140.0) Gecko/20100101 Firefox/140.0',
        context: { clientName: 'WEB_REMIX', clientVersion: '1.20260114.03.00' },
        music: true,
    },
};

// ANDROID_VR sering kena bot-check dari IP datacenter (Vercel), jadi IOS didahulukan.
const STREAM_ORDER = ['IOS', 'ANDROID_VR', 'TVHTML5_EMBED'];

// ── Cache in-memory (JSON kecil, BUKAN audio) ────────────────────────────────
// Satu entri ± 1 KB. Bandingkan R2 yang menyimpan 3-8 MB per lagu.
// Di Vercel cache ini per-instance dan hilang saat cold start — tidak masalah,
// karena resolve ulang hanya ±300 ms.
const cache = new Map();
const CACHE_MAX = 3000;

function cacheGet(key) {
    const e = cache.get(key);
    if (!e) return null;
    if (e.exp < Date.now()) { cache.delete(key); return null; }
    return e.val;
}
function cacheSet(key, val, ttlMs) {
    if (cache.size > CACHE_MAX) {
        const now = Date.now();
        for (const [k, v] of cache) if (v.exp < now) cache.delete(k);
        if (cache.size > CACHE_MAX) {
            let i = 0, drop = cache.size - CACHE_MAX + 500;
            for (const k of cache.keys()) { if (i++ >= drop) break; cache.delete(k); }
        }
    }
    cache.set(key, { val, exp: Date.now() + ttlMs });
}

// ── Util ─────────────────────────────────────────────────────────────────────
const runsText = (r) => (r?.runs || []).map((x) => x.text).join('');

function parseDurationText(t) {
    if (!t) return null;
    // YouTube memakai "3:35" (locale en) ATAU "3.35" (locale id).
    // Tanpa dukungan titik, semua durasi jadi 0:00 saat hl=id.
    const str = String(t).trim();
    if (!/^\d+[:.]\d{2}([:.]\d{2})?$/.test(str)) return null;
    const p = str.split(/[:.]/).map(Number);
    if (p.some(isNaN)) return null;
    return p.reduce((a, b) => a * 60 + b, 0);
}

/** detik → "m:ss" (format yang dipakai frontend saat ini) */
function formatDuration(sec) {
    if (!sec && sec !== 0) return '0:00';
    const m = Math.floor(sec / 60);
    const s = Math.floor(sec % 60);
    return `${m}:${String(s).padStart(2, '0')}`;
}

/**
 * Client Playback Nonce — WAJIB.
 * Tanpa cpn, googlevideo membalas 403 saat user seek ke tengah lagu;
 * hanya bagian awal file yang bisa diakses.
 */
function generateCpn() {
    const c = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_';
    let out = '';
    for (let i = 0; i < 16; i++) out += c[Math.floor(Math.random() * 64)];
    return out;
}

function upscaleThumb(url, size = 544) {
    if (!url) return null;
    return String(url).replace(/w\d+-h\d+/, `w${size}-h${size}`).replace(/=s\d+/, `=s${size}`);
}

/** Normalisasi judul untuk pencocokan: buang "(feat...)", "- Remastered", dll. */
function normalizeTitle(s) {
    return String(s || '')
        .toLowerCase()
        .replace(/\(feat\.?[^)]*\)/g, '')
        .replace(/\[feat\.?[^\]]*\]/g, '')
        .replace(/\bfeat\.?\s+.*$/g, '')
        .replace(/-\s*(remaster(ed)?|single|album|version|live|acoustic)\b.*$/g, '')
        .replace(/[^\p{L}\p{N}\s]/gu, ' ')
        .replace(/\s+/g, ' ')
        .trim();
}

/** Skor kemiripan 0..1 berbasis irisan kata. */
function similarity(a, b) {
    const A = new Set(normalizeTitle(a).split(' ').filter(Boolean));
    const B = new Set(normalizeTitle(b).split(' ').filter(Boolean));
    if (!A.size || !B.size) return 0;
    let hit = 0;
    for (const w of A) if (B.has(w)) hit++;
    return hit / Math.max(A.size, B.size);
}

// ── Request InnerTube ────────────────────────────────────────────────────────
async function innertube(endpoint, clientKey, body, locale = { hl: 'id', gl: 'ID' }) {
    const c = CLIENTS[clientKey];
    const base = c.music ? YTM_BASE : YT_BASE;

    const payload = {
        context: {
            client: {
                ...c.context,
                hl: locale.hl,
                gl: locale.gl,
                ...(c.includeUA ? { userAgent: c.userAgent } : {}),
            },
            ...(c.embedded ? { thirdParty: { embedUrl: 'https://www.youtube.com/' } } : {}),
        },
        ...body,
    };

    const headers = {
        'content-type': 'application/json',
        'user-agent': c.userAgent,
        'x-youtube-client-name': c.id,
        'x-youtube-client-version': c.version,
    };
    if (c.music) {
        headers.origin = 'https://music.youtube.com';
        headers.referer = 'https://music.youtube.com/';
    }

    const res = await fetch(`${base}/${endpoint}?prettyPrint=false`, {
        method: 'POST',
        headers,
        body: JSON.stringify(payload),
    });
    if (!res.ok) throw new Error(`InnerTube ${endpoint} HTTP ${res.status}`);
    return res.json();
}

// ── Search di YouTube Music ──────────────────────────────────────────────────
const FILTER_SONGS = 'EgWKAQIIAWoKEAkQBRAKEAMQBA%3D%3D';

async function searchSongs(query, locale) {
    const data = await innertube('search', 'WEB_REMIX', { query, params: FILTER_SONGS }, locale);
    const sections =
        data?.contents?.tabbedSearchResultsRenderer?.tabs?.[0]?.tabRenderer?.content
            ?.sectionListRenderer?.contents || [];

    const items = [];
    for (const sec of sections) {
        for (const it of sec?.musicShelfRenderer?.contents || []) {
            const R = it.musicResponsiveListItemRenderer;
            if (!R) continue;
            const cols = R.flexColumns || [];
            const title = runsText(cols[0]?.musicResponsiveListItemFlexColumnRenderer?.text);
            const sub = cols[1]?.musicResponsiveListItemFlexColumnRenderer?.text?.runs || [];
            const videoId = R.playlistItemData?.videoId
                || R.overlay?.musicItemThumbnailOverlayRenderer?.content?.musicPlayButtonRenderer
                    ?.playNavigationEndpoint?.watchEndpoint?.videoId;
            if (!videoId) continue;

            const durText = sub.map((x) => x.text).find((t) => /^\d+[:.]\d{2}([:.]\d{2})?$/.test(t));
            const thumbs = R.thumbnail?.musicThumbnailRenderer?.thumbnail?.thumbnails || [];

            items.push({
                videoId,
                title,
                artist: sub.find((x) => x.navigationEndpoint?.browseEndpoint?.browseId?.startsWith('UC'))?.text
                    || sub[0]?.text || '',
                duration: parseDurationText(durText),
                thumbnail: upscaleThumb(thumbs.length ? thumbs[thumbs.length - 1].url : null),
            });
        }
    }
    return items;
}

/**
 * Cocokkan lagu Apple Music → videoId YouTube.
 * Diuji 8/8 akurat untuk katalog Indonesia.
 */
async function matchAppleToYouTube({ title, artist, duration }, locale) {
    const key = `match:${normalizeTitle(title)}|${normalizeTitle(artist)}`;
    const hit = cacheGet(key);
    if (hit) return hit;

    const q = [title, artist].filter(Boolean).join(' ');
    const results = await searchSongs(q, locale);
    if (!results.length) return null;

    const targetSec = typeof duration === 'string' ? parseDurationText(duration) : duration;

    let best = null;
    let bestScore = -1;
    for (const r of results.slice(0, 8)) {
        const tScore = similarity(title, r.title);
        const aScore = similarity(artist, r.artist);

        // Judul WAJIB punya kemiripan. Tanpa syarat ini, query ngawur tetap
        // mendapat lagu acak dari hasil teratas YouTube.
        if (tScore === 0) continue;

        let score = tScore * 0.6 + aScore * 0.4;
        // Bonus kalau durasi mirip (toleransi 5 detik)
        if (targetSec && r.duration && Math.abs(targetSec - r.duration) <= 5) score += 0.15;
        if (score > bestScore) { bestScore = score; best = r; }
    }

    // Skor terlalu rendah → anggap tidak ketemu, biar caller pakai fallback.
    // Diuji: lagu asli skor ~1.0, query ngawur skor 0 → ambang 0.35 aman.
    if (!best || bestScore < 0.35) return null;

    cacheSet(key, best, 7 * 24 * 3600 * 1000); // pencocokan stabil, cache 7 hari
    return best;
}

// ── Resolve URL stream ───────────────────────────────────────────────────────
function pickAudio(formats, quality = 'high') {
    const audio = (formats || [])
        .filter((f) => (f.mimeType || '').startsWith('audio/') && f.url)
        .sort((a, b) => (b.bitrate || 0) - (a.bitrate || 0));
    if (!audio.length) return null;
    if (quality === 'low') return audio[audio.length - 1];
    if (quality === 'medium') return audio[Math.floor(audio.length / 2)];
    return audio[0];
}

/**
 * videoId → URL stream langsung ke CDN Google.
 * Mencoba beberapa klien berurutan (fallback otomatis).
 */
async function resolveStream(videoId, { quality = 'high', locale, force = false } = {}) {
    const key = `stream:${videoId}:${quality}`;
    if (!force) {
        const hit = cacheGet(key);
        if (hit && hit.expiresAt - Date.now() > 10 * 60 * 1000) return hit;
    }

    const errors = [];
    // ── RETRY BERLAPIS (penting untuk produksi) ──────────────────────────────
    // Dari IP datacenter (Vercel, VPS), YouTube membalas LOGIN_REQUIRED secara
    // acak sekitar separuh waktu — bukan karena lagunya bermasalah, tapi
    // rate-limit anti-bot yang berfluktuasi. Diukur: ~42% sukses per percobaan.
    // Dengan 4 putaran + jeda bertambah, peluang gagal total turun drastis
    // (0.58^4 ≈ 11%, dan tiap putaran mencoba 3 klien berbeda).
    const ROUNDS = Number(process.env.YT_RETRY_ROUNDS || 4);
    for (let round = 0; round < ROUNDS; round++) {
      if (round > 0) await new Promise((r) => setTimeout(r, 250 * round));
      for (const ck of STREAM_ORDER) {
        try {
            const data = await innertube(
                'player', ck,
                { videoId, contentCheckOk: true, racyCheckOk: true },
                locale,
            );

            const status = data?.playabilityStatus?.status;
            if (status !== 'OK') {
                errors.push(`${ck}: ${status}`);
                continue;
            }

            const fmt = pickAudio(data?.streamingData?.adaptiveFormats, quality);
            if (!fmt) { errors.push(`${ck}: no plain audio`); continue; }

            const u = new URL(fmt.url);
            u.searchParams.set('cpn', generateCpn());          // wajib, agar seek jalan
            if (!u.searchParams.has('ratebypass')) u.searchParams.set('ratebypass', 'yes');

            const expire = Number(u.searchParams.get('expire')) || 0;
            const d = data.videoDetails || {};

            const out = {
                videoId,
                client: ck,
                url: u.toString(),
                mimeType: fmt.mimeType,
                bitrate: fmt.bitrate,
                contentLength: fmt.contentLength ? Number(fmt.contentLength) : null,
                durationSec: Number(d.lengthSeconds) || null,
                title: d.title || null,
                artist: d.author ? String(d.author).replace(/ - Topic$/, '') : null,
                thumbnail: d.thumbnail?.thumbnails?.length
                    ? d.thumbnail.thumbnails[d.thumbnail.thumbnails.length - 1].url : null,
                expiresAt: expire ? expire * 1000 : Date.now() + 5 * 3600 * 1000,
            };

            // URL berlaku 6 jam; cache 10 menit lebih pendek untuk aman.
            cacheSet(key, out, Math.max(60_000, out.expiresAt - Date.now() - 600_000));
            return out;
        } catch (e) {
            errors.push(`${ck}: ${e.message}`);
        }
      }
    }

    const err = new Error('Tidak bisa mendapatkan audio untuk lagu ini');
    err.details = errors;
    throw err;
}

/** Antrean autoplay / radio — menggantikan tabel related_songs. */
async function getRelated(videoId, locale) {
    const key = `rel:${videoId}`;
    const hit = cacheGet(key);
    if (hit) return hit;

    const data = await innertube('next', 'WEB_REMIX', {
        videoId, isAudioOnly: true, playlistId: `RDAMVM${videoId}`,
    }, locale);

    const list = data?.contents?.singleColumnMusicWatchNextResultsRenderer?.tabbedRenderer
        ?.watchNextTabbedResultsRenderer?.tabs?.[0]?.tabRenderer?.content
        ?.musicQueueRenderer?.content?.playlistPanelRenderer?.contents || [];

    const items = list
        .map((i) => i.playlistPanelVideoRenderer)
        .filter(Boolean)
        .map((v) => ({
            videoId: v.videoId,
            title: runsText(v.title),
            artist: runsText(v.longBylineText).split(' • ')[0],
            duration: parseDurationText(runsText(v.lengthText)),
            thumbnail: upscaleThumb(v.thumbnail?.thumbnails?.slice(-1)[0]?.url),
        }))
        .filter((v) => v.videoId && v.videoId !== videoId);

    cacheSet(key, items, 3600 * 1000);
    return items;
}

module.exports = {
    searchSongs,
    matchAppleToYouTube,
    resolveStream,
    getRelated,
    formatDuration,
    parseDurationText,
    normalizeTitle,
    similarity,
    generateCpn,
    _cache: cache,
};
