import { randomUUID } from 'node:crypto';
import assert from 'node:assert/strict';
import { after, before, test } from 'node:test';

import { ControlPlane } from '../src/control.ts';
import { EMPTY_TIMING } from '../src/protocol.ts';
import { MemoryObjectStore } from '../src/storage.ts';
import { createDatabase } from './postgres.ts';
import { fixtureCatalog, fixtureProof, fixtureError, inventory, setupPair, startSession } from './fixtures.ts';

let db: Awaited<ReturnType<typeof createDatabase>>;
before(async () => { db = await createDatabase(); });
after(async () => db.close());

test('X1 command results are accepted only from the command device', async () => {
  const plane = new ControlPlane(db.pool, new MemoryObjectStore(), fixtureCatalog());
  const pair = await setupPair(plane, db.pool);
  await plane.createSession(pair.user, randomUUID(), pair.plan);
  const command = await pair.next('service', 'prepare');

  await assert.rejects(pair.result('helper', command, {
    manifest_sha256: 'a'.repeat(64),
    prepared_version_id: 'service',
    build: fixtureProof(command.payload.version),
  }), /forbidden/);
  const saved = (await db.pool.query('SELECT state,result FROM commands WHERE id=$1', [command.command_id])).rows[0];
  assert.equal(saved.state, 'executing');
  assert.equal(saved.result, null);
});

test('X2 request reports are accepted only from the owning device and instance', async () => {
  const plane = new ControlPlane(db.pool, new MemoryObjectStore(), fixtureCatalog());
  const pair = await setupPair(plane, db.pool);
  const session = await startSession(plane, pair);
  const request = await plane.submitRequest(pair.user, session.id, randomUUID(), { prompt: 'ownership' });
  const run = await pair.next('service', 'run_request');
  const instance = pair.commandRef('service', run);

  await assert.rejects(pair.send('helper', 'request.accepted', {
    request_id: request.id,
    instance_id: instance.instance_id,
    prompt_tokens: 1,
    effective_max_output: 4095,
    committed_position: '1',
    timing: { ...EMPTY_TIMING, clock_id: instance.instance_id, engine_received_ns: '0' },
  }), /instance_mismatch/);
  assert.equal((await db.pool.query('SELECT accepted_report FROM requests WHERE id=$1', [request.id])).rows[0].accepted_report, null);
});

test('X3 messages from a superseded control connection are rejected', async () => {
  const plane = new ControlPlane(db.pool, new MemoryObjectStore(), fixtureCatalog());
  const pair = await setupPair(plane, db.pool);
  const oldConnection = pair.devices.service.connection;
  const nextConnection = await pair.reopen('service');
  await pair.send('service', 'reconcile', {
    agent_boot_id: pair.devices.service.boot,
    inventory: inventory('service'),
    instances: [], commands: [], requests: [],
  });
  assert.notEqual(nextConnection, oldConnection);

  await assert.rejects(plane.handleDevice(pair.devices.service.id, oldConnection, 'heartbeat', {
    agent_boot_id: pair.devices.service.boot,
    inventory: inventory('service'),
    instances: [],
  }), /credential_revoked/);
});

test('X4 removal requires an offline device to be marked cleanup_required', async () => {
  let now = new Date('2026-11-09T01:00:00Z');
  const plane = new ControlPlane(db.pool, new MemoryObjectStore(), { ...fixtureCatalog(), now: () => now });
  const pair = await setupPair(plane, db.pool);
  await plane.closeDevice(pair.devices.helper.id, pair.devices.helper.connection);
  now = new Date(now.getTime() + 30_001);
  await plane.tick();
  const before = await plane.getDevice(pair.user, pair.devices.helper.id);
  assert.equal(before.state, 'offline');
  assert.equal(before.cleanup_required, false);

  await assert.rejects(plane.removeDevice(pair.user, pair.devices.helper.id, true), /device_busy/);
  assert.equal((await plane.getDevice(pair.user, pair.devices.helper.id)).state, 'offline');
});

