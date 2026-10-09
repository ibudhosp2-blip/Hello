import fs from 'node:fs';

const TYPES = ['http', 'tcp', 'ping', 'mysql', 'postgres', 'mssql'];
const SQL_TYPES = ['mysql', 'postgres', 'mssql'];

/** Replace ${VAR} in every string with the environment value, so secrets stay out of the file. */
function interpolate(value, env, where) {
  if (typeof value === 'string') {
    return value.replace(/\$\{(\w+)\}/g, (_, name) => {
      if (env[name] === undefined) throw new Error(`${where}: ไม่ได้ตั้งค่า environment variable ${name}`);
      return env[name];
    });
  }
  if (Array.isArray(value)) return value.map((v) => interpolate(v, env, where));
  if (value && typeof value === 'object') {
    return Object.fromEntries(Object.entries(value).map(([k, v]) => [k, interpolate(v, env, where)]));
  }
  return value;
}

export function parseConfig(raw, env = process.env) {
  const cfg = {
    intervalSeconds: raw.intervalSeconds ?? 60,
    timeoutMs: raw.timeoutMs ?? 10000,
    failThreshold: raw.failThreshold ?? 2,
    retentionDays: raw.retentionDays ?? 90,
    networkCanary: raw.networkCanary ?? null,
    monitors: [],
  };
  if (!Array.isArray(raw.monitors) || raw.monitors.length === 0) throw new Error('config: ต้องมี monitors อย่างน้อย 1 รายการ');
  const ids = new Set();
  for (const [i, m0] of raw.monitors.entries()) {
    const where = `monitors[${i}]${m0.id ? ` (${m0.id})` : ''}`;
    const m = interpolate(m0, env, where);
    if (!m.id || !/^[\w-]+$/.test(m.id)) throw new Error(`${where}: id ต้องเป็นตัวอักษร ตัวเลข - หรือ _`);
    if (ids.has(m.id)) throw new Error(`${where}: id ซ้ำ`);
    ids.add(m.id);
    if (!TYPES.includes(m.type)) throw new Error(`${where}: type ต้องเป็นหนึ่งใน ${TYPES.join(', ')}`);
    if (m.type === 'http' && !m.url) throw new Error(`${where}: ต้องมี url`);
    if (m.type !== 'http' && !m.host) throw new Error(`${where}: ต้องมี host`);
    if (m.type === 'tcp' && !m.port) throw new Error(`${where}: ต้องมี port`);
    if (SQL_TYPES.includes(m.type) && !m.user) throw new Error(`${where}: ต้องมี user สำหรับเข้าฐานข้อมูล`);
    cfg.monitors.push({
      name: m.id,
      intervalSeconds: cfg.intervalSeconds,
      timeoutMs: cfg.timeoutMs,
      failThreshold: cfg.failThreshold,
      ...m,
    });
  }
  return cfg;
}

export function loadConfig(file, env = process.env) {
  let text;
  try {
    text = fs.readFileSync(file, 'utf8');
  } catch {
    throw new Error(`อ่านไฟล์ตั้งค่าไม่ได้: ${file} (คัดลอกจาก monitors.example.json)`);
  }
  return parseConfig(JSON.parse(text), env);
}

/** What the dashboard may show about a monitor: never credentials. */
export function describeTarget(m) {
  if (m.type === 'http') {
    try {
      const u = new URL(m.url);
      u.username = ''; u.password = '';
      return u.toString();
    } catch {
      return m.url;
    }
  }
  if (m.type === 'ping') return m.host;
  const port = m.port || { mysql: 3306, postgres: 5432, mssql: 1433 }[m.type];
  return `${m.host}:${port}${m.database ? ` / ${m.database}` : ''}`;
}
