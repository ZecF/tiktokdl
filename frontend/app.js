/* ─────────────────────────────────────────────────────────────────────────
   TikSave — app.js
   Frontend logic: fetch info, render result, handle downloads safely
───────────────────────────────────────────────────────────────────────── */

const API_BASE = window.location.origin;

// ── DOM refs ──────────────────────────────────────────────────────────────
const urlInput      = document.getElementById('urlInput');
const clearBtn      = document.getElementById('clearBtn');
const fetchBtn      = document.getElementById('fetchBtn');
const loadingState  = document.getElementById('loadingState');
const loadingText   = document.getElementById('loadingText');
const errorState    = document.getElementById('errorState');
const errorMsg      = document.getElementById('errorMsg');
const retryBtn      = document.getElementById('retryBtn');
const resultSection = document.getElementById('resultSection');
const downloadGrid  = document.getElementById('downloadGrid');

// Meta elements
const videoThumb    = document.getElementById('videoThumb');
const thumbDuration = document.getElementById('thumbDuration');
const authorAvatar  = document.getElementById('authorAvatar');
const authorName    = document.getElementById('authorName');
const videoTitle    = document.getElementById('videoTitle');
const statViews     = document.getElementById('statViews');
const statLikes     = document.getElementById('statLikes');
const statComments  = document.getElementById('statComments');
const statShares    = document.getElementById('statShares');
const musicInfo     = document.getElementById('musicInfo');

// ── State ─────────────────────────────────────────────────────────────────
let lastUrl   = '';
let lastData  = null;

// ── Helpers ───────────────────────────────────────────────────────────────
function extractTiktokLink(text) {
  if (!text || typeof text !== 'string') return null;
  const m = text.match(/(https?:\/\/(?:[a-zA-Z0-9_-]+\.)?tiktok\.com\/[^\s?#]+|(?:vt|vm|wm|m|www)?\.?tiktok\.com\/[^\s?#]+)/i);
  if (!m) return null;
  let u = m[1];
  if (!u.startsWith('http://') && !u.startsWith('https://')) {
    u = 'https://' + u;
  }
  return u;
}

function fmtNum(n) {
  if (!n) return '0';
  const num = Number(n);
  if (num >= 1_000_000) return (num / 1_000_000).toFixed(1) + 'M';
  if (num >= 1_000)     return (num / 1_000).toFixed(1) + 'K';
  return num.toLocaleString();
}

function fmtDuration(secs) {
  if (!secs) return '0:00';
  const m = Math.floor(secs / 60);
  const s = String(Math.floor(secs % 60)).padStart(2, '0');
  return `${m}:${s}`;
}

function showSection(name) {
  loadingState.classList.add('hidden');
  errorState.classList.add('hidden');
  resultSection.classList.add('hidden');
  if (name === 'loading') loadingState.classList.remove('hidden');
  if (name === 'error')   errorState.classList.remove('hidden');
  if (name === 'result')  resultSection.classList.remove('hidden');
}

function hideAll() {
  loadingState.classList.add('hidden');
  errorState.classList.add('hidden');
  resultSection.classList.add('hidden');
}

// ── Toast ─────────────────────────────────────────────────────────────────
let toastWrap = null;
function getToastWrap() {
  if (!toastWrap) {
    toastWrap = document.createElement('div');
    toastWrap.className = 'toast-wrap';
    document.body.appendChild(toastWrap);
  }
  return toastWrap;
}

function toast(msg, type = 'success', dur = 3500) {
  const wrap = getToastWrap();
  const el = document.createElement('div');
  el.className = `toast toast--${type}`;
  el.innerHTML = `<div class="toast__dot"></div><span>${msg}</span>`;
  wrap.appendChild(el);
  setTimeout(() => {
    el.style.opacity = '0';
    el.style.transform = 'translateY(6px)';
    el.style.transition = 'all 0.25s ease';
    setTimeout(() => el.remove(), 300);
  }, dur);
}

// ── Clear button ──────────────────────────────────────────────────────────
urlInput.addEventListener('input', () => {
  clearBtn.classList.toggle('visible', urlInput.value.length > 0);
});

clearBtn.addEventListener('click', () => {
  urlInput.value = '';
  clearBtn.classList.remove('visible');
  urlInput.focus();
  hideAll();
});

// ── Ctrl+V global paste ───────────────────────────────────────────────────
document.addEventListener('keydown', async (e) => {
  if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'v' && document.activeElement !== urlInput) {
    try {
      const text = await navigator.clipboard.readText();
      const extracted = extractTiktokLink(text);
      if (extracted) {
        urlInput.value = extracted;
        clearBtn.classList.add('visible');
        toast('Link TikTok ter-paste!', 'success', 2000);
        fetchVideo();
      }
    } catch { /* clipboard permission */ }
  }
});

// ── Enter key ─────────────────────────────────────────────────────────────
urlInput.addEventListener('keydown', (e) => {
  if (e.key === 'Enter') fetchVideo();
});

// ── Fetch button ──────────────────────────────────────────────────────────
fetchBtn.addEventListener('click', fetchVideo);
retryBtn.addEventListener('click', () => { if (lastUrl) fetchVideo(); });

// ── Icons for buttons ─────────────────────────────────────────────────────
const ICONS = {
  hd: `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
        <rect x="2" y="6" width="20" height="12" rx="2"/>
        <path d="M7 9v6M7 12h4M11 9v6M17 9v6h-2l-2-3v3"/>
       </svg>`,
  sd: `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
        <rect x="2" y="6" width="20" height="12" rx="2"/>
        <path d="M7 9v6M7 12h4M11 9v6"/>
       </svg>`,
  audio: `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
            <path d="M9 18V5l12-2v13"/>
            <circle cx="6" cy="18" r="3"/><circle cx="18" cy="16" r="3"/>
          </svg>`,
  wm: `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
        <polygon points="23 7 16 12 23 17 23 7"/><rect x="1" y="5" width="15" height="14" rx="2"/>
       </svg>`,
};

// ── Safe Downloader (Bypasses Akamai 403 "Access Denied") ──────────────────
async function triggerSafeDownload(format, label) {
  toast(`Menyiapkan download ${label}...`, 'success');

  try {
    const res = await fetch(`${API_BASE}/api/download`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ url: lastUrl, format }),
    });

    const json = await res.json();
    if (json.success && json.download_url) {
      // Direct local download from our server (zero 403)
      const a = document.createElement('a');
      a.href = `${API_BASE}${json.download_url}`;
      a.download = json.filename || `tiktok_${format}.mp4`;
      document.body.appendChild(a);
      a.click();
      a.remove();
      toast(`Download ${label} berhasil dimulai!`, 'success');
      return;
    }
  } catch (err) {
    console.warn('Fallback to stream download:', err);
  }

  // Stream fallback with attachment header
  const streamUrl = `${API_BASE}/api/stream?url=${encodeURIComponent(lastUrl)}&format=${format}&download=1&title=tiktok_${format}`;
  window.location.href = streamUrl;
  toast(`Download ${label} via streaming relay...`, 'success');
}

