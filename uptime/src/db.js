import { DatabaseSync } from 'node:sqlite';

const DAY = 24 * 3600 * 1000;

export function openDb(file) {
  const db = new DatabaseSync(file);
  db.exec(`
    PRAGMA journal_mode = WAL;
    CREATE TABLE IF NOT EXISTS checks (
      id INTEGER PRIMARY KEY,
      monitor_id TEXT NOT NULL,
      ts INTEGER NOT NULL,
      status TEXT NOT NULL,
      latency_ms INTEGER,
      layer TEXT,
      message TEXT
    );
    CREATE INDEX IF NOT EXISTS checks_monitor_ts ON checks (monitor_id, ts);
    CREATE TABLE IF NOT EXISTS incidents (
      id INTEGER PRIMARY KEY,
      monitor_id TEXT NOT NULL,
      started_at INTEGER NOT NULL,
      ended_at INTEGER,
      layer TEXT,
      reason TEXT
    );
    CREATE INDEX IF NOT EXISTS incidents_monitor_start ON incidents (monitor_id, started_at);
  `);

  const q = {
    insertCheck: db.prepare('INSERT INTO checks (monitor_id, ts, status, latency_ms, layer, message) VALUES (?, ?, ?, ?, ?, ?)'),
    lastCheck: db.prepare('SELECT ts, status, latency_ms, layer, message FROM checks WHERE monitor_id = ? ORDER BY ts DESC LIMIT 1'),
    firstCheck: db.prepare('SELECT MIN(ts) AS ts FROM checks WHERE monitor_id = ?'),
    openIncident: db.prepare('INSERT INTO incidents (monitor_id, started_at, layer, reason) VALUES (?, ?, ?, ?)'),
    currentIncident: db.prepare('SELECT * FROM incidents WHERE monitor_id = ? AND ended_at IS NULL ORDER BY started_at DESC LIMIT 1'),
    closeIncident: db.prepare('UPDATE incidents SET ended_at = ? WHERE monitor_id = ? AND ended_at IS NULL'),
    downtime: db.prepare(`
      SELECT COALESCE(SUM(MIN(COALESCE(ended_at, :now), :to) - MAX(started_at, :from)), 0) AS d
      FROM incidents
      WHERE monitor_id = :m AND started_at < :to AND COALESCE(ended_at, :now) > :from`),
    latency: db.prepare('SELECT ts, status, latency_ms FROM checks WHERE monitor_id = ? AND ts >= ? ORDER BY ts'),
    incidents: db.prepare('SELECT * FROM incidents ORDER BY started_at DESC LIMIT ?'),
    pruneChecks: db.prepare('DELETE FROM checks WHERE ts < ?'),
    pruneIncidents: db.prepare('DELETE FROM incidents WHERE ended_at IS NOT NULL AND ended_at < ?'),
  };

  function downtimeMs(monitorId, from, to, now) {
    return q.downtime.get({ m: monitorId, from, to, now }).d;
  }

  /** Fraction of [from, to) the monitor was not in an incident, or null with no data. */
  function uptime(monitorId, from, to, now = Date.now()) {
    const first = q.firstCheck.get(monitorId).ts;
    if (first == null) return null;
    const start = Math.max(from, first);
    const end = Math.min(to, now);
    if (end <= start) return null;
    const downMs = downtimeMs(monitorId, start, end, now);
    return { ratio: 1 - downMs / (end - start), downMs };
  }

  return {
    close: () => db.close(),
    insertCheck(monitorId, ts, r) {
      q.insertCheck.run(monitorId, ts, r.status, r.latencyMs ?? null, r.layer ?? null, r.message ?? null);
    },
    lastCheck: (monitorId) => q.lastCheck.get(monitorId),
    openIncident(monitorId, startedAt, layer, reason) {
      q.openIncident.run(monitorId, startedAt, layer ?? null, reason ?? null);
    },
    currentIncident: (monitorId) => q.currentIncident.get(monitorId),
    closeIncident(monitorId, endedAt) {
      q.closeIncident.run(endedAt, monitorId);
    },
    uptime,
    /** One entry per local calendar day, oldest first. */
    dailyBars(monitorId, days, now = Date.now()) {
      const midnight = new Date(now);
      midnight.setHours(0, 0, 0, 0);
      const out = [];
      for (let i = days - 1; i >= 0; i--) {
        const start = new Date(midnight); start.setDate(midnight.getDate() - i);
        const end = new Date(start); end.setDate(start.getDate() + 1);
        const u = uptime(monitorId, start.getTime(), end.getTime(), now);
        const y = start.getFullYear(), mo = String(start.getMonth() + 1).padStart(2, '0'), d = String(start.getDate()).padStart(2, '0');
        out.push({ date: `${y}-${mo}-${d}`, uptime: u ? u.ratio : null, downMin: u ? Math.round(u.downMs / 60000) : null });
      }
      return out;
    },
    /** Latency series since `since`, averaged into at most `maxPoints` buckets. */
    latency(monitorId, since, maxPoints = 288) {
      const rows = q.latency.all(monitorId, since);
      if (rows.length <= maxPoints) {
        return rows.map((r) => ({ ts: r.ts, ms: r.latency_ms, down: r.status === 'down' }));
      }
      const size = Math.ceil(rows.length / maxPoints);
      const out = [];
      for (let i = 0; i < rows.length; i += size) {
        const chunk = rows.slice(i, i + size);
        const ok = chunk.filter((r) => r.latency_ms != null);
        out.push({
          ts: chunk[0].ts,
          ms: ok.length ? Math.round(ok.reduce((s, r) => s + r.latency_ms, 0) / ok.length) : null,
          down: chunk.some((r) => r.status === 'down'),
        });
      }
      return out;
    },
    incidents: (limit = 50) => q.incidents.all(limit),
    prune(retentionDays, now = Date.now()) {
      const before = now - retentionDays * DAY;
      q.pruneChecks.run(before);
      q.pruneIncidents.run(before);
    },
  };
}
