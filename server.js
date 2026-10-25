require('dotenv').config();
const express = require('express');
const cors = require('cors');
const helmet = require('helmet');
const morgan = require('morgan');
const rateLimit = require('express-rate-limit');
const path = require('path');
const fs = require('fs');
const { exec, spawn } = require('child_process');
const { v4: uuidv4 } = require('uuid');
const NodeCache = require('node-cache');
const axios = require('axios');
const https = require('https');

const app = express();
const PORT = process.env.PORT || 3000;
const cache = new NodeCache({ stdTTL: 600, checkperiod: 120 });
const IS_HEROKU = Boolean(process.env.DYNO);

// ─── Resolve Static Frontend Directory ────────────────────────────────────────
const FRONTEND_DIR = fs.existsSync(path.join(__dirname, 'frontend'))
  ? path.join(__dirname, 'frontend')
  : path.join(__dirname, '..', 'frontend');

// ─── Resolve Downloads Directory ──────────────────────────────────────────────
const DOWNLOADS_DIR = path.join(__dirname, 'downloads');
if (!fs.existsSync(DOWNLOADS_DIR)) fs.mkdirSync(DOWNLOADS_DIR, { recursive: true });

// ─── Resolve & Ensure yt-dlp Binary ───────────────────────────────────────────
const YTDLP_BIN_DIR = path.join(__dirname, 'bin');
const YTDLP_LOCAL = path.join(YTDLP_BIN_DIR, process.platform === 'win32' ? 'yt-dlp.exe' : 'yt-dlp');

function resolveYtdlpBin() {
  if (fs.existsSync(YTDLP_LOCAL)) return YTDLP_LOCAL;
  
  if (process.platform === 'win32') {
    const winPath = path.join(
      process.env.LOCALAPPDATA || process.env.USERPROFILE || '',
      'AppData', 'Local', 'Programs', 'yt-dlp', 'yt-dlp.exe'
    );
    if (fs.existsSync(winPath)) return winPath;
  }
  return 'yt-dlp';
}

async function ensureYtdlp() {
  if (fs.existsSync(YTDLP_LOCAL)) return;
  if (process.platform === 'win32') {
    const winPath = path.join(
      process.env.LOCALAPPDATA || process.env.USERPROFILE || '',
      'AppData', 'Local', 'Programs', 'yt-dlp', 'yt-dlp.exe'
    );
    if (fs.existsSync(winPath)) return;
  }

  if (!fs.existsSync(YTDLP_BIN_DIR)) fs.mkdirSync(YTDLP_BIN_DIR, { recursive: true });

  const isWin = process.platform === 'win32';
  // On Linux, yt-dlp_linux is the standalone PyInstaller ELF executable (bundled python, doesn't need /usr/bin/env python3)
  const binName = isWin ? 'yt-dlp.exe' : 'yt-dlp_linux';
  const dlUrl = `https://github.com/yt-dlp/yt-dlp/releases/latest/download/${binName}`;

  console.log(`[KINETIK Engine] Fetching standalone ${binName} binary for ${process.platform}...`);

  await new Promise((resolve, reject) => {
    const follow = (url, depth = 0) => {
      if (depth > 6) return reject(new Error('Redirect limit reached'));
      https.get(url, { headers: { 'User-Agent': 'Kinetik-Downloader/2.0' } }, res => {
        if ([301, 302, 307, 308].includes(res.statusCode)) {
          return follow(res.headers.location, depth + 1);
        }
        if (res.statusCode !== 200) return reject(new Error(`HTTP ${res.statusCode}`));
        const fileStream = fs.createWriteStream(YTDLP_LOCAL);
        res.pipe(fileStream);
        fileStream.on('finish', () => {
          fileStream.close();
          if (!isWin) fs.chmodSync(YTDLP_LOCAL, '755');
          console.log('[KINETIK Engine] Binary deployed to', YTDLP_LOCAL);
          resolve();
        });
        fileStream.on('error', reject);
      }).on('error', reject);
    };
    follow(dlUrl);
  });
}

let YTDLP_BIN = resolveYtdlpBin();

// ─── Middleware Setup ─────────────────────────────────────────────────────────
app.use(helmet({
  contentSecurityPolicy: false,
  crossOriginEmbedderPolicy: false,
  crossOriginResourcePolicy: false,
}));
app.use(morgan('short'));
app.use(cors({ origin: process.env.ALLOWED_ORIGIN || '*', methods: ['GET', 'POST'] }));
app.use(express.json({ limit: '64kb' }));
app.use(express.urlencoded({ extended: true }));