test('X5 peer status requires the reported instance to belong to the sender', async () => {
  const plane = new ControlPlane(db.pool, new MemoryObjectStore(), fixtureCatalog());
  const first = await setupPair(plane, db.pool);
  await startSession(plane, first);
  const local = Array.from(first.devices.helper.instances.values()).at(-1) as any;
  const before = (await db.pool.query('SELECT push_connection_id FROM instances WHERE id=$1', [local.instance_id])).rows[0].push_connection_id;

  await assert.rejects(first.send('service', 'peer.status', {
    session_id: local.session_id,
    instance_id: local.instance_id,
    writer_id: local.instance_id,
    connection_generation: 1,
    push_connection_id: randomUUID(),
    state: 'connected', authenticated: true, error: null,
  }), /instance_mismatch/);
  assert.equal((await db.pool.query('SELECT push_connection_id FROM instances WHERE id=$1', [local.instance_id])).rows[0].push_connection_id, before);
});

test('X7 completing a non-reconnect stop does not start a replacement', async () => {
  const plane = new ControlPlane(db.pool, new MemoryObjectStore(), fixtureCatalog());
  const pair = await setupPair(plane, db.pool);
  const session = await startSession(plane, pair);
  await pair.peer(false);
  assert.equal((await plane.getSession(pair.user, session.id)).state, 'degraded');
  await pair.status('helper', 'failed');
  const stop = await pair.next('helper', 'stop');
  const preparesBefore = pair.commands.filter((x: any) => x.role === 'helper' && x.kind === 'prepare').length;
  await pair.result('helper', stop, { instances: [await pair.report('helper', 'stopped')], ports_free: true });
  const preparesAfter = pair.commands.filter((x: any) => x.role === 'helper' && x.kind === 'prepare').length;
  assert.equal(preparesAfter, preparesBefore);
});

test('X8 late activity from a stopped instance dispatches cleanup', async () => {
  const plane = new ControlPlane(db.pool, new MemoryObjectStore(), fixtureCatalog());
  const pair = await setupPair(plane, db.pool);
  await startSession(plane, pair);
  await pair.peer(false);
  await pair.status('helper', 'stopped');
  const stopCount = pair.commands.filter((x: any) => x.role === 'helper' && x.kind === 'stop').length;

  await pair.status('helper', 'connectable');
  const cleanup = pair.commands.slice().reverse().find((x: any) => x.role === 'helper' && x.kind === 'stop');
  assert.equal(pair.commands.filter((x: any) => x.role === 'helper' && x.kind === 'stop').length, stopCount + 1);
  assert.equal(cleanup?.payload.reason, 'late_activity');
});

test('X9 heartbeat must match the current agent boot id', async () => {
  const plane = new ControlPlane(db.pool, new MemoryObjectStore(), fixtureCatalog());
  const pair = await setupPair(plane, db.pool);
  const foreignBoot = randomUUID();
  await assert.rejects(pair.send('service', 'heartbeat', {
    agent_boot_id: foreignBoot,
    inventory: inventory('service'),
    instances: [],
  }), /reconcile_failed/);
  assert.equal((await plane.getDevice(pair.user, pair.devices.service.id)).agent_boot_id, pair.devices.service.boot);
});

test('X10 service connectability requires HTTP, push, and calibration health proof', async () => {
  const plane = new ControlPlane(db.pool, new MemoryObjectStore(), fixtureCatalog());
  const pair = await setupPair(plane, db.pool);
  const session = await startSession(plane, pair);
  const report = await pair.report('service', 'ready');
  report.http_healthy = false;

  await assert.rejects(pair.send('service', 'instance.status', report), /invalid_input/);
  assert.equal((await plane.getSession(pair.user, session.id)).state, 'ready');
  const saved = (await db.pool.query('SELECT http_healthy FROM instances WHERE id=$1', [report.instance_id])).rows[0];
  assert.equal(saved.http_healthy, true);
});
