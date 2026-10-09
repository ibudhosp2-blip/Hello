// Each check walks the layers a service depends on and reports the first one
// that fails: DNS -> TCP port -> login -> query -> result. "Ping works" only
// proves the first rung; a SQL monitor is "up" only after a real query returns
// the expected result.
import net from 'node:net';
import { spawn } from 'node:child_process';

export class CheckError extends Error {
  constructor(layer, message) {
    super(message);
    this.layer = layer;
  }
}

const NET_ERRORS = {
  ENOTFOUND: ['dns', 'หาชื่อโฮสต์ไม่เจอ (DNS)'],
  EAI_AGAIN: ['dns', 'DNS ไม่ตอบ'],
  ECONNREFUSED: ['tcp', 'พอร์ตปิด ไม่มีบริการรอรับการเชื่อมต่อ'],
  ECONNRESET: ['tcp', 'การเชื่อมต่อถูกตัด'],
  ETIMEDOUT: ['tcp', 'เชื่อมต่อไม่ทันเวลา'],
  EHOSTUNREACH: ['tcp', 'ไปไม่ถึงเครื่องปลายทาง (host unreachable)'],
  ENETUNREACH: ['tcp', 'ไปไม่ถึงเครือข่ายปลายทาง (network unreachable)'],
};

function netError(err, fallbackLayer) {
  const code = err.code || err.cause?.code;
  if (NET_ERRORS[code]) return new CheckError(NET_ERRORS[code][0], `${NET_ERRORS[code][1]} [${code}]`);
  return new CheckError(fallbackLayer, err.message || String(err));
}

function withTimeout(promise, ms, layer, what) {
  let timer;
  const timeout = new Promise((_, reject) => {
    timer = setTimeout(() => reject(new CheckError(layer, `${what}ไม่เสร็จภายใน ${ms} ms`)), ms);
  });
  return Promise.race([promise, timeout]).finally(() => clearTimeout(timer));
}

/** Open and close a TCP connection. Resolves when the port accepts. */
export function tcpProbe(host, port, timeoutMs) {
  return new Promise((resolve, reject) => {
    const socket = net.connect({ host, port });
    const done = (err) => {
      socket.destroy();
      if (err) reject(err); else resolve();
    };
    socket.setTimeout(timeoutMs, () => done(new CheckError('tcp', `พอร์ต ${port} ไม่ตอบภายใน ${timeoutMs} ms`)));
    socket.once('connect', () => done());
    socket.once('error', (err) => done(err instanceof CheckError ? err : netError(err, 'tcp')));
  });
}

async function checkTcp(m) {
  await tcpProbe(m.host, m.port, m.timeoutMs);
  return { message: `พอร์ต ${m.port} เปิดรับการเชื่อมต่อ` };
}

function checkPing(m) {
  const waitSec = String(Math.max(1, Math.ceil(m.timeoutMs / 1000)));
  return new Promise((resolve, reject) => {
    let out = '';
    let child;
    try {
      child = spawn('ping', ['-c', '1', '-W', waitSec, m.host]);
    } catch (err) {
      reject(new CheckError('ping', `เรียกคำสั่ง ping ไม่ได้: ${err.message}`));
      return;
    }
    child.stdout.on('data', (d) => { out += d; });
    child.stderr.on('data', (d) => { out += d; });
    child.on('error', (err) => reject(new CheckError('ping', `เรียกคำสั่ง ping ไม่ได้: ${err.message}`)));
    child.on('close', (code) => {
      if (code === 0) {
        const ms = out.match(/time[=<]([\d.]+)\s*ms/);
        resolve({ message: ms ? `ตอบ ping ใน ${ms[1]} ms` : 'ตอบ ping' });
      } else if (/unknown host|Name or service not known|Temporary failure in name resolution/i.test(out)) {
        reject(new CheckError('dns', 'หาชื่อโฮสต์ไม่เจอ (DNS)'));
      } else {
        reject(new CheckError('ping', 'ไม่ตอบ ping'));
      }
    });
  });
}

async function checkHttp(m) {
  let res;
  try {
    res = await fetch(m.url, {
      method: m.method || 'GET',
      headers: m.headers,
      redirect: 'follow',
      signal: AbortSignal.timeout(m.timeoutMs),
    });
  } catch (err) {
    if (err.name === 'TimeoutError') throw new CheckError('connect', `ไม่ตอบภายใน ${m.timeoutMs} ms`);
    throw netError(err.cause || err, 'connect');
  }
  const okStatus = m.expectStatus ? res.status === m.expectStatus : res.ok;
  if (!okStatus) {
    throw new CheckError('http', `ได้สถานะ HTTP ${res.status}${m.expectStatus ? ` (ต้องการ ${m.expectStatus})` : ''}`);
  }
  if (m.expectText) {
    const body = await res.text();
    if (!body.includes(m.expectText)) throw new CheckError('content', `ไม่พบข้อความ "${m.expectText}" ในคำตอบ`);
  } else {
    await res.arrayBuffer().catch(() => {});
  }
  return { message: `HTTP ${res.status}` };
}

