import assert from 'node:assert/strict';
import { test } from 'node:test';
import { openDb } from '../src/db.js';
import { Scheduler } from '../src/scheduler.js';

const MIN = 60000;

function setup({ canaryOk = true } = {}) {
  const db = openDb(':memory:');
  const sent = [];
  let clock = Date.UTC(2026, 9, 9, 3, 0);
  let next = { status: 'up', latencyMs: 20, layer: null, message: 'ok' };
  const m = { id: 'db', name: 'ฐานข้อมูล', type: 'mysql', failThreshold: 2, intervalSeconds: 60 };
  const scheduler = new Scheduler({
    config: { monitors: [m], retentionDays: 30 },
    db,
    notifier: { send: (msg) => sent.push(msg) },
    runCheck: async () => next,
    now: () => clock,
    canary: async () => canaryOk,
  });
  return {
    db, sent, m, scheduler,
    async tick(result) { next = result; await scheduler.tick(m); clock += MIN; },
    get clock() { return clock; },
  };
}
const DOWN = { status: 'down', latencyMs: null, layer: 'login', message: 'Access denied' };
const UP = { status: 'up', latencyMs: 20, layer: null, message: 'ok' };

test('one failure is not an incident; two in a row are, back-dated to the first', async () => {
  const s = setup();
  await s.tick(UP);
  const firstFail = s.clock;
  await s.tick(DOWN);
  assert.equal(s.scheduler.snapshot(s.m).status, 'up');
  assert.deepEqual(s.scheduler.snapshot(s.m).pending, { fails: 1, of: 2 });
  assert.equal(s.db.currentIncident('db'), undefined);

  await s.tick(DOWN);
  assert.equal(s.scheduler.snapshot(s.m).status, 'down');
  const inc = s.db.currentIncident('db');
  assert.equal(inc.started_at, firstFail);
  assert.equal(inc.layer, 'login');
  assert.equal(s.sent.length, 1);
  assert.match(s.sent[0].text, /ล่ม/);
});

test('recovery closes the incident, reports duration, and uptime reflects it', async () => {
  const s = setup();
  const start = s.clock;
  for (let i = 0; i < 5; i++) await s.tick(UP);
  await s.tick(DOWN); await s.tick(DOWN); await s.tick(DOWN);
  await s.tick(UP);
  for (let i = 0; i < 1; i++) await s.tick(UP);
  assert.equal(s.scheduler.snapshot(s.m).status, 'up');
  assert.equal(s.db.currentIncident('db'), undefined);
  assert.equal(s.sent.length, 2);
  assert.match(s.sent[1].text, /3 นาที/);
  // 10 minutes observed, 3 of them down
  const u = s.db.uptime('db', start, s.clock, s.clock);
  assert.equal(Math.round(u.ratio * 1000) / 1000, 0.7);
});

test('a single blip between successes never opens an incident', async () => {
  const s = setup();
  await s.tick(UP); await s.tick(DOWN); await s.tick(UP); await s.tick(DOWN); await s.tick(UP);
  assert.equal(s.db.incidents().length, 0);
  assert.equal(s.sent.length, 0);
});

test('when the watcher itself is offline, failures are not counted', async () => {
  const s = setup({ canaryOk: false });
  await s.tick(UP); await s.tick(DOWN); await s.tick(DOWN); await s.tick(DOWN);
  assert.equal(s.db.incidents().length, 0);
  assert.equal(s.scheduler.snapshot(s.m).last.layer, 'watcher');
});