// Serve frontend assets
app.use(express.static(FRONTEND_DIR));

// Serve cached video downloads
app.use('/downloads', express.static(DOWNLOADS_DIR, {
  setHeaders: (res, filePath) => {
    res.setHeader('Content-Disposition', `attachment; filename="${path.basename(filePath)}"`);
  }
}));

// Rate limiter for API routes
const limiter = rateLimit({
  windowMs: 60 * 1000,
  max: 30,
  standardHeaders: true,
  legacyHeaders: false,
  message: { success: false, error: 'Kinetik Rate Limit: Too many requests, cool down for a moment.' },
});
app.use('/api/', limiter);

// ─── Auto File Garbage Collector ──────────────────────────────────────────────
function cleanExpiredDownloads() {
  const MAX_AGE_MS = 10 * 60 * 1000; // 10 minutes
  const now = Date.now();
  try {
    fs.readdirSync(DOWNLOADS_DIR).forEach(f => {
      const fullPath = path.join(DOWNLOADS_DIR, f);
      const stat = fs.statSync(fullPath);
      if (now - stat.mtimeMs > MAX_AGE_MS) {
        fs.unlinkSync(fullPath);
      }
    });
  } catch {}
}
setInterval(cleanExpiredDownloads, 3 * 60 * 1000);