/** Compare query rows against expectMinRows / expectValue from the config. */
export function evaluateRows(m, rows) {
  const n = rows.length;
  if (m.expectMinRows != null && n < m.expectMinRows) {
    throw new CheckError('result', `ได้ ${n} แถว ต้องการอย่างน้อย ${m.expectMinRows}`);
  }
  const ev = m.expectValue;
  if (ev) {
    if (!n) throw new CheckError('result', 'คำสั่งไม่คืนแถวใดเลย');
    const raw = rows[0][ev.column];
    if (raw === undefined) throw new CheckError('result', `ไม่พบคอลัมน์ "${ev.column}" ในผลลัพธ์`);
    const num = Number(raw);
    if (ev.equals !== undefined && String(raw) !== String(ev.equals)) {
      throw new CheckError('result', `${ev.column} = ${raw} ต้องเท่ากับ ${ev.equals}`);
    }
    if (ev.min !== undefined && !(num >= ev.min)) throw new CheckError('result', `${ev.column} = ${raw} ต่ำกว่า ${ev.min}`);
    if (ev.max !== undefined && !(num <= ev.max)) throw new CheckError('result', `${ev.column} = ${raw} สูงกว่า ${ev.max}`);
    return { message: `คำสั่ง SQL สำเร็จ ${ev.column} = ${raw}` };
  }
  return { message: `คำสั่ง SQL สำเร็จ ได้ ${n} แถว` };
}

async function loadDriver(name) {
  try {
    return await import(name);
  } catch {
    throw new CheckError('config', `ยังไม่ได้ติดตั้งไดรเวอร์ ${name} (รัน npm install)`);
  }
}

const SQL_DEFAULT_PORT = { mysql: 3306, postgres: 5432, mssql: 1433 };

const SQL_DRIVERS = {
  async mysql(m) {
    const mysql = (await loadDriver('mysql2/promise')).default;
    let conn;
    try {
      conn = await mysql.createConnection({
        host: m.host, port: m.port, user: m.user, password: m.password, database: m.database,
        connectTimeout: m.timeoutMs, ssl: m.ssl,
      });
    } catch (err) {
      throw new CheckError('login', `${err.code ? err.code + ': ' : ''}${err.message}`);
    }
    try {
      const [rows] = await withTimeout(conn.query({ sql: m.query, timeout: m.timeoutMs }), m.timeoutMs, 'query', 'คำสั่ง SQL ');
      return Array.isArray(rows) ? rows : [];
    } catch (err) {
      throw err instanceof CheckError ? err : new CheckError('query', `${err.code ? err.code + ': ' : ''}${err.message}`);
    } finally {
      conn.end().catch(() => {});
    }
  },

  async postgres(m) {
    const pg = (await loadDriver('pg')).default;
    const client = new pg.Client({
      host: m.host, port: m.port, user: m.user, password: m.password, database: m.database,
      connectionTimeoutMillis: m.timeoutMs, query_timeout: m.timeoutMs, statement_timeout: m.timeoutMs, ssl: m.ssl,
    });
    client.on('error', () => {});
    try {
      await client.connect();
    } catch (err) {
      client.end().catch(() => {});
      throw new CheckError('login', `${err.code ? err.code + ': ' : ''}${err.message}`);
    }
    try {
      const res = await client.query(m.query);
      return res.rows;
    } catch (err) {
      throw new CheckError('query', `${err.code ? err.code + ': ' : ''}${err.message}`);
    } finally {
      client.end().catch(() => {});
    }
  },

  async mssql(m) {
    const sql = (await loadDriver('mssql')).default;
    const pool = new sql.ConnectionPool({
      server: m.host, port: m.port, user: m.user, password: m.password, database: m.database,
      connectionTimeout: m.timeoutMs, requestTimeout: m.timeoutMs,
      pool: { max: 1, min: 0 },
      options: { encrypt: m.encrypt ?? true, trustServerCertificate: m.trustServerCertificate ?? false },
    });
    pool.on('error', () => {});
    try {
      await pool.connect();
    } catch (err) {
      pool.close().catch(() => {});
      throw new CheckError('login', `${err.code ? err.code + ': ' : ''}${err.message}`);
    }
    try {
      const res = await pool.request().query(m.query);
      return res.recordset || [];
    } catch (err) {
      throw new CheckError('query', `${err.code ? err.code + ': ' : ''}${err.message}`);
    } finally {
      pool.close().catch(() => {});
    }
  },
};

async function checkSql(m) {
  const port = m.port || SQL_DEFAULT_PORT[m.type];
  const cfg = { ...m, port, query: m.query || 'SELECT 1 AS ok' };
  // Probe the port first so "server down" and "login rejected" read differently.
  await tcpProbe(cfg.host, port, cfg.timeoutMs);
  const rows = await SQL_DRIVERS[m.type](cfg);
  return evaluateRows(cfg, rows);
}

export const CHECKERS = {
  http: checkHttp,
  tcp: checkTcp,
  ping: checkPing,
  mysql: checkSql,
  postgres: checkSql,
  mssql: checkSql,
};

/**
 * Run one monitor's check.
 * @returns {{status: 'up'|'degraded'|'down', latencyMs: number|null, layer: string|null, message: string}}
 */
export async function runCheck(m) {
  const t0 = performance.now();
  try {
    const checker = CHECKERS[m.type];
    if (!checker) throw new CheckError('config', `ไม่รู้จักชนิด "${m.type}"`);
    const r = await withTimeout(checker(m), m.timeoutMs + 2000, 'timeout', 'การตรวจ');
    const latencyMs = Math.round(performance.now() - t0);
    const slow = m.slowMs != null && latencyMs > m.slowMs;
    return {
      status: slow ? 'degraded' : 'up',
      latencyMs,
      layer: null,
      message: slow ? `${r.message} แต่ช้า (${latencyMs} ms เกินเกณฑ์ ${m.slowMs} ms)` : r.message,
    };
  } catch (err) {
    return {
      status: 'down',
      latencyMs: null,
      layer: err.layer || 'error',
      message: err.message || String(err),
    };
  }
}
