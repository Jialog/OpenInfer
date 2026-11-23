// The preflight of a device that reports no engine, and which instances of a stopping session need their device's stop:
// an instance whose engine provably never ran (no start sent, no command sent but a prepare the device answered) is
// released at once; any other needs the device's proof that it exited.
import assert from 'node:assert/strict';
import { after, before, test } from 'node:test';
import { randomUUID } from 'node:crypto';

import { ControlPlane } from '../src/control.ts';
import { MemoryObjectStore } from '../src/storage.ts';
import { createDatabase } from './postgres.ts';
import { fixtureCatalog, fixtureError, fixtureProof, inventory, setupPair } from './fixtures.ts';

let database: Awaited<ReturnType<typeof createDatabase>>;
before(async () => { database = await createDatabase(); });
after(async () => { await database.close(); });

const sha = 'a'.repeat(64);

async function prepared(plane: ControlPlane, pair: any) {
  const session = await plane.createSession(pair.user, randomUUID(), pair.plan);
  for (const role of ['service', 'helper']) {
    const prepare = await pair.next(role, 'prepare');
    await pair.result(role, prepare, { manifest_sha256: sha, prepared_version_id: role, build: fixtureProof(prepare.payload.version) });
  }
  return session;
}

const stops = (pair: any) => pair.commands.filter((c: any) => c.kind === 'stop').map((c: any) => c.role);

async function heartbeat(pair: any, role: 'service' | 'helper') {
  await pair.send(role, 'heartbeat', { agent_boot_id: pair.devices[role].boot, inventory: inventory(role), instances: [] });
}

async function states(pair: any, sessionId: string) {
  const session = (await database.pool.query('SELECT state FROM sessions WHERE id=$1', [sessionId])).rows[0].state;
  const devices = await Promise.all(['service', 'helper'].map(async role => (await database.pool.query(
    'SELECT d.state, d.cleanup_required, sd.released_at IS NOT NULL AS released FROM devices d JOIN session_devices sd ON sd.device_id=d.id WHERE d.id=$1 AND sd.session_id=$2',
    [pair.devices[role].id, sessionId])).rows[0]));
  return { session, devices };
}

test('the preflight says a device that runs no engines cannot start a session', async () => {
  const plane = new ControlPlane(database.pool, new MemoryObjectStore(), fixtureCatalog());
  const pair = await setupPair(plane, database.pool);
  await pair.send('helper', 'heartbeat', { agent_boot_id: pair.devices.helper.boot, inventory: { ...inventory('helper'), engines: [] }, instances: [] });
  const checks = (await plane.preflight(pair.user, pair.plan)).checks.filter((c: any) => c.device_id === pair.devices.helper.id);
  const engines = checks.find((c: any) => c.code === 'engines_not_available');
  assert.equal(engines?.passed, false);
  assert.match(engines.message, /reports no engine it can run/);
  assert.equal(checks.some((c: any) => c.code === 'build_preparation_required'), false);   // not a build the user could prepare
});

test('a failed start still needs its stop; the helper that never got a start is released at once', async () => {
  const plane = new ControlPlane(database.pool, new MemoryObjectStore(), fixtureCatalog());
  const pair = await setupPair(plane, database.pool);
  const session = await prepared(plane, pair);
  const start = await pair.next('service', 'start_service');
  await pair.result('service', start, {}, 'failed', fixtureError('instance_failed', pair.devices.service.id, 'load'));
  await plane.dispatch();
  assert.deepEqual(stops(pair), ['service']);                               // the device answered the start: it may have run
  const mid = await states(pair, session.id);
  assert.equal(mid.session, 'stopping');
  assert.deepEqual(mid.devices[1], { state: 'idle', cleanup_required: false, released: true });
  const stop = await pair.next('service', 'stop');
  await pair.result('service', stop, { instances: [await pair.report('service', 'stopped')], ports_free: true });
  assert.deepEqual(await states(pair, session.id), {
    session: 'failed',
    devices: [{ state: 'idle', cleanup_required: false, released: true }, { state: 'idle', cleanup_required: false, released: true }],
  });
});

