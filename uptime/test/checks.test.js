import assert from 'node:assert/strict';
import http from 'node:http';
import net from 'node:net';
import { after, before, test } from 'node:test';
import { evaluateRows, runCheck } from '../src/checks.js';
import { parseConfig } from '../src/config.js';

let web, webPort, closedPort;

before(async () => {
  web = http.createServer((req, res) => {
    if (req.url === '/health') { res.end('status: ok'); return; }
    if (req.url === '/slow') { setTimeout(() => res.end('ok'), 120); return; }
    res.statusCode = 503; res.end('maintenance');
  });
  await new Promise((r) => web.listen(0, '127.0.0.1', r));
  webPort = web.address().port;
  // Grab a free port, then release it so nothing listens there.
  const tmp = net.createServer();
  await new Promise((r) => tmp.listen(0, '127.0.0.1', r));
  closedPort = tmp.address().port;
  await new Promise((r) => tmp.close(r));
});
after(() => web.close());

const base = { timeoutMs: 2000 };

test('http: up when status and text match', async () => {
  const r = await runCheck({ ...base, type: 'http', url: `http://127.0.0.1:${webPort}/health`, expectText: 'ok' });
  assert.equal(r.status, 'up');
  assert.ok(r.latencyMs >= 0);
});

test('http: down at the http layer on 503', async () => {
  const r = await runCheck({ ...base, type: 'http', url: `http://127.0.0.1:${webPort}/other` });
  assert.equal(r.status, 'down');
  assert.equal(r.layer, 'http');
  assert.match(r.message, /503/);
});

test('http: down at the content layer when text is missing', async () => {
  const r = await runCheck({ ...base, type: 'http', url: `http://127.0.0.1:${webPort}/health`, expectText: 'database: ok' });
  assert.equal(r.layer, 'content');
});

test('http: degraded when slower than slowMs', async () => {
  const r = await runCheck({ ...base, type: 'http', url: `http://127.0.0.1:${webPort}/slow`, slowMs: 50 });
  assert.equal(r.status, 'degraded');
});

test('tcp: up on an open port, down at tcp layer on a closed one', async () => {
  assert.equal((await runCheck({ ...base, type: 'tcp', host: '127.0.0.1', port: webPort })).status, 'up');
  const r = await runCheck({ ...base, type: 'tcp', host: '127.0.0.1', port: closedPort });
  assert.equal(r.status, 'down');
  assert.equal(r.layer, 'tcp');
});

test('sql: a closed port fails at tcp before trying to log in', async () => {
  const r = await runCheck({ ...base, type: 'postgres', host: '127.0.0.1', port: closedPort, user: 'x', password: 'y' });
  assert.equal(r.layer, 'tcp');
});

test('sql: a port that is open but not a database fails at login', async () => {
  const r = await runCheck({ ...base, type: 'mysql', host: '127.0.0.1', port: webPort, user: 'x', password: 'y' });
  assert.equal(r.status, 'down');
  assert.equal(r.layer, 'login');
});

test('evaluateRows: row count and value bounds', () => {
  assert.match(evaluateRows({}, [{ ok: 1 }]).message, /1 แถว/);
  assert.throws(() => evaluateRows({ expectMinRows: 2 }, [{}]), { layer: 'result' });
  assert.throws(() => evaluateRows({ expectValue: { column: 'n', min: 1 } }, [{ n: 0 }]), { layer: 'result' });
  assert.throws(() => evaluateRows({ expectValue: { column: 'lag', max: 30 } }, [{ lag: '45' }]), { layer: 'result' });
  assert.throws(() => evaluateRows({ expectValue: { column: 'missing' } }, [{ n: 1 }]), { layer: 'result' });
  assert.match(evaluateRows({ expectValue: { column: 'n', min: 1, max: 10 } }, [{ n: 5 }]).message, /n = 5/);
});

test('config: env interpolation and validation', () => {
  const cfg = parseConfig({ monitors: [{ id: 'db', type: 'mysql', host: 'h', user: 'u', password: '${PW}' }] }, { PW: 's3cret' });
  assert.equal(cfg.monitors[0].password, 's3cret');
  assert.equal(cfg.monitors[0].failThreshold, 2);
  assert.throws(() => parseConfig({ monitors: [{ id: 'db', type: 'mysql', host: 'h', user: 'u', password: '${NOPE}' }] }, {}), /NOPE/);
  assert.throws(() => parseConfig({ monitors: [{ id: 'x', type: 'ftp', host: 'h' }] }, {}), /type/);
  assert.throws(() => parseConfig({ monitors: [{ id: 'a', type: 'ping', host: 'h' }, { id: 'a', type: 'ping', host: 'h' }] }, {}), /ซ้ำ/);
});
