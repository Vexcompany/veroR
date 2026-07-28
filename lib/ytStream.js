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
    ANDROID_MUSIC: {
        id: '21',
        version: '7.27.52',
        userAgent: 'com.google.android.apps.youtube.music/7.27.52 (Linux; U; Android 11; id_ID; Pixel 6) gzip',
        context: {
            clientName: 'ANDROID_MUSIC', clientVersion: '7.27.52',
            osName: 'Android', osVersion: '11', androidSdkVersion: 30,
        },
        includeUA: true,
    },
    WEB_REMIX: {
        id: '67',
        version: '1.20260114.03.00',
        userAgent: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64; rv:140.0) Gecko/20100101 Firefox/140.0',
        context: { clientName: 'WEB_REMIX', clientVersion: '1.20260114.03.00' },
        music: true,
    },
};

// IOS paling jarang kena block dari datacenter, ANDROID_MUSIC fallback ke-2
const STREAM_ORDER = ['IOS', 'ANDROID_MUSIC', 'ANDROID_VR', 'TVHTML5_EMBED'];

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
        'accept': '*/*',
        'accept-language': `${locale.hl || 'id'},en;q=0.9`,
        'accept-encoding': 'gzip, deflate, br',
        'sec-fetch-mode': 'same-origin',
        'sec-fetch-site': 'same-origin',
        'sec-fetch-dest': 'empty',
        'x-origin': c.music ? 'https://music.youtube.com' : 'https://www.youtube.com',
    };
    if (c.music) {
        headers.origin  = 'https://music.youtube.com';
        headers.referer = 'https://music.youtube.com/';
    } else {
        headers.origin  = 'https://www.youtube.com';
        headers.referer = 'https://www.youtube.com/';
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

// ── Piped instances (fallback berurutan) ────────────────────────────────────
const PIPED_INSTANCES = [
    'https://pipedapi.kavin.rocks',
    'https://pipedapi.adminforge.de',
    'https://api.piped.yt',
    'https://pipedapi.ducks.party',
];

async function resolveFromPiped(videoId, quality) {
    const errors = [];
    for (const base of PIPED_INSTANCES) {
        try {
            const res = await fetch(`${base}/streams/${videoId}`, {
                headers: { 'User-Agent': 'Mozilla/5.0', accept: 'application/json' },
                signal: AbortSignal.timeout(8000),
            });
            if (!res.ok) { errors.push(`${base}: HTTP ${res.status}`); continue; }
            const d = await res.json();

            const streams = (d.audioStreams || [])
                .filter(s => s.url && s.bitrate)
                .sort((a, b) => b.bitrate - a.bitrate);
            if (!streams.length) { errors.push(`${base}: no audio streams`); continue; }

            const s = quality === 'low' ? streams[streams.length - 1]
                    : quality === 'medium' ? streams[Math.floor(streams.length / 2)]
                    : streams[0];

            return {
                url:           s.url,
                mimeType:      s.mimeType || 'audio/webm',
                bitrate:       s.bitrate,
                contentLength: null,
                durationSec:   d.duration   || null,
                title:         d.title      || null,
                artist:        d.uploader ? String(d.uploader).replace(/ - Topic$/, '') : null,
                thumbnail:     d.thumbnailUrl || null,
                expiresAt:     Date.now() + 5.5 * 3600 * 1000,
                via:           base,
            };
        } catch (e) {
            errors.push(`${base}: ${e.message}`);
        }
    }
    const err = new Error('Semua Piped instance gagal');
    err.details = errors;
    throw err;
}

/**
 * videoId → URL stream audio via Piped (tidak hit YouTube langsung).
 */
async function resolveStream(videoId, { quality = 'high', locale, force = false } = {}) {
    const key = `stream:${videoId}:${quality}`;
    if (!force) {
        const hit = cacheGet(key);
        if (hit && hit.expiresAt - Date.now() > 10 * 60 * 1000) return hit;
    }
    const out = await resolveFromPiped(videoId, quality);
    out.videoId = videoId;
    cacheSet(key, out, Math.max(60_000, out.expiresAt - Date.now() - 600_000));
    return out;
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

// ── Home Feed ─────────────────────────────────────────────────────
// Strategi dua lapis:
//   1. HOME_PLAYLIST — playlist YouTube Music dengan ID stabil;
//      diparsing via /browse (musicResponsiveListItemRenderer).
//   2. HOME_SEARCH   — query search fallback kalau browse gagal;
//      selalu berhasil selama jaringan ada.
//
// Format HOME_PLAYLIST: { id: 'VL<playlistId>', label, searchFallback }
//   - id harus diawali 'VL' agar InnerTube mengenalinya sebagai playlist
//   - searchFallback: query untuk fallback jika browse gagal

const HOME_PLAYLIST = [
    // ── Indonesia ──────────────────────────────────────────────────
    {
        id: 'VLPL4fGSI1pDJn6O1LS0XTFroDlC5bJTNOoA',
        label: 'Top Hits Indonesia',
        searchFallback: 'top hits indonesia 2025',
    },
    {
        id: 'VLPLwrCCgMnTrjS1RRHVXq5n1X0DQ38SFZ5X',
        label: 'Trending Indonesia',
        searchFallback: 'trending musik indonesia 2025',
    },
    // Hot 100 Indonesia — stabil dari YouTube Music Charts
    {
        id: 'VLPL7vALQi-PkqOsEcJWRlFElhsQJQ-6cT0B',
        label: 'Hot 100 Indonesia',
        searchFallback: 'lagu indonesia terpopuler 2025',
    },
    // Pop Indonesia
    {
        id: 'VLPLbCUfhNHqFulCKUvMgXrGR71JVdirB-Bb',
        label: 'Pop Indonesia',
        searchFallback: 'pop indonesia terbaru 2025',
    },
    // ── Global ─────────────────────────────────────────────────────
    // YouTube Music Global Hot 100 (charts.youtube.com stabil)
    {
        id: 'VLPL4fGSI1pDJn69On1f-8NAvX_ygr8aqYcJ',
        label: 'Global Top Songs',
        searchFallback: 'global top songs 2025',
    },
    // Pop Internasional
    {
        id: 'VLPLDfp3-8QD2S4F8OzCBw-A7mQp8uXlKnV1',
        label: 'Pop International',
        searchFallback: 'best pop songs 2025',
    },
    // ── Genre ──────────────────────────────────────────────────────
    {
        id: 'VLPL4fGSI1pDJn5mlMziK07Tg5bGWJAlJpEp',
        label: 'Hip-Hop & R&B',
        searchFallback: 'hip hop rnb hits 2025',
    },
    {
        id: 'VLPLmqM9S7P-VIqBV7G0HJ0YrH_ZGwlDFkiK',
        label: 'K-Pop Hits',
        searchFallback: 'kpop hits 2025',
    },
];

// Pure-search sections: selalu pakai searchSongs, tidak browse
const HOME_SEARCH = [
    { label: 'OPM Philippines',    query: 'opm songs 2025'              },
    { label: 'Acoustic & Chill',   query: 'acoustic chill songs 2025'   },
    { label: 'Throwback Hits',     query: 'throwback hits 2000s'         },
];

// ── Ekstrak track dari satu node InnerTube (multi-format) ─────────
function _extractFromNode(node, max = 12) {
    const items = [];

    // Format 1: musicResponsiveListItemRenderer (playlist/shelf)
    const tryResponsive = (it) => {
        const R = it?.musicResponsiveListItemRenderer;
        if (!R) return null;
        const cols = R.flexColumns || [];
        const title = runsText(cols[0]?.musicResponsiveListItemFlexColumnRenderer?.text);
        if (!title) return null;
        const sub = cols[1]?.musicResponsiveListItemFlexColumnRenderer?.text?.runs || [];
        const videoId =
            R.playlistItemData?.videoId ||
            R.overlay?.musicItemThumbnailOverlayRenderer?.content
                ?.musicPlayButtonRenderer?.playNavigationEndpoint?.watchEndpoint?.videoId ||
            R.flexColumns?.flatMap(c =>
                c?.musicResponsiveListItemFlexColumnRenderer?.text?.runs || []
            ).find(r => r?.navigationEndpoint?.watchEndpoint?.videoId)
                ?.navigationEndpoint?.watchEndpoint?.videoId;
        if (!videoId) return null;
        const durText = sub.map(x => x.text).find(t => /^\d+[:.]/.test(t));
        const thumbs  = R.thumbnail?.musicThumbnailRenderer?.thumbnail?.thumbnails || [];
        return {
            videoId, title,
            artist: sub.find(x => x.navigationEndpoint?.browseEndpoint
                ?.browseId?.startsWith('UC'))?.text || sub[0]?.text || '',
            duration:  parseDurationText(durText),
            thumbnail: upscaleThumb(thumbs.length ? thumbs[thumbs.length - 1].url : null),
        };
    };

    // Format 2: playlistVideoRenderer (classic playlist)
    const tryVideo = (it) => {
        const V = it?.playlistVideoRenderer;
        if (!V || !V.videoId) return null;
        const thumbs = V.thumbnail?.thumbnails || [];
        const owner  = V.shortBylineText?.runs?.[0]?.text || '';
        const durSec = parseInt(V.lengthSeconds, 10) || null;
        return {
            videoId: V.videoId,
            title:   runsText(V.title),
            artist:  owner,
            duration: durSec,
            thumbnail: upscaleThumb(thumbs.length ? thumbs[thumbs.length - 1].url : null),
        };
    };

    // Kumpulkan semua kemungkinan isi
    const flatList = Array.isArray(node) ? node : (node?.contents || []);
    for (const it of flatList) {
        const track = tryResponsive(it) || tryVideo(it);
        if (track) items.push(track);
        if (items.length >= max) break;
    }
    return items;
}

// ── Parsing response browse InnerTube (semua varian layout) ──────
function _parseHomeBrowse(data, max = 12) {
    // Varian A: singleColumnBrowseResultsRenderer (playlist baru)
    const tabContent =
        data?.contents?.singleColumnBrowseResultsRenderer?.tabs?.[0]
            ?.tabRenderer?.content;

    // Coba musicPlaylistShelfRenderer langsung
    if (tabContent?.musicPlaylistShelfRenderer) {
        const items = _extractFromNode(tabContent.musicPlaylistShelfRenderer.contents, max);
        if (items.length) return items;
    }

    // Coba sectionListRenderer → shelf / playlistShelf
    const sectionContents = tabContent?.sectionListRenderer?.contents || [];
    for (const block of sectionContents) {
        const shelf =
            block?.musicShelfRenderer ||
            block?.musicPlaylistShelfRenderer ||
            block?.musicCarouselShelfRenderer;
        if (!shelf) continue;
        const items = _extractFromNode(shelf.contents, max);
        if (items.length) return items;
    }

    // Varian B: twoColumnBrowseResultsRenderer (beberapa playlist lama)
    const secondary =
        data?.contents?.twoColumnBrowseResultsRenderer?.secondaryContents
            ?.sectionListRenderer?.contents || [];
    for (const block of secondary) {
        const shelf = block?.playlistVideoListRenderer || block?.musicShelfRenderer;
        if (!shelf) continue;
        const items = _extractFromNode(shelf.contents, max);
        if (items.length) return items;
    }

    // Varian C: header + inline content (playlist detail page)
    const inlineContent =
        data?.contents?.twoColumnBrowseResultsRenderer?.primaryContents
            ?.sectionListRenderer?.contents?.[0]
            ?.playlistVideoListRenderer?.contents;
    if (inlineContent) {
        const items = _extractFromNode(inlineContent, max);
        if (items.length) return items;
    }

    return [];
}

async function getHomeFeed(locale) {
    const key = `home:${locale?.gl || 'ID'}`;
    const hit = cacheGet(key);
    if (hit) return hit;

    const sections = [];
    const MAX_PER_SECTION = 12;

    // ── Pass 1: playlist browse ────────────────────────────────────
    for (const sec of HOME_PLAYLIST) {
        try {
            const data = await innertube('browse', 'WEB_REMIX', {
                browseId: sec.id,
            }, locale);

            let items = _parseHomeBrowse(data, MAX_PER_SECTION);

            // Fallback search kalau browse tidak menghasilkan item
            if (!items.length) {
                console.warn('[home] browse gagal, fallback search:', sec.label);
                items = (await searchSongs(sec.searchFallback, locale)).slice(0, MAX_PER_SECTION);
            }

            if (items.length) {
                sections.push({ label: sec.label, items });
                console.log(`[home] ${sec.label}: ${items.length} tracks`);
            }
        } catch (e) {
            // Browse + search fallback
            console.warn('[home] section error, coba search:', sec.label, e.message);
            try {
                const items = (await searchSongs(sec.searchFallback, locale)).slice(0, MAX_PER_SECTION);
                if (items.length) sections.push({ label: sec.label, items });
            } catch (_) {}
        }
    }

    // ── Pass 2: pure search sections ──────────────────────────────
    for (const sec of HOME_SEARCH) {
        try {
            const items = (await searchSongs(sec.query, locale)).slice(0, MAX_PER_SECTION);
            if (items.length) sections.push({ label: sec.label, items });
        } catch (e) {
            console.warn('[home] search section error:', sec.label, e.message);
        }
    }

    // ── Fallback total ─────────────────────────────────────────────
    if (!sections.length) {
        try {
            const fallback = await searchSongs('top hits indonesia 2025', locale);
            if (fallback.length) sections.push({ label: 'Top Hits', items: fallback.slice(0, 12) });
        } catch (_) {}
    }

    console.log(`[home] total sections: ${sections.length}`);
    cacheSet(key, sections, 30 * 60 * 1000); // cache 30 menit
    return sections;
}

module.exports = {
    searchSongs,
    matchAppleToYouTube,
    resolveStream,
    getRelated,
    getHomeFeed,
    formatDuration,
    parseDurationText,
    normalizeTitle,
    similarity,
    generateCpn,
    _cache: cache,
};