// ── Build download button ─────────────────────────────────────────────────
function buildDlBtn({ variant, label, sub, format, icon }) {
  const btn = document.createElement('button');
  btn.type = 'button';
  btn.className = `dl-btn dl-btn--${variant}`;

  btn.innerHTML = `
    <div class="dl-btn__icon-wrap">
      ${icon}
    </div>
    <div class="dl-btn__info">
      <span class="dl-btn__label">${label}</span>
      <span class="dl-btn__sub">${sub}</span>
    </div>
    <svg class="dl-btn__arrow" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5">
      <path d="M12 5v14M5 12l7 7 7-7"/>
    </svg>
  `;

  btn.addEventListener('click', (e) => {
    e.preventDefault();
    triggerSafeDownload(format, label);
  });

  return btn;
}

// ── Render result ─────────────────────────────────────────────────────────
function renderResult(data) {
  lastData = data;

  // Thumbnail
  if (data.cover) {
    videoThumb.src = data.cover;
    videoThumb.style.display = 'block';
    videoThumb.onerror = () => {
      // Fallback to raw cover if proxy fails
      if (data.raw_cover && videoThumb.src !== data.raw_cover) {
        videoThumb.src = data.raw_cover;
      }
    };
  }
  thumbDuration.textContent = fmtDuration(data.duration);

  // Author
  if (data.avatar) authorAvatar.src = data.avatar;
  authorName.textContent = '@' + (data.author || 'creator');

  // Title
  videoTitle.textContent = data.title || 'TikTok Video';

  // Stats
  statViews.textContent    = fmtNum(data.play_count);
  statLikes.textContent    = fmtNum(data.like_count);
  statComments.textContent = fmtNum(data.comment_count);
  statShares.textContent   = fmtNum(data.share_count);

  // Music
  if (data.music_title) {
    musicInfo.textContent = `${data.music_title}${data.music_author ? ' — ' + data.music_author : ''}`;
  } else {
    musicInfo.textContent = 'Original Audio';
  }

  // Build download buttons
  downloadGrid.innerHTML = '';

  // 1. HD No Watermark (Master)
  downloadGrid.appendChild(buildDlBtn({
    variant: 'hd',
    label: 'HD No Watermark',
    sub: 'Kualitas terbaik 1080p · MP4',
    format: 'hd',
    icon: ICONS.hd,
  }));

  // 2. SD No Watermark
  downloadGrid.appendChild(buildDlBtn({
    variant: 'sd',
    label: 'SD No Watermark',
    sub: 'Ukuran lebih kecil · MP4',
    format: 'hd',
    icon: ICONS.sd,
  }));

  // 3. Audio MP3
  downloadGrid.appendChild(buildDlBtn({
    variant: 'audio',
    label: 'Audio MP3',
    sub: 'Hanya suara jernih · MP3',
    format: 'audio',
    icon: ICONS.audio,
  }));

  // 4. Download Cover
  if (data.cover || data.raw_cover) {
    const coverBtn = document.createElement('a');
    coverBtn.className = 'dl-btn dl-btn--wm';
    coverBtn.href = data.cover || data.raw_cover;
    coverBtn.target = '_blank';
    coverBtn.download = `cover_${data.id || 'tiktok'}.jpg`;
    coverBtn.innerHTML = `
      <div class="dl-btn__icon-wrap">
        ${ICONS.wm}
      </div>
      <div class="dl-btn__info">
        <span class="dl-btn__label">Download Cover</span>
        <span class="dl-btn__sub">Gambar thumbnail HD</span>
      </div>
      <svg class="dl-btn__arrow" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5">
        <path d="M12 5v14M5 12l7 7 7-7"/>
      </svg>
    `;
    downloadGrid.appendChild(coverBtn);
  }

  showSection('result');
  setTimeout(() => resultSection.scrollIntoView({ behavior: 'smooth', block: 'nearest' }), 100);
}

