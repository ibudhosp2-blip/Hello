import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import express from 'express';
import { runCheck } from './checks.js';
import { describeTarget, loadConfig } from './config.js';
import { openDb } from './db.js';
import { createNotifier } from './notify.js';
import { Scheduler } from './scheduler.js';

const HOUR = 3600 * 1000;
const DAY = 24 * HOUR;

export function createApp({ config, db, scheduler, env = process.env, now = Date.now }) {
  const app = express();
  app.disable('x-powered-by');

  app.get('/healthz', (req, res) => res.json({ ok: true }));

  if (env.DASHBOARD_USER && env.DASHBOARD_PASSWORD) {
    const expected = Buffer.from(`${env.DASHBOARD_USER}:${env.DASHBOARD_PASSWORD}`);
    app.use((req, res, next) => {
      const header = req.headers.authorization || '';
      const given = Buffer.from(header.startsWith('Basic ') ? Buffer.from(header.slice(6), 'base64').toString() : '');
      if (given.length === expected.length && crypto.timingSafeEqual(given, expected)) return next();
      res.set('WWW-Authenticate', 'Basic realm="uptime", charset="UTF-8"').status(401).send('ต้องเข้าสู่ระบบ');
    });
  }

  const publicDir = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'public');
  app.use(express.static(publicDir));

  const byId = new Map(config.monitors.map((m) => [m.id, m]));

  app.get('/api/summary', (req, res) => {
    const t = now();
    const monitors = config.monitors.map((m) => {
      const snap = scheduler.snapshot(m);
      const up = (span) => db.uptime(m.id, t - span, t, t)?.ratio ?? null;
      return {
        id: m.id,
        name: m.name,
        type: m.type,
        target: describeTarget(m),
        intervalSeconds: m.intervalSeconds,
        failThreshold: m.failThreshold,
        slowMs: m.slowMs ?? null,
        ...snap,
        incident: db.currentIncident(m.id) ?? null,
        uptime: { d1: up(DAY), d7: up(7 * DAY), d30: up(30 * DAY) },
        days: db.dailyBars(m.id, 30, t),
      };
    });
    res.json({ now: t, monitors });
  });

  app.get('/api/monitors/:id/latency', (req, res) => {
    const m = byId.get(req.params.id);
    if (!m) return res.status(404).json({ error: 'ไม่พบ monitor นี้' });
    const hours = Math.min(Math.max(Number(req.query.hours) || 24, 1), 24 * 30);
    res.json({ id: m.id, hours, points: db.latency(m.id, now() - hours * HOUR) });
  });

  app.get('/api/incidents', (req, res) => {
    const limit = Math.min(Math.max(Number(req.query.limit) || 50, 1), 500);
    res.json({
      incidents: db.incidents(limit).map((i) => ({ ...i, name: byId.get(i.monitor_id)?.name ?? i.monitor_id })),
    });
  });

  return app;
}

function main() {
  const root = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
  const config = loadConfig(process.env.CONFIG_FILE || path.join(root, 'monitors.json'));
  const dataDir = process.env.DATA_DIR || path.join(root, 'data');
  fs.mkdirSync(dataDir, { recursive: true });
  const db = openDb(path.join(dataDir, 'uptime.db'));
  const notifier = createNotifier();
  const scheduler = new Scheduler({ config, db, notifier, runCheck });
  scheduler.start();

  const port = Number(process.env.PORT) || 3000;
  const server = createApp({ config, db, scheduler }).listen(port, () => {
    console.log(`uptime-watch: ตรวจ ${config.monitors.length} รายการ, dashboard ที่ http://localhost:${port}`);
    if (!notifier.enabled) console.log('ยังไม่ได้ตั้งค่าการแจ้งเตือน (TELEGRAM_* หรือ WEBHOOK_URL)');
  });

  const shutdown = () => {
    scheduler.stop();
    server.close(() => { db.close(); process.exit(0); });
  };
  process.on('SIGINT', shutdown);
  process.on('SIGTERM', shutdown);
}

if (process.argv[1] && fileURLToPath(import.meta.url) === path.resolve(process.argv[1])) {
  try {
    main();
  } catch (err) {
    console.error(err.message);
    process.exit(1);
  }
}
