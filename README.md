# Leboncoin Reposter (Web, Self-Hosted)

A private, 24/7 web app that schedules and automatically triggers the "Renouveler / Reposter" flow for your Leboncoin listings. Similar idea to Reposter.io, but you own it.

## Features
- Add multiple listings with independent schedules (hours + jitter).
- Background job runner (every 2 minutes) checks for due tasks.
- Playwright headless browser opens the ad and clicks "Renouveler/Reposter".
- SQLite storage, single binary DB file.
- Basic HTTP auth for the dashboard.
- Works on any host (Dockerfile included).

## Quick Start (Local)
1. **Install Node 18+** (and Docker if you prefer containers).
2. `cp .env.example .env` and fill:
   - `DASH_USER`, `DASH_PASS` (login for the dashboard)
   - `LBC_EMAIL`, `LBC_PASSWORD` (used by the bot)
3. `npm install`
4. `npm start`
5. Open `http://localhost:8080` and log in with your dashboard credentials.

## Deploy with Docker (recommended)
```
docker build -t lbc-reposter .
docker run -d --name lbc -p 8080:8080 --env-file .env -v $PWD/data.db:/app/data.db lbc-reposter
```
> The `postinstall` step installs Chromium & dependencies.

## Render/Railway
- Create a new **Web Service** from this repo or ZIP.
- Set **Start Command** to `npm start`.
- Add env vars from `.env`.
- Make sure the instance has enough memory (~512MB+).

## Notes & Limits
- Keep intervals human-like (24–72h) to reduce flags.
- This does not bypass captchas; if a captcha appears, you may need to log in manually once in the Playwright session.
- If Leboncoin UI changes, you might need to adjust the selectors/text in `server.js` around `repostOnce()`.
- Use at your own risk and review Leboncoin's ToS.

## Security
- Dashboard protected by Basic Auth (`DASH_USER`/`DASH_PASS`).
- No user accounts; single-tenant by design.
- Schedules stored in `data.db` (SQLite) alongside the app.

## API
- `GET /api/schedules` – list all
- `POST /api/schedules { url, periodHours, jitterMinutes }` – add
- `POST /api/schedules/:id/repost-now` – run immediately
- `POST /api/schedules/:id/toggle` – pause/resume
- `DELETE /api/schedules/:id` – delete