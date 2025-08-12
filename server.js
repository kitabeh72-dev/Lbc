import express from "express";
import basicAuth from "express-basic-auth";
import dotenv from "dotenv";
import path from "path";
import { fileURLToPath } from "url";
import cron from "node-cron";
import Database from "better-sqlite3";
import { nanoid } from "nanoid";
import { chromium } from "playwright";
import cors from "cors";

dotenv.config();

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const app = express();
app.use(cors());
app.use(express.json());
app.use(express.urlencoded({ extended: true }));

// Basic auth for dashboard
const users = {};
if (process.env.DASH_USER && process.env.DASH_PASS) {
  users[process.env.DASH_USER] = process.env.DASH_PASS;
}
app.use(["/","/api","/public"], basicAuth({
  users,
  challenge: true,
  unauthorizedResponse: () => "Unauthorized",
}));

// DB setup
const db = new Database(path.join(__dirname, "data.db"));
db.pragma("journal_mode = WAL");
db.prepare(`
  CREATE TABLE IF NOT EXISTS schedules (
    id TEXT PRIMARY KEY,
    url TEXT NOT NULL,
    period_hours REAL NOT NULL,
    jitter_minutes INTEGER NOT NULL DEFAULT 7,
    next_run INTEGER,
    last_result TEXT,
    active INTEGER NOT NULL DEFAULT 1,
    created_at INTEGER NOT NULL
  )
`).run();

function nowMs(){ return Date.now(); }

function planNextRun(periodHours, jitterMinutes) {
  const base = Math.max(1, Math.floor(periodHours * 60)); // minutes
  const jitter = Math.max(0, jitterMinutes);
  const nextInMinutes = base + Math.floor(Math.random() * jitter);
  return nowMs() + nextInMinutes * 60 * 1000;
}

const insertStmt = db.prepare(`INSERT INTO schedules 
  (id,url,period_hours,jitter_minutes,next_run,last_result,active,created_at)
  VALUES (@id,@url,@period_hours,@jitter_minutes,@next_run,@last_result,@active,@created_at)`);

const updateStmt = db.prepare(`UPDATE schedules SET 
  url=@url, period_hours=@period_hours, jitter_minutes=@jitter_minutes, next_run=@next_run, last_result=@last_result, active=@active
  WHERE id=@id`);

const selectAll = db.prepare(`SELECT * FROM schedules ORDER BY created_at DESC`);
const selectOne = db.prepare(`SELECT * FROM schedules WHERE id = ?`);
const delStmt  = db.prepare(`DELETE FROM schedules WHERE id = ?`);

