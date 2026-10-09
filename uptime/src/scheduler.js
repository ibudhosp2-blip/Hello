import { tcpProbe } from './checks.js';

export function formatDuration(ms) {
  const min = Math.round(ms / 60000);
  if (min < 1) return 'ไม่ถึง 1 นาที';
  const d = Math.floor(min / 1440), h = Math.floor((min % 1440) / 60), m = min % 60;
  return [d && `${d} วัน`, h && `${h} ชม.`, m && `${m} นาที`].filter(Boolean).join(' ');
}

/**
 * Runs every monitor on its interval and turns raw results into incidents.
 * A monitor is declared down only after `failThreshold` failures in a row,
 * and the incident is back-dated to the first of those failures.
 */
export class Scheduler {
  constructor({ config, db, notifier, runCheck, now = Date.now, canary }) {
    this.config = config;
    this.db = db;
    this.notifier = notifier;
    this.runCheck = runCheck;
    this.now = now;
    this.canary = canary ?? defaultCanary(config.networkCanary);
    this.timers = [];
    this.state = new Map();
    for (const m of config.monitors) {
      const open = db.currentIncident(m.id);
      const last = db.lastCheck(m.id);
      this.state.set(m.id, {
        status: open ? 'down' : last && last.status !== 'down' && last.status !== 'unknown' ? last.status : 'unknown',
        fails: 0,
        firstFailAt: null,
        running: false,
        last: last ? { ts: last.ts, status: last.status, latencyMs: last.latency_ms, layer: last.layer, message: last.message } : null,
      });
    }
  }

  start() {
    this.config.monitors.forEach((m, i) => {
      const first = setTimeout(() => {
        this.tick(m);
        this.timers.push(setInterval(() => this.tick(m), m.intervalSeconds * 1000));
      }, 500 + i * 400);
      this.timers.push(first);
    });
    const prune = () => this.db.prune(this.config.retentionDays, this.now());
    prune();
    this.timers.push(setInterval(prune, 6 * 3600 * 1000));
  }

  stop() {
    this.timers.forEach((t) => { clearTimeout(t); clearInterval(t); });
    this.timers = [];
  }

  async tick(m) {
    const st = this.state.get(m.id);
    if (st.running) return;
    st.running = true;
    try {
      const ts = this.now();
      let r = await this.runCheck(m);
      if (r.status === 'down' && !(await this.canary())) {
        r = { status: 'unknown', latencyMs: null, layer: 'watcher', message: 'เครื่องตรวจเองออกเน็ตไม่ได้ จึงไม่นับผลรอบนี้' };
      }
      this.record(m, ts, r);
    } catch (err) {
      console.error(`[${m.id}] check crashed:`, err);
    } finally {
      st.running = false;
    }
  }

  record(m, ts, r) {
    const st = this.state.get(m.id);
    this.db.insertCheck(m.id, ts, r);
    st.last = { ts, ...r };
    if (r.status === 'unknown') return;

    if (r.status === 'down') {
      st.fails += 1;
      if (st.fails === 1) st.firstFailAt = ts;
      if (st.status !== 'down' && st.fails >= m.failThreshold) {
        st.status = 'down';
        this.db.openIncident(m.id, st.firstFailAt, r.layer, r.message);
        this.notify(`🔴 ${m.name} ล่ม\nชั้นที่ล้มเหลว: ${r.layer}\n${r.message}`, m, 'down');
      }
      return;
    }

    st.fails = 0;
    st.firstFailAt = null;
    if (st.status === 'down') {
      const inc = this.db.currentIncident(m.id);
      this.db.closeIncident(m.id, ts);
      const took = inc ? formatDuration(ts - inc.started_at) : '';
      this.notify(`🟢 ${m.name} กลับมาทำงานแล้ว${took ? ` (ล่มไป ${took})` : ''}\n${r.message}`, m, 'up');
    }
    st.status = r.status;
  }

  notify(text, m, status) {
    Promise.resolve(this.notifier?.send({ text, monitorId: m.id, status }))
      .catch((err) => console.error('notify failed:', err.message));
  }

  /** Current view of one monitor for the API. */
  snapshot(m) {
    const st = this.state.get(m.id);
    return {
      status: st.status,
      pending: st.status !== 'down' && st.fails > 0 ? { fails: st.fails, of: m.failThreshold } : null,
      last: st.last,
    };
  }
}

function defaultCanary(target) {
  if (!target) return async () => true;
  const [host, port] = target.split(':');
  return async () => {
    try {
      await tcpProbe(host, Number(port || 53), 3000);
      return true;
    } catch {
      return false;
    }
  };
}
