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
  const binName = isWin ? 'yt-dlp.exe' : 'yt-dlp';
  const dlUrl = `https://github.com/yt-dlp/yt-dlp/releases/latest/download/${binName}`;

  console.log(`[KINETIK Engine] Fetching ${binName} binary for ${process.platform}...`);

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

// ─── URL Sanitizer ────────────────────────────────────────────────────────────
function sanitizeTiktokUrl(input) {
  if (!input || typeof input !== 'string') return null;
  const trimmed = input.trim();
  const match = trimmed.match(/(https?:\/\/(?:[a-zA-Z0-9_-]+\.)?tiktok\.com\/[^\s]+)/i);
  if (!match) return null;

  try {
    const parsed = new URL(match[1]);
    const cleanUrl = `${parsed.protocol}//${parsed.host}${parsed.pathname}`;
    return cleanUrl;
  } catch {
    return null;
  }
}

// ─── Extraction Engines ───────────────────────────────────────────────────────
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

async function extractViaSavetik(cleanUrl) {
  const resp = await axios.post('https://savetik.co/api/ajaxSearch',
    new URLSearchParams({ q: cleanUrl, lang: 'id' }),
    {
      timeout: 12000,
      headers: {
        'Content-Type': 'application/x-www-form-urlencoded',
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/130.0',
        'Referer': 'https://savetik.co/',
      }
    }
  );
  const html = resp.data?.data || '';
  if (!html || html.length < 120) throw new Error('SaveTik empty response');

  const hdMatch = html.match(/href="(https?:\/\/[^"]+)"[^>]*>(?:[^<]*HD[^<]*|No watermark[^<]*)<\/a>/i);
  const playMatch = html.match(/href="(https?:\/\/[^"]+\.mp4[^"]*)"/i);
  const audioMatch = html.match(/href="(https?:\/\/[^"]+)"[^>]*>(?:MP3|Audio)[^<]*<\/a>/i);
  const thumbMatch = html.match(/src="(https?:\/\/[^"]+(?:\.jpg|\.jpeg|\.webp)[^"]*)"/i);
  const titleMatch = html.match(/<h3[^>]*>([^<]+)<\/h3>/i) || html.match(/class="[^"]*title[^"]*"[^>]*>([^<]+)</i);
  const authorMatch = html.match(/@([\w.]+)/);

  const videoUrl = hdMatch?.[1] || playMatch?.[1];
  if (!videoUrl) throw new Error('SaveTik: No valid stream parsed');

  return {
    id: Date.now().toString(),
    title: titleMatch ? titleMatch[1].trim() : 'TikTok Video',
    author: authorMatch ? authorMatch[1] : 'creator',
    avatar: '',
    cover: thumbMatch ? thumbMatch[1] : '',
    duration: 0,
    play_count: 0, like_count: 0, comment_count: 0, share_count: 0,
    video_url: videoUrl,
    audio_url: audioMatch ? audioMatch[1] : null,
    source: 'savetik',
  };
}

// ─── API Routes ───────────────────────────────────────────────────────────────