// --- Playwright automation ---
async function repostOnce(url) {
  // IMPORTANT: This script assumes your Leboncoin session persists between runs.
  // On the first run, it will do a login using email/password from env.
  const email = process.env.LBC_EMAIL;
  const pass = process.env.LBC_PASSWORD;
  if (!email || !pass) {
    throw new Error("Missing LBC_EMAIL or LBC_PASSWORD in environment");
  }

  const browser = await chromium.launch({ headless: true });
  const context = await browser.newContext();
  const page = await context.newPage();
  try {
    // Visit Leboncoin and login if needed
    await page.goto("https://www.leboncoin.fr/");
    // Accept cookies if present
    try {
      await page.getByRole("button", { name: /accepter|tout accepter|j'accepte/i }).click({ timeout: 3000 });
    } catch {}

    // Check if logged in (look for user menu), otherwise login
    const isLogged = await page.locator("a[href*='/compte/'] , [data-qa-id*='header-account']").first().count();
    if (!isLogged) {
      await page.goto("https://www.leboncoin.fr/compte/part/Login");
      await page.getByLabel(/e-mail|email|adresse e-mail/i).fill(email);
      // Try common label for password
      await page.getByLabel(/mot de passe|password/i).fill(pass);
      await page.getByRole("button", { name: /se connecter|connexion|connecter/i }).click();
      // Wait briefly
      await page.waitForTimeout(3000);
    }

    // Go to listing URL
    await page.goto(url, { waitUntil: "domcontentloaded" });
    await page.waitForTimeout(2000);

    // Try click the repost/renew button by text
    const candidates = [
      "Renouveler", "Reposter", "Remonter", "Relancer",
      "Remise en avant", "Remonter l'annonce"
    ];
    let clicked = false;
    for (const label of candidates) {
      const btn = page.getByRole("button", { name: new RegExp(label, "i") });
      if (await btn.count()) {
        await btn.first().click();
        clicked = true; break;
      }
      // Try link role as well
      const link = page.getByRole("link", { name: new RegExp(label, "i") });
      if (await link.count()) {
        await link.first().click();
        clicked = true; break;
      }
    }

    if (!clicked) {
      // fallback: querySelector
      const found = await page.evaluate(() => {
        const re = /(renouveler|reposter|remonter|relancer|remise en avant|remonter l'annonce)/i;
        const els = Array.from(document.querySelectorAll("button, a, div[role='button']"));
        const target = els.find(el => re.test((el.innerText||el.textContent||"").trim()));
        if (target) { target.click(); return true; }
        return false;
      });
      if (!found) throw new Error("Repost button not found");
    }

    // Confirm if modal appears
    await page.waitForTimeout(1500);
    try {
      const confirm = page.getByRole("button", { name: /(confirmer|valider|oui|ok|continuer)/i });
      if (await confirm.count()) await confirm.first().click();
    } catch {}

    // small wait
    await page.waitForTimeout(2500);

    await browser.close();
    return { ok: true, detail: "Clicked repost flow" };
  } catch (err) {
    await browser.close();
    return { ok: false, detail: err?.message || String(err) };
  }
}

// --- Scheduler loop ---
async function runDueJobs() {
  const rows = selectAll.all().filter(r => r.active);
  const now = nowMs();
  for (const row of rows) {
    if (!row.next_run || row.next_run <= now) {
      console.log(`[JOB] Running ${row.id} ${row.url}`);
      const result = await repostOnce(row.url);
      const next = planNextRun(row.period_hours, row.jitter_minutes);
      row.last_result = (result.ok ? "OK: " : "ERR: ") + result.detail;
      row.next_run = next;
      updateStmt.run(row);
    }
  }
}
// Run every 2 minutes
cron.schedule("*/2 * * * *", () => runDueJobs().catch(console.error));

// --- API ---
app.use("/public", express.static(path.join(__dirname, "public")));

app.get("/", (req,res) => res.sendFile(path.join(__dirname, "public/index.html")));

app.get("/api/schedules", (req,res) => {
  res.json({ ok: true, data: selectAll.all() });
});

app.post("/api/schedules", (req,res) => {
  const { url, periodHours, jitterMinutes } = req.body || {};
  if (!url || !/^https:\/\/www\.leboncoin\.fr\//i.test(url)) {
    return res.status(400).json({ ok:false, error: "Invalid Leboncoin URL" });
  }
  const ph = Math.max(1, Number(periodHours || 48));
  const jm = Math.max(0, parseInt(jitterMinutes ?? 7, 10));
  const id = nanoid(10);
  const next = planNextRun(ph, jm);
  const row = {
    id, url, period_hours: ph, jitter_minutes: jm,
    next_run: next, last_result: null, active: 1, created_at: nowMs()
  };
  insertStmt.run(row);
  res.json({ ok: true, id });
});

app.post("/api/schedules/:id/repost-now", async (req,res) => {
  const row = selectOne.get(req.params.id);
  if (!row) return res.status(404).json({ ok:false, error:"Not found" });
  const result = await repostOnce(row.url);
  row.last_result = (result.ok ? "OK: " : "ERR: ") + result.detail;
  row.next_run = planNextRun(row.period_hours, row.jitter_minutes);
  updateStmt.run(row);
  res.json({ ok: true, result });
});

app.post("/api/schedules/:id/toggle", (req,res) => {
  const row = selectOne.get(req.params.id);
  if (!row) return res.status(404).json({ ok:false, error:"Not found" });
  row.active = row.active ? 0 : 1;
  updateStmt.run(row);
  res.json({ ok: true, active: row.active });
});

app.delete("/api/schedules/:id", (req,res) => {
  delStmt.run(req.params.id);
  res.json({ ok: true });
});

const PORT = process.env.PORT || 8080;
app.listen(PORT, () => {
  console.log("Server on http://localhost:"+PORT);
});