'use strict';

const REFRESH_MS = 15000;
const $ = (s, el = document) => el.querySelector(s);

const STATUS = {
  up: { label: 'ทำงานปกติ', icon: 'ok' },
  degraded: { label: 'ทำงานแต่ช้า', icon: 'warn' },
  down: { label: 'ล่ม', icon: 'down' },
  unknown: { label: 'รอผลตรวจ', icon: 'unknown' },
};

// The rungs each check type climbs, in order. The first failing rung is the answer to "what broke?"
const LADDER = {
  http: ['dns', 'connect', 'http', 'content'],
  tcp: ['dns', 'tcp'],
  ping: ['dns', 'ping'],
  mysql: ['dns', 'tcp', 'login', 'query', 'result'],
  postgres: ['dns', 'tcp', 'login', 'query', 'result'],
  mssql: ['dns', 'tcp', 'login', 'query', 'result'],
};
const LAYER_LABEL = {
  dns: 'DNS', connect: 'เชื่อมต่อ', http: 'สถานะ HTTP', content: 'เนื้อหา', tcp: 'พอร์ต', ping: 'Ping',
  login: 'เข้าสู่ระบบ', query: 'รันคำสั่ง SQL', result: 'ผลลัพธ์', timeout: 'หมดเวลา', config: 'การตั้งค่า',
  watcher: 'ตัวตรวจ', error: 'ข้อผิดพลาด',
};
const TYPE_LABEL = { http: 'HTTP', tcp: 'TCP', ping: 'Ping', mysql: 'MySQL', postgres: 'PostgreSQL', mssql: 'SQL Server' };

const ICONS = {
  ok: '<svg class="ico" viewBox="0 0 16 16" aria-hidden="true"><circle cx="8" cy="8" r="7" fill="currentColor"/><path d="M4.5 8.2l2.3 2.3 4.7-4.9" fill="none" stroke="#fff" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"/></svg>',
  warn: '<svg class="ico" viewBox="0 0 16 16" aria-hidden="true"><path d="M8 1.2l7 13H1z" fill="currentColor"/><path d="M8 6v3.6M8 11.6v.4" stroke="#1a1a19" stroke-width="1.7" stroke-linecap="round"/></svg>',
  down: '<svg class="ico" viewBox="0 0 16 16" aria-hidden="true"><circle cx="8" cy="8" r="7" fill="currentColor"/><path d="M5.5 5.5l5 5M10.5 5.5l-5 5" stroke="#fff" stroke-width="1.8" stroke-linecap="round"/></svg>',
  unknown: '<svg class="ico" viewBox="0 0 16 16" aria-hidden="true"><circle cx="8" cy="8" r="6.2" fill="none" stroke="currentColor" stroke-width="1.6"/><circle cx="8" cy="8" r="1.6" fill="currentColor"/></svg>',
  skip: '<svg class="ico" viewBox="0 0 16 16" aria-hidden="true"><path d="M4.5 8h7" stroke="currentColor" stroke-width="1.8" stroke-linecap="round"/></svg>',
};

const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const pct = (r) => (r == null ? '—' : `${(Math.floor(r * 10000) / 100).toFixed(2)}%`);
const fmtDateTime = (ts) => new Date(ts).toLocaleString('th-TH', { dateStyle: 'medium', timeStyle: 'short' });
const fmtTime = (ts) => new Date(ts).toLocaleTimeString('th-TH', { hour: '2-digit', minute: '2-digit' });
function fmtDuration(ms) {
  const min = Math.round(ms / 60000);
  if (min < 1) return 'ไม่ถึง 1 นาที';
  const d = Math.floor(min / 1440), h = Math.floor((min % 1440) / 60), m = min % 60;
  return [d && `${d} วัน`, h && `${h} ชม.`, m && `${m} นาที`].filter(Boolean).join(' ');
}
function fmtDay(iso) {
  const [y, m, d] = iso.split('-').map(Number);
  return new Date(y, m - 1, d).toLocaleDateString('th-TH', { day: 'numeric', month: 'short', year: 'numeric' });
}

/* ---------- tooltip ---------- */
const tip = $('#tip');
function showTip(html, x, y) {
  tip.innerHTML = html;
  tip.hidden = false;
  const r = tip.getBoundingClientRect();
  const left = Math.min(Math.max(8, x - r.width / 2), innerWidth - r.width - 8);
  const top = y - r.height - 12 < 8 ? y + 16 : y - r.height - 12;
  tip.style.left = `${left}px`;
  tip.style.top = `${top}px`;
}
const hideTip = () => { tip.hidden = true; };

/* ---------- pieces ---------- */
function pill(status) {
  const s = STATUS[status] || STATUS.unknown;
  return `<span class="pill s-${esc(status)}">${ICONS[s.icon]}${s.label}</span>`;
}

function ladder(m) {
  const rungs = LADDER[m.type] || [];
  const last = m.last;
  let failAt = -1;
  let extraFail = null;
  if (last && last.status === 'down') {
    failAt = rungs.indexOf(last.layer);
    if (failAt < 0) extraFail = last.layer;
  }
  const items = rungs.map((r, i) => {
    let cls = 'skip';
    if (last && (last.status === 'up' || last.status === 'degraded')) cls = 'ok';
    else if (failAt >= 0) cls = i < failAt ? 'ok' : i === failAt ? 'fail' : 'skip';
    const icon = cls === 'ok' ? ICONS.ok : cls === 'fail' ? ICONS.down : ICONS.skip;
    const sr = cls === 'ok' ? 'ผ่าน' : cls === 'fail' ? 'ล้มเหลว' : 'ไม่ได้ตรวจถึง';
    return `<li class="${cls}">${icon}${esc(LAYER_LABEL[r] || r)}<span class="sr">${sr}</span></li>`;
  });
  if (extraFail) items.push(`<li class="fail">${ICONS.down}${esc(LAYER_LABEL[extraFail] || extraFail)}</li>`);
  return `<p class="ladder-label">ตรวจทีละชั้น</p><ul class="ladder" aria-label="ผลตรวจแต่ละชั้น">${items.join('')}</ul>`;
}

function barClass(u) {
  if (u == null) return '';
  if (u >= 0.99995) return 'good';
  if (u >= 0.99) return 'warn';
  return 'crit';
}

function bars(m) {
  const cells = m.days.map((d) => {
    const label = d.uptime == null ? `${fmtDay(d.date)}: ไม่มีข้อมูล` : `${fmtDay(d.date)}: uptime ${pct(d.uptime)}, ล่ม ${d.downMin} นาที`;
    return `<span class="bar ${barClass(d.uptime)}" tabindex="0" role="img" aria-label="${esc(label)}" data-day="${esc(d.date)}" data-up="${d.uptime ?? ''}" data-down="${d.downMin ?? ''}"></span>`;
  });
  return `
    <div>
      <div class="viz-label"><span>uptime รายวัน 30 วัน</span><span>วันนี้</span></div>
      <div class="bars">${cells.join('')}</div>
      <div class="legend" aria-hidden="true">
        <span><i style="background:var(--good)"></i>100%</span>
        <span><i style="background:var(--warn)"></i>99–99.99%</span>
        <span><i style="background:var(--crit)"></i>ต่ำกว่า 99%</span>
        <span><i style="background:var(--none)"></i>ไม่มีข้อมูล</span>
      </div>
    </div>`;
}

const SPARK_W = 300, SPARK_H = 64, SPARK_PAD = 6;
function sparkline(points, now, hours) {
  const from = now - hours * 3600e3;
  const vals = points.filter((p) => p.ms != null).map((p) => p.ms);
  if (!points.length) return { svg: '', max: null, empty: true };
  const max = Math.max(10, ...vals) * 1.15;
  const x = (ts) => ((ts - from) / (now - from)) * SPARK_W;
  const y = (ms) => SPARK_H - SPARK_PAD - (ms / max) * (SPARK_H - SPARK_PAD * 2);
  const segs = [];
  let cur = [];
  for (const p of points) {
    if (p.ms == null) { if (cur.length) segs.push(cur); cur = []; continue; }
    cur.push([x(p.ts), y(p.ms)]);
  }
  if (cur.length) segs.push(cur);
  const line = segs.map((s) => `M${s.map(([a, b]) => `${a.toFixed(1)},${b.toFixed(1)}`).join('L')}`).join('');
  const area = segs.map((s) => `M${s[0][0].toFixed(1)},${SPARK_H}L${s.map(([a, b]) => `${a.toFixed(1)},${b.toFixed(1)}`).join('L')}L${s[s.length - 1][0].toFixed(1)},${SPARK_H}Z`).join('');
  const downs = points.filter((p) => p.down).map((p) => `<rect class="downmark" x="${(x(p.ts) - 1).toFixed(1)}" y="${SPARK_H - 4}" width="2.5" height="4"/>`).join('');
  return {
    svg: `<svg viewBox="0 0 ${SPARK_W} ${SPARK_H}" preserveAspectRatio="none" aria-hidden="true">
      <line class="grid-line" x1="0" x2="${SPARK_W}" y1="${SPARK_H - 0.5}" y2="${SPARK_H - 0.5}"/>
      <line class="grid-line" x1="0" x2="${SPARK_W}" y1="${SPARK_PAD}" y2="${SPARK_PAD}" stroke-dasharray="2 3"/>
      <path class="area" d="${area}"/><path class="line" d="${line}"/>${downs}
      <line class="cross" x1="0" x2="0" y1="0" y2="${SPARK_H}" visibility="hidden"/>
    </svg>`,
    max: Math.round(max),
    empty: false,
    x, y,
  };
}