test('a start that was sent and not refused still needs the stop of its device', async () => {
  const plane = new ControlPlane(database.pool, new MemoryObjectStore(), fixtureCatalog());
  const pair = await setupPair(plane, database.pool);
  const session = await prepared(plane, pair);
  await pair.next('service', 'start_service');                 // acknowledged, no result: whether it ran is unknown
  await plane.stopSession(pair.user, session.id);
  await plane.dispatch();
  assert.deepEqual(pair.commands.filter((c: any) => c.kind === 'stop').map((c: any) => c.role), ['service']);
  const mid = await states(pair, session.id);
  assert.equal(mid.session, 'stopping');
  assert.deepEqual(mid.devices[1], { state: 'idle', cleanup_required: false, released: true });   // the helper never got a start
  const stop = await pair.next('service', 'stop');
  await pair.result('service', stop, { instances: [await pair.report('service', 'stopped')], ports_free: true });
  assert.deepEqual(await states(pair, session.id), {
    session: 'ended',
    devices: [{ state: 'idle', cleanup_required: false, released: true }, { state: 'idle', cleanup_required: false, released: true }],
  });
});

test('a helper whose prepare result comes late, after its stop was sent, is released once it reports the stop', async () => {
  // the serving machine's start fails while the helper downloads; the helper's prepare
  // result comes in late, then the helper answers its stop, as a device that runs engines does
  const plane = new ControlPlane(database.pool, new MemoryObjectStore(), fixtureCatalog());
  const pair = await setupPair(plane, database.pool);
  const session = await plane.createSession(pair.user, randomUUID(), pair.plan);
  const helperPrepare = await pair.next('helper', 'prepare');                // acknowledged, still downloading
  const prepare = await pair.next('service', 'prepare');
  await pair.result('service', prepare, { manifest_sha256: sha, prepared_version_id: 'service', build: fixtureProof(prepare.payload.version) });
  const start = await pair.next('service', 'start_service');
  await pair.result('service', start, {}, 'failed', fixtureError('instance_failed', pair.devices.service.id, 'load'));
  await plane.dispatch();
  assert.deepEqual(stops(pair).sort(), ['helper', 'service']);              // the helper's prepare result is unknown
  await pair.result('helper', helperPrepare, { manifest_sha256: sha, prepared_version_id: 'helper', build: fixtureProof(helperPrepare.payload.version) });
  await plane.dispatch();
  for (const role of ['helper', 'service'] as const) {
    while (pair.commands.some((c: any) => c.role === role && c.kind === 'stop' && !c.used)) {
      const stop = await pair.next(role, 'stop');
      await pair.result(role, stop, { instances: [await pair.report(role, 'stopped')], ports_free: true });
    }
  }
  assert.deepEqual(await states(pair, session.id), {
    session: 'failed',
    devices: [{ state: 'idle', cleanup_required: false, released: true }, { state: 'idle', cleanup_required: false, released: true }],
  });
});

test('a sent start the control plane timed out, with no result from the device, keeps the reservation and the stop', async () => {
  let now = new Date('2026-11-20T12:00:00Z');
  const plane = new ControlPlane(database.pool, new MemoryObjectStore(), { ...fixtureCatalog(), now: () => now });
  const pair = await setupPair(plane, database.pool);
  const session = await prepared(plane, pair);
  await plane.dispatch();                                                     // the start is sent, never acknowledged
  assert.ok(pair.commands.some((c: any) => c.role === 'service' && c.kind === 'start_service'));
  now = new Date(now.getTime() + 20_000);
  await heartbeat(pair, 'service');
  await heartbeat(pair, 'helper');
  now = new Date(now.getTime() + 20_000);                                     // past the acknowledgement deadline
  await heartbeat(pair, 'service');
  await heartbeat(pair, 'helper');
  await plane.tick();
  const start = (await database.pool.query("SELECT state, result, first_sent_at FROM commands WHERE session_id=$1 AND kind='start_service'", [session.id])).rows[0];
  assert.equal(start.state, 'failed');
  assert.equal(start.result, null);
  assert.notEqual(start.first_sent_at, null);
  assert.deepEqual(stops(pair), ['service']);                                 // whether it started is unknown
  const now_ = await states(pair, session.id);
  assert.equal(now_.session, 'stopping');
  assert.deepEqual(now_.devices, [{ state: 'occupied', cleanup_required: false, released: false }, { state: 'idle', cleanup_required: false, released: true }]);
});