// ─── URL Extractor & Canonical Redirect Resolver ──────────────────────────────
// Supports: tiktok.com, vt.tiktok.com, vm.tiktok.com, wm.tiktok.com, m.tiktok.com
function extractTiktokUrl(input) {
  if (!input || typeof input !== 'string') return null;
  const match = input.match(/(https?:\/\/(?:[a-zA-Z0-9_-]+\.)?tiktok\.com\/[^\s?#]+|(?:vt|vm|wm|m|www)?\.?tiktok\.com\/[^\s?#]+)/i);
  if (!match) return null;
  let url = match[1];
  if (!url.startsWith('http://') && !url.startsWith('https://')) {
    url = 'https://' + url;
  }
  return url;
}

async function resolveCanonicalUrl(rawUrl) {
  const extracted = extractTiktokUrl(rawUrl);
  if (!extracted) return null;

  // If already canonical video URL, clean query params
  if (extracted.includes('/video/') || extracted.includes('/photo/')) {
    try {
      const u = new URL(extracted);
      return `${u.protocol}//${u.host}${u.pathname}`;
    } catch {
      return extracted;
    }
  }

  // Follow HTTP 301/302 redirects for vt.tiktok.com, vm.tiktok.com, wm.tiktok.com, etc.
  try {
    const res = await axios.get(extracted, {
      maxRedirects: 6,
      timeout: 10000,
      headers: {
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0.0.0 Safari/537.36',
        'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
      },
      validateStatus: (s) => s >= 200 && s < 400,
    });
    const finalUrl = res.request?.res?.responseUrl || res.config?.url;
    if (finalUrl && (finalUrl.includes('/video/') || finalUrl.includes('/photo/'))) {
      const u = new URL(finalUrl);
      return `${u.protocol}//${u.host}${u.pathname}`;
    }
  } catch (err) {
    console.warn('[Redirect Resolver] Fallback to:', extracted, err.message);
  }

  return extracted;
}

// ─── Engine 1: Pure Native Node.js TikTok Extractor (0 Dependencies, No Python) ─
async function extractViaNativeTiktok(cleanUrl) {
  const res = await axios.get(cleanUrl, {
    headers: {
      'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0.0.0 Safari/537.36',
      'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,image/avif,image/webp,*/*;q=0.8',
      'Accept-Language': 'en-US,en;q=0.9',
      'Sec-Ch-Ua': '"Chromium";v="130", "Google Chrome";v="130", "Not?A_Brand";v="99"',
      'Sec-Ch-Ua-Mobile': '?0',
      'Sec-Ch-Ua-Platform': '"Windows"',
      'Sec-Fetch-Dest': 'document',
      'Sec-Fetch-Mode': 'navigate',
      'Sec-Fetch-Site': 'none',
      'Sec-Fetch-User': '?1',
    },
    timeout: 15000,
  });

  const html = res.data;
  const cookies = res.headers['set-cookie']?.map(c => c.split(';')[0]).join('; ') || '';

  // 1. Try __UNIVERSAL_DATA_FOR_REHYDRATION__
  const m = html.match(/<script id="__UNIVERSAL_DATA_FOR_REHYDRATION__"[^>]*>([\s\S]*?)<\/script>/);
  if (m) {
    try {
      const data = JSON.parse(m[1]);
      const defaultScope = data['__DEFAULT_SCOPE__'];
      const videoDetail = defaultScope?.['webapp.video-detail'];
      const item = videoDetail?.itemInfo?.itemStruct;
      if (item && item.video) {
        return {
          id: item.id || String(Date.now()),
          title: item.desc || 'TikTok Video',
          author: item.author?.uniqueId || item.author?.nickname || 'creator',
          author_name: item.author?.nickname || 'Creator',
          avatar: item.author?.avatarThumb || item.author?.avatarLarger || '',
          cover: item.video?.cover || item.video?.originCover || '',
          raw_cover: item.video?.cover || item.video?.originCover || '',
          duration: item.video?.duration || 0,
          play_count: item.stats?.playCount || 0,
          like_count: item.stats?.diggCount || 0,
          comment_count: item.stats?.commentCount || 0,
          share_count: item.stats?.shareCount || 0,
          resolution: item.video?.width && item.video?.height ? `${item.video.width}x${item.video.height}` : '1080p Full HD',
          playAddr: item.video?.playAddr || item.video?.downloadAddr,
          downloadAddr: item.video?.downloadAddr || item.video?.playAddr,
          audio_url: item.music?.playUrl || null,
          music_title: item.music?.title || '',
          music_author: item.music?.authorName || '',
          cookies,
          cleanUrl,
          source: 'Native-WebJS',
        };
      }
    } catch (e) {
      console.warn('[Native Scraper] Rehydration parse error:', e.message);
    }
  }

  // 2. Try SIGI_STATE
  const s = html.match(/<script id="SIGI_STATE"[^>]*>([\s\S]*?)<\/script>/);
  if (s) {
    try {
      const sigi = JSON.parse(s[1]);
      const itemModule = sigi.ItemModule;
      if (itemModule) {
        const id = Object.keys(itemModule)[0];
        const item = itemModule[id];
        if (item && item.video) {
          return {
            id: item.id || String(Date.now()),
            title: item.desc || 'TikTok Video',
            author: item.author || 'creator',
            author_name: item.nickname || item.author || 'Creator',
            avatar: item.avatarThumb || '',
            cover: item.video?.cover || '',
            raw_cover: item.video?.cover || '',
            duration: item.video?.duration || 0,
            play_count: item.stats?.playCount || 0,
            like_count: item.stats?.diggCount || 0,
            comment_count: item.stats?.commentCount || 0,
            share_count: item.stats?.shareCount || 0,
            resolution: '1080p Full HD',
            playAddr: item.video?.playAddr || item.video?.downloadAddr,
            downloadAddr: item.video?.downloadAddr || item.video?.playAddr,
            audio_url: item.music?.playUrl || null,
            music_title: item.music?.title || '',
            music_author: item.music?.authorName || '',
            cookies,
            cleanUrl,
            source: 'Native-SIGI',
          };
        }
      }
    } catch (e) {
      console.warn('[Native Scraper] SIGI parse error:', e.message);
    }
  }

  throw new Error('Native TikTok extractor found no media payload');
}

// ─── Engine 2: yt-dlp Executable ──────────────────────────────────────────────
function extractViaYtdlp(cleanUrl) {
  return new Promise((resolve, reject) => {
    const cmd = `"${YTDLP_BIN}" --dump-json --no-playlist --no-warnings "${cleanUrl}"`;
    exec(cmd, { timeout: 45000, maxBuffer: 10 * 1024 * 1024 }, (err, stdout) => {
      if (err) return reject(err);
      try {
        const info = JSON.parse(stdout.trim());
        resolve(info);
      } catch (parseErr) {
        reject(new Error('Invalid JSON from extractor'));
      }
    });
  });
}

// ─── Engine 3: TikWM Fallback ─────────────────────────────────────────────────
async function extractViaTikwm(cleanUrl) {
  const resp = await axios.post('https://api.tikwm.com/api/',
    new URLSearchParams({ url: cleanUrl, hd: 1 }),
    { timeout: 12000, headers: { 'Content-Type': 'application/x-www-form-urlencoded' } }
  );
  if (resp.data?.code === 0 && resp.data.data) {
    return resp.data.data;
  }
  throw new Error(resp.data?.msg || 'TikWM non-zero response');
}

// ─── API Routes ───────────────────────────────────────────────────────────────

// Health & Telemetry
app.get('/api/health', (_, res) => {
  res.json({
    status: 'ONLINE',
    engine: 'KINETIK Deep-Stream Core (Native JS + yt-dlp)',
    runtime: IS_HEROKU ? 'Heroku Dyno' : 'Local Node Environment',
    extractor: YTDLP_BIN,
    node: process.version,
    platform: process.platform,
    timestamp: Date.now(),
  });
});

// Deep Metadata Extraction
app.post('/api/info', async (req, res) => {
  const { url } = req.body;
  if (!url) return res.status(400).json({ success: false, error: 'URL is required.' });

  const cleanUrl = await resolveCanonicalUrl(url);
  if (!cleanUrl) {
    return res.status(400).json({ success: false, error: 'Invalid TikTok URL structure. Mendukung tiktok.com, vt.tiktok, wm.tiktok, vm.tiktok.' });
  }

  const cacheKey = `kinetik_info:${cleanUrl}`;
  const cached = cache.get(cacheKey);
  if (cached) {
    return res.json({ success: true, cached: true, data: cached });
  }

  // 1. Primary: Native Node.js TikTok Extractor (0 external dependencies, no python needed)
  try {
    const native = await extractViaNativeTiktok(cleanUrl);
    
    // Store media stream info in cache for fast proxying
    cache.set(`media_stream:${native.id}`, {
      playAddr: native.playAddr,
      downloadAddr: native.downloadAddr,
      audioUrl: native.audio_url,
      cookies: native.cookies,
      cleanUrl,
    });

    const payload = {
      id: native.id,
      title: native.title,
      author: native.author,
      author_name: native.author_name,
      avatar: native.avatar ? `/api/proxy-media?url=${encodeURIComponent(native.avatar)}` : '',
      cover: native.cover ? `/api/proxy-media?url=${encodeURIComponent(native.cover)}` : '',
      raw_cover: native.raw_cover,
      duration: native.duration,
      play_count: native.play_count,
      like_count: native.like_count,
      comment_count: native.comment_count,
      share_count: native.share_count,
      resolution: native.resolution,
      quality: 'Master HD (Source)',
      fps: 30,
      clean_url: cleanUrl,
      has_direct_stream: true,
      audio_url: `/api/stream?id=${encodeURIComponent(native.id)}&url=${encodeURIComponent(cleanUrl)}&format=audio`,
      video_stream_url: `/api/stream?id=${encodeURIComponent(native.id)}&url=${encodeURIComponent(cleanUrl)}&format=hd`,
      source: native.source,
    };

    cache.set(cacheKey, payload);
    return res.json({ success: true, data: payload });
  } catch (nativeErr) {
    console.warn('[KINETIK] Native JS extractor warning:', nativeErr.message);
  }

  // 2. Secondary: yt-dlp Native Extraction
  try {
    const raw = await extractViaYtdlp(cleanUrl);
    let bestVideoUrl = raw.url || null;
    let resolution = '1080p Full HD';
    let width = 1080;
    let height = 1920;

    if (raw.formats && Array.isArray(raw.formats)) {
      const mp4Formats = raw.formats
        .filter(f => f.url && (f.ext === 'mp4' || f.video_ext === 'mp4' || f.vcodec !== 'none'))
        .sort((a, b) => ((b.height || 0) * (b.width || 0)) - ((a.height || 0) * (a.width || 0)));

      if (mp4Formats.length > 0) {
        bestVideoUrl = mp4Formats[0].url;
        width = mp4Formats[0].width || 1080;
        height = mp4Formats[0].height || 1920;
        resolution = `${width}x${height}`;
      }
    }

    const payload = {
      id: raw.id || String(Date.now()),
      title: raw.title || raw.description || 'TikTok Video',
      author: raw.uploader || raw.channel || 'creator',
      author_name: raw.creator || raw.uploader || 'Creator',
      avatar: `/api/proxy-media?url=${encodeURIComponent(raw.thumbnail || '')}`,
      cover: `/api/proxy-media?url=${encodeURIComponent(raw.thumbnail || '')}`,
      raw_cover: raw.thumbnail || '',
      duration: raw.duration || 0,
      play_count: raw.view_count || 0,
      like_count: raw.like_count || 0,
      comment_count: raw.comment_count || 0,
      share_count: raw.repost_count || 0,
      resolution,
      quality: 'Master HD (Source)',
      fps: raw.fps || 30,
      clean_url: cleanUrl,
      has_direct_stream: true,
      audio_url: `/api/stream?url=${encodeURIComponent(cleanUrl)}&format=audio`,
      video_stream_url: `/api/stream?url=${encodeURIComponent(cleanUrl)}&format=hd`,
      source: 'Kinetik-YTDLP',
    };

    cache.set(cacheKey, payload);
    return res.json({ success: true, data: payload });
  } catch (ytErr) {
    console.warn('[KINETIK] yt-dlp fallback warning:', ytErr.message);
  }

  // 3. Tertiary: TikWM API
  try {
    const tw = await extractViaTikwm(cleanUrl);
    const payload = {
      id: tw.id || String(Date.now()),
      title: tw.title || 'TikTok Video',
      author: tw.author?.nickname || tw.author?.unique_id || 'creator',
      author_name: tw.author?.nickname || 'Creator',
      avatar: `/api/proxy-media?url=${encodeURIComponent(tw.author?.avatar || '')}`,
      cover: `/api/proxy-media?url=${encodeURIComponent(tw.cover || tw.origin_cover || '')}`,
      raw_cover: tw.cover || tw.origin_cover || '',
      duration: tw.duration || 0,
      play_count: tw.play_count || 0,
      like_count: tw.digg_count || 0,
      comment_count: tw.comment_count || 0,
      share_count: tw.share_count || 0,
      resolution: 'Original HD',
      quality: 'Master HD',
      fps: 30,
      clean_url: cleanUrl,
      has_direct_stream: true,
      audio_url: tw.music || tw.music_info?.play || `/api/stream?url=${encodeURIComponent(cleanUrl)}&format=audio`,
      video_stream_url: `/api/stream?url=${encodeURIComponent(cleanUrl)}&format=hd`,
      source: 'Kinetik-TikWM',
    };

    cache.set(cacheKey, payload);
    return res.json({ success: true, data: payload });
  } catch (twErr) {
    console.warn('[KINETIK] TikWM fallback warning:', twErr.message);
  }

  return res.status(500).json({
    success: false,
    error: 'Extraction failed across all pipelines. Video may be private, region-locked, or deleted.',
  });
});

// Live Binary Stream & Relay
app.get('/api/stream', async (req, res) => {
  const { id, url, format = 'hd', download = '0', title = 'tiktok_master' } = req.query;
  const safeFilename = `${title.replace(/[^a-zA-Z0-9_-]/g, '_')}.${format === 'audio' ? 'mp3' : 'mp4'}`;

  if (download === '1') {
    res.setHeader('Content-Disposition', `attachment; filename="${safeFilename}"`);
  } else {
    res.setHeader('Content-Disposition', `inline; filename="${safeFilename}"`);
  }
  res.setHeader('Content-Type', format === 'audio' ? 'audio/mpeg' : 'video/mp4');

  // Check if we have native media stream cached
  const cachedMedia = id ? cache.get(`media_stream:${id}`) : null;
  if (cachedMedia) {
    const targetUrl = format === 'audio' ? cachedMedia.audioUrl : (cachedMedia.downloadAddr || cachedMedia.playAddr);
    if (targetUrl) {
      try {
        const streamRes = await axios.get(targetUrl, {
          responseType: 'stream',
          timeout: 45000,
          headers: {
            'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0.0.0 Safari/537.36',
            'Referer': cachedMedia.cleanUrl,
            'Cookie': cachedMedia.cookies || '',
            'Range': req.headers['range'] || 'bytes=0-',
          },
        });
        if (streamRes.headers['content-range']) {
          res.setHeader('Content-Range', streamRes.headers['content-range']);
          res.status(206);
        }
        if (streamRes.headers['content-length']) {
          res.setHeader('Content-Length', streamRes.headers['content-length']);
        }
        return streamRes.data.pipe(res);
      } catch (err) {
        console.warn('[Stream Relay] Cached relay error, falling back:', err.message);
      }
    }
  }

  // Fallback to yt-dlp stream if available
  const cleanUrl = await resolveCanonicalUrl(url);
  if (!cleanUrl) return res.status(400).send('Invalid TikTok URL');

  let args = ['--no-playlist', '-q', '--no-warnings'];
  if (format === 'audio') {
    args.push('-f', 'bestaudio', '-x', '--audio-format', 'mp3');
  } else {
    args.push('-f', 'best/bestvideo+bestaudio');
  }
  args.push('-o', '-', cleanUrl);

  const proc = spawn(YTDLP_BIN, args);
  proc.stdout.pipe(res);
  proc.on('error', err => {
    console.error('[KINETIK Stream Error]', err.message);
    if (!res.headersSent) res.status(500).end();
  });
  req.on('close', () => {
    try { proc.kill('SIGKILL'); } catch {}
  });
});

// Download Task Handler
app.post('/api/download', async (req, res) => {
  const { url, format = 'hd' } = req.body;
  const cleanUrl = await resolveCanonicalUrl(url);
  if (!cleanUrl) return res.status(400).json({ success: false, error: 'Invalid URL' });

  const fileId = uuidv4().slice(0, 8);
  const ext = format === 'audio' ? 'mp3' : 'mp4';
  const outFileName = `kinetik_${fileId}.${ext}`;
  const outFilePath = path.join(DOWNLOADS_DIR, outFileName);

  // If we have native cached media, stream download directly to file
  const cacheKey = `kinetik_info:${cleanUrl}`;
  const cached = cache.get(cacheKey);
  const cachedMedia = cached?.id ? cache.get(`media_stream:${cached.id}`) : null;

  if (cachedMedia) {
    const targetUrl = format === 'audio' ? cachedMedia.audioUrl : (cachedMedia.downloadAddr || cachedMedia.playAddr);
    if (targetUrl) {
      try {
        const streamRes = await axios.get(targetUrl, {
          responseType: 'stream',
          timeout: 45000,
          headers: {
            'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0.0.0 Safari/537.36',
            'Referer': cleanUrl,
            'Cookie': cachedMedia.cookies || '',
          },
        });
        const fileStream = fs.createWriteStream(outFilePath);
        streamRes.data.pipe(fileStream);
        await new Promise((resolve, reject) => {
          fileStream.on('finish', resolve);
          fileStream.on('error', reject);
        });

        const stat = fs.statSync(outFilePath);
        return res.json({
          success: true,
          download_url: `/downloads/${outFileName}`,
          filename: outFileName,
          size: stat.size,
          format,
        });
      } catch (e) {
        console.warn('[Download Task] Native stream write error, falling back:', e.message);
      }
    }
  }

  // yt-dlp download fallback
  const fmtFlag = format === 'audio'
    ? '-f bestaudio -x --audio-format mp3'
    : '-f "best/bestvideo+bestaudio"';

  const cmd = `"${YTDLP_BIN}" ${fmtFlag} --no-playlist --no-warnings -o "${outFilePath}" "${cleanUrl}"`;

  exec(cmd, { timeout: 90000 }, (err) => {
    if (err || !fs.existsSync(outFilePath)) {
      return res.status(500).json({
        success: false,
        error: 'Engine download task failed. Direct stream fallback is active.',
        fallback_stream: `/api/stream?url=${encodeURIComponent(cleanUrl)}&format=${format}&download=1`
      });
    }

    const stat = fs.statSync(outFilePath);
    res.json({
      success: true,
      download_url: `/downloads/${outFileName}`,
      filename: outFileName,
      size: stat.size,
      format,
    });
  });
});

// Media Proxy (Covers & Avatars with TikTok headers to prevent broken images)
app.get('/api/proxy-media', async (req, res) => {
  const { url } = req.query;
  if (!url) return res.status(400).end();

  try {
    const upstream = await axios.get(url, {
      responseType: 'stream',
      timeout: 15000,
      headers: {
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/130.0',
        'Referer': 'https://www.tiktok.com/',
      }
    });

    res.setHeader('Content-Type', upstream.headers['content-type'] || 'image/jpeg');
    res.setHeader('Cache-Control', 'public, max-age=86400');
    upstream.data.pipe(res);
  } catch {
    res.status(404).end();
  }
});

// Single Page Application Fallback
app.get('*', (_, res) => {
  res.sendFile(path.join(FRONTEND_DIR, 'index.html'));
});

// ─── Initialize Engine ────────────────────────────────────────────────────────
(async () => {
  try {
    await ensureYtdlp();
  } catch (err) {
    console.warn('[KINETIK] Auto-install warning:', err.message);
  }
  YTDLP_BIN = resolveYtdlpBin();

  app.listen(PORT, () => {
    console.log(`\n======================================================`);
    console.log(`  ⚡ KINETIK // TIKTOK HD DEEP-STREAM ENGINE`);
    console.log(`  🌐 Station Live : http://localhost:${PORT}`);
    console.log(`  🔧 Pipeline     : Native JS + ${YTDLP_BIN}`);
    console.log(`  📦 Storage      : ${DOWNLOADS_DIR}`);
    console.log(`======================================================\n`);
  });
})();