function bindSpark(el, points, chart, now, hours) {
  if (chart.empty) return;
  const cross = $('.cross', el);
  const dot = document.createElement('span');
  dot.className = 'dot'; dot.hidden = true; el.appendChild(dot);
  const from = now - hours * 3600e3;
  el.addEventListener('pointermove', (e) => {
    const r = el.getBoundingClientRect();
    const ts = from + ((e.clientX - r.left) / r.width) * (now - from);
    let best = points[0];
    for (const p of points) if (Math.abs(p.ts - ts) < Math.abs(best.ts - ts)) best = p;
    const px = chart.x(best.ts);
    cross.setAttribute('x1', px); cross.setAttribute('x2', px); cross.setAttribute('visibility', 'visible');
    if (best.ms != null) {
      dot.hidden = false;
      dot.style.left = `${(px / SPARK_W) * 100}%`;
      dot.style.top = `${(chart.y(best.ms) / SPARK_H) * 100}%`;
    } else dot.hidden = true;
    showTip(`${fmtTime(best.ts)} · ${best.ms != null ? `<b>${best.ms} ms</b>` : 'ไม่ตอบ'}${best.down ? ' · มีรอบที่ล้มเหลว' : ''}`, e.clientX, r.top);
  });
  el.addEventListener('pointerleave', () => { cross.setAttribute('visibility', 'hidden'); dot.hidden = true; hideTip(); });
}

function card(m, latency, now) {
  const chart = sparkline(latency.points, now, latency.hours);
  const last = m.last;
  const pending = m.pending
    ? `<p class="pending">ตรวจไม่ผ่าน ${m.pending.fails}/${m.pending.of} ครั้งติดกัน กำลังยืนยันก่อนแจ้งว่าล่ม</p>` : '';
  const since = m.incident ? `<p class="pending">ล่มมาแล้ว ${fmtDuration(now - m.incident.started_at)} ตั้งแต่ ${fmtDateTime(m.incident.started_at)}</p>` : '';
  const lastLine = last
    ? `<p class="last">${last.layer ? `<strong>${esc(LAYER_LABEL[last.layer] || last.layer)}:</strong> ` : ''}${esc(last.message)} <time datetime="${new Date(last.ts).toISOString()}">${fmtTime(last.ts)}</time></p>`
    : '<p class="last">ยังไม่มีผลตรวจ</p>';
  const el = document.createElement('article');
  el.className = `card${m.status === 'down' ? ' is-down' : ''}`;
  el.innerHTML = `
    <div class="card-top">
      <div class="card-title">
        <h3>${esc(m.name)}<span class="type">${esc(TYPE_LABEL[m.type] || m.type)}</span></h3>
        <p class="target mono">${esc(m.target)}</p>
      </div>
      ${pill(m.status)}
    </div>
    ${since}${pending}
    <dl class="stats">
      <div><dt>เวลาตอบ</dt><dd>${last && last.latencyMs != null ? `${last.latencyMs} ms` : '—'}</dd></div>
      <div><dt>24 ชม.</dt><dd>${pct(m.uptime.d1)}</dd></div>
      <div><dt>7 วัน</dt><dd>${pct(m.uptime.d7)}</dd></div>
      <div><dt>30 วัน</dt><dd>${pct(m.uptime.d30)}</dd></div>
    </dl>
    <div>${ladder(m)}</div>
    ${bars(m)}
    <div>
      <div class="viz-label"><span>เวลาตอบ ${latency.hours} ชม.ล่าสุด</span><span class="mono">${chart.max != null ? `สูงสุด ${chart.max} ms` : ''}</span></div>
      <div class="spark">${chart.empty ? '<div class="nodata">ยังไม่มีข้อมูล</div>' : chart.svg}</div>
    </div>
    ${lastLine}`;
  bindSpark($('.spark', el), latency.points, chart, now, latency.hours);
  el.querySelectorAll('.bar').forEach((b) => {
    const show = (x, y) => {
      const up = b.dataset.up;
      showTip(up === '' ? `${fmtDay(b.dataset.day)}<br>ไม่มีข้อมูล`
        : `${fmtDay(b.dataset.day)}<br>uptime <b>${pct(Number(up))}</b> · ล่ม <b>${b.dataset.down}</b> นาที`, x, y);
    };
    b.addEventListener('pointerenter', (e) => { const r = b.getBoundingClientRect(); show(r.left + r.width / 2, r.top); });
    b.addEventListener('focus', () => { const r = b.getBoundingClientRect(); show(r.left + r.width / 2, r.top); });
    b.addEventListener('pointerleave', hideTip);
    b.addEventListener('blur', hideTip);
  });
  return el;
}