// Health & Telemetry
app.get('/api/health', (_, res) => {
  res.json({
    status: 'ONLINE',
    engine: 'KINETIK Deep-Stream Core',
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

  const cleanUrl = sanitizeTiktokUrl(url);
  if (!cleanUrl) {
    return res.status(400).json({ success: false, error: 'Invalid TikTok URL structure.' });
  }

  const cacheKey = `kinetik_info:${cleanUrl}`;
  const cached = cache.get(cacheKey);
  if (cached) {
    return res.json({ success: true, cached: true, data: cached });
  }

  // 1. Primary: yt-dlp Native Extraction
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
    console.warn('[KINETIK] yt-dlp info fallback triggered:', ytErr.message);
  }

  // 2. Secondary: TikWM
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
    console.warn('[KINETIK] TikWM fallback triggered:', twErr.message);
  }

  // 3. Tertiary: SaveTik
  try {
    const st = await extractViaSavetik(cleanUrl);
    const payload = {
      id: st.id,
      title: st.title,
      author: st.author,
      author_name: st.author,
      avatar: '',
      cover: `/api/proxy-media?url=${encodeURIComponent(st.cover)}`,
      raw_cover: st.cover,
      duration: 0,
      play_count: 0, like_count: 0, comment_count: 0, share_count: 0,
      resolution: 'Original HD',
      quality: 'HD Stream',
      fps: 30,
      clean_url: cleanUrl,
      has_direct_stream: true,
      audio_url: st.audio_url || `/api/stream?url=${encodeURIComponent(cleanUrl)}&format=audio`,
      video_stream_url: `/api/stream?url=${encodeURIComponent(cleanUrl)}&format=hd`,
      source: 'Kinetik-SaveTik',
    };

    cache.set(cacheKey, payload);
    return res.json({ success: true, data: payload });
  } catch (stErr) {
    console.error('[KINETIK] All extraction engines failed:', stErr.message);
  }

  return res.status(500).json({
    success: false,
    error: 'Extraction failed across all pipelines. Video may be private or restricted by author.',
  });
});

// Live Binary Stream (Powers in-browser video preview & direct streaming)
app.get('/api/stream', (req, res) => {
  const { url, format = 'hd', download = '0', title = 'tiktok_master' } = req.query;
  const cleanUrl = sanitizeTiktokUrl(url);
  if (!cleanUrl) return res.status(400).send('Invalid TikTok URL');

  const safeFilename = `${title.replace(/[^a-zA-Z0-9_-]/g, '_')}.${format === 'audio' ? 'mp3' : 'mp4'}`;
  
  if (download === '1') {
    res.setHeader('Content-Disposition', `attachment; filename="${safeFilename}"`);
  } else {
    res.setHeader('Content-Disposition', `inline; filename="${safeFilename}"`);
  }
  
  res.setHeader('Content-Type', format === 'audio' ? 'audio/mpeg' : 'video/mp4');
  res.setHeader('Accept-Ranges', 'none');

  let args = ['--no-playlist', '-q', '--no-warnings'];
  if (format === 'audio') {
    args.push('-f', 'bestaudio', '-x', '--audio-format', 'mp3');
  } else {
    args.push('-f', 'best/bestvideo+bestaudio');
  }
  args.push('-o', '-', cleanUrl);

  const proc = spawn(YTDLP_BIN, args);

  proc.stdout.pipe(res);

  proc.stderr.on('data', d => {
    // Suppress non-fatal yt-dlp warnings
  });

  proc.on('error', err => {
    console.error('[KINETIK Stream Error]', err.message);
    if (!res.headersSent) res.status(500).end();
  });

  req.on('close', () => {
    try { proc.kill('SIGKILL'); } catch {}
  });
});

// Local File Generator (Guaranteed reliable browser download link)
app.post('/api/download', async (req, res) => {
  const { url, format = 'hd' } = req.body;
  const cleanUrl = sanitizeTiktokUrl(url);
  if (!cleanUrl) return res.status(400).json({ success: false, error: 'Invalid URL' });

  const fileId = uuidv4().slice(0, 8);
  const ext = format === 'audio' ? 'mp3' : 'mp4';
  const outFileName = `kinetik_${fileId}.${ext}`;
  const outFilePath = path.join(DOWNLOADS_DIR, outFileName);

  const fmtFlag = format === 'audio'
    ? '-f bestaudio -x --audio-format mp3'
    : '-f "best/bestvideo+bestaudio"';

  const cmd = `"${YTDLP_BIN}" ${fmtFlag} --no-playlist --no-warnings -o "${outFilePath}" "${cleanUrl}"`;

  exec(cmd, { timeout: 90000 }, (err) => {
    if (err || !fs.existsSync(outFilePath)) {
      console.error('[KINETIK Download Task Error]', err?.message);
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
    console.log(`  🔧 Pipeline     : ${YTDLP_BIN}`);
    console.log(`  📦 Storage      : ${DOWNLOADS_DIR}`);
    console.log(`======================================================\n`);
  });
})();