// ── Main fetch ────────────────────────────────────────────────────────────
async function fetchVideo() {
  const raw = urlInput.value.trim();
  if (!raw) {
    toast('Masukkan link TikTok terlebih dahulu.', 'error');
    urlInput.focus();
    return;
  }

  const cleanLink = extractTiktokLink(raw);
  if (!cleanLink) {
    toast('URL tidak valid. Masukkan link tiktok.com, vt.tiktok, atau wm.tiktok.', 'error');
    return;
  }

  // Update input with clean extracted URL
  urlInput.value = cleanLink;
  lastUrl = cleanLink;
  showSection('loading');
  fetchBtn.disabled = true;
  fetchBtn.classList.add('loading');
  fetchBtn.querySelector('.fetch-btn__text').textContent = 'Memuat...';

  const msgs = [
    'Mengambil informasi video...',
    'Menghubungi server TikTok...',
    'Memproses stream no watermark...',
  ];
  let mi = 0;
  const msgInterval = setInterval(() => {
    mi = (mi + 1) % msgs.length;
    loadingText.textContent = msgs[mi];
  }, 1600);

  try {
    const res = await fetch(`${API_BASE}/api/info`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ url: cleanLink }),
    });

    const json = await res.json();
    clearInterval(msgInterval);

    if (!json.success || !json.data) {
      throw new Error(json.error || 'Gagal mengambil video. Pastikan video publik.');
    }

    renderResult(json.data);
    if (json.cached) toast('Data dari cache (instan)', 'success', 2000);
  } catch (err) {
    clearInterval(msgInterval);
    errorMsg.textContent = err.message || 'Terjadi kesalahan. Coba lagi.';
    showSection('error');
  } finally {
    fetchBtn.disabled = false;
    fetchBtn.classList.remove('loading');
    fetchBtn.querySelector('.fetch-btn__text').textContent = 'Ambil Video';
  }
}

// ── Auto-detect paste into page ───────────────────────────────────────────
document.addEventListener('paste', (e) => {
  const text = (e.clipboardData || window.clipboardData).getData('text');
  const extracted = extractTiktokLink(text);
  if (extracted && document.activeElement !== urlInput) {
    urlInput.value = extracted;
    clearBtn.classList.add('visible');
    toast('Link TikTok terdeteksi! Mengambil video...', 'success', 2500);
    fetchVideo();
  }
});