function renderHeader(monitors, now) {
  const n = { up: 0, degraded: 0, down: 0, unknown: 0 };
  monitors.forEach((m) => { n[m.status] = (n[m.status] || 0) + 1; });
  const h = $('#overall');
  if (n.down) h.textContent = `${n.down} ระบบล่มอยู่`;
  else if (n.degraded) h.textContent = `ทุกระบบตอบ แต่ช้า ${n.degraded} ระบบ`;
  else if (n.unknown === monitors.length) h.textContent = 'กำลังเริ่มตรวจ…';
  else h.textContent = 'ทุกระบบทำงานปกติ';
  document.title = n.down ? `(${n.down} ล่ม) Uptime Watch` : 'Uptime Watch';
  $('#counts').innerHTML = ['up', 'degraded', 'down', 'unknown']
    .filter((k) => n[k])
    .map((k) => `<span class="count s-${k}">${ICONS[STATUS[k].icon]}${STATUS[k].label} <b>${n[k]}</b></span>`).join('');
  $('#updated').textContent = `อัปเดต ${new Date(now).toLocaleTimeString('th-TH')} · รีเฟรชทุก ${REFRESH_MS / 1000} วิ`;
}

function renderIncidents(list, now) {
  const tb = $('#incidents');
  if (!list.length) { tb.innerHTML = '<tr><td colspan="5" class="empty">ยังไม่มีเหตุขัดข้อง</td></tr>'; return; }
  tb.innerHTML = list.map((i) => `
    <tr>
      <td>${esc(i.name)}</td>
      <td class="num">${fmtDateTime(i.started_at)}</td>
      <td class="num">${i.ended_at ? fmtDateTime(i.ended_at) : `<span class="ongoing">${ICONS.down}ยังล่มอยู่</span>`}</td>
      <td class="num">${fmtDuration((i.ended_at || now) - i.started_at)}</td>
      <td>${i.layer ? `<strong>${esc(LAYER_LABEL[i.layer] || i.layer)}</strong> · ` : ''}${esc(i.reason)}</td>
    </tr>`).join('');
}

async function getJSON(url) {
  const res = await fetch(url, { cache: 'no-store' });
  if (!res.ok) throw new Error(`${url} ตอบ ${res.status}`);
  return res.json();
}

async function refresh() {
  try {
    const summary = await getJSON('api/summary');
    const [latencies, inc] = await Promise.all([
      Promise.all(summary.monitors.map((m) => getJSON(`api/monitors/${encodeURIComponent(m.id)}/latency?hours=24`))),
      getJSON('api/incidents?limit=50'),
    ]);
    hideTip();
    renderHeader(summary.monitors, summary.now);
    const grid = $('#monitors');
    grid.replaceChildren(...summary.monitors.map((m, i) => card(m, latencies[i], summary.now)));
    renderIncidents(inc.incidents, summary.now);
  } catch (err) {
    $('#updated').textContent = `โหลดข้อมูลไม่สำเร็จ: ${err.message} · จะลองใหม่ใน ${REFRESH_MS / 1000} วิ`;
  }
}

refresh();
setInterval(refresh, REFRESH_MS);
