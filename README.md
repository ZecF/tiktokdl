# TikSave — Heroku Deployment Guide

## Deploy ke Heroku

### Option A: Via Heroku CLI (Git)

```bash
# Install Heroku CLI → https://devcenter.heroku.com/articles/heroku-cli

# Login
heroku login

# Masuk ke folder ini
cd tiksave-heroku

# Init git + buat app
git init
git add .
git commit -m "initial"

heroku create nama-app-kamu

# Push
git push heroku main

# Buka
heroku open
```

### Option B: Drag & Drop via Heroku Dashboard

1. Buka [dashboard.heroku.com](https://dashboard.heroku.com)
2. Buat New App
3. Di tab **Deploy** → pilih **GitHub** atau **Heroku Git**
4. Upload / connect repo

---

## Environment Variables (Heroku Config Vars)

```
PORT         → diisi otomatis oleh Heroku
NODE_ENV     → production
ALLOWED_ORIGIN → * (atau domain kamu)
```

Set via CLI:
```bash
heroku config:set NODE_ENV=production ALLOWED_ORIGIN=*
```

---

## Catatan Penting

- **yt-dlp** akan di-download otomatis ke `bin/` saat dyno pertama boot (±5 detik)
- File download dihapus otomatis setelah 10 menit
- Heroku free dyno sleep setelah 30 menit idle — gunakan [UptimeRobot](https://uptimerobot.com) agar tetap aktif
- Rate limit: 15 request/menit per IP

## Struktur File

```
tiksave-heroku/
├── server.js          ← Backend Express + 4-layer download API
├── package.json       ← Node deps
├── Procfile           ← "web: node server.js"
├── .gitignore
├── .env.example       ← Template env vars
├── frontend/
│   ├── index.html
│   ├── style.css
│   └── app.js
└── downloads/         ← Temp files (auto-clean, gitignored)
```
