# Library Management System (LMS)

Full-stack Library & Resource Management System — web version of the C++ LMS project.

**Stack:** Node.js · Express · SQLite · bcrypt auth · Gmail OTP · Google Sign-In

## Features

- Books, DVDs, Audiobooks, Magazines, Newspapers
- Borrow / return with fines and role-based limits
- Admin dashboard, members, donations, reports
- Password hashing (bcrypt)
- Login with **email or username**
- Sign-up with **email OTP verification**
- Google Sign-In (optional)

## Run locally

```bash
git clone https://github.com/smith-willson/website-for-library.git
cd website-for-library
npm install
cp .env.example .env
# Edit .env — add Gmail App Password for OTP emails
npm start
```

Open **http://localhost:3000**

**Demo logins** (seeded on first run):

| User | Password |
|------|----------|
| admin | admin123 |
| ali.khan | pass123 |

Or import C++ CSV data:

```bash
npm run import-csv
```

## Environment variables

Copy `.env.example` to `.env`:

| Variable | Required | Description |
|----------|----------|-------------|
| `SESSION_SECRET` | Yes (production) | Random secret for sessions |
| `GMAIL_USER` | For OTP | Your Gmail address |
| `GMAIL_APP_PASSWORD` | For OTP | [Gmail App Password](https://myaccount.google.com/apppasswords) |
| `GOOGLE_CLIENT_ID` | Optional | Google OAuth Client ID |
| `DATABASE_PATH` | Optional | SQLite file path (default: `./library.db`) |
| `PORT` | Optional | Server port (default: 3000) |

## Deploy to Render (recommended)

1. Push this repo to GitHub (see below).
2. Go to [render.com](https://render.com) → **New** → **Blueprint**.
3. Connect your GitHub repo — Render reads `render.yaml` automatically.
4. Add environment variables in the Render dashboard:
   - `GMAIL_USER`
   - `GMAIL_APP_PASSWORD`
   - `GOOGLE_CLIENT_ID` (optional)
5. Deploy. Your site will be at `https://your-app.onrender.com`.

The included `render.yaml` adds a **1 GB persistent disk** so SQLite data survives restarts.

> **Note:** Render free tier spins down after inactivity (~50 s cold start). Upgrade or use Railway/Fly.io for always-on hosting.

## Deploy to Railway

1. Push to GitHub.
2. Go to [railway.app](https://railway.app) → **New Project** → **Deploy from GitHub**.
3. Set start command: `npm start`
4. Add env vars: `NODE_ENV=production`, `SESSION_SECRET`, `GMAIL_USER`, `GMAIL_APP_PASSWORD`
5. Add a **Volume** mounted at `/data` and set `DATABASE_PATH=/data/library.db`

## Push to GitHub

```bash
cd C:\Users\User\website\lms
git init
git add .
git commit -m "Add full LMS with auth, OTP, and deployment config"
git branch -M main
git remote add origin https://github.com/smith-willson/website-for-library.git
git push -u origin main
```

If the remote already has old code and push is rejected:

```bash
git pull origin main --allow-unrelated-histories
# resolve any conflicts, then:
git push -u origin main
```

## Project structure

```
server.js          Express API + auth routes
db.js              SQLite schema + seed data
auth-utils.js      Password hashing, OTP email, Google auth
public/index.html  Frontend UI
import-csv.js      Import C++ CSV data
render.yaml        Render deployment blueprint
.env.example       Environment template (never commit .env)
```

## License

MIT
