import assert from 'node:assert/strict';
import { after, before, test } from 'node:test';
import { randomUUID } from 'node:crypto';

import { ControlPlane } from '../src/control.ts';
import { MemoryObjectStore } from '../src/storage.ts';
import { EMPTY_STATS, EMPTY_TIMING } from '../src/protocol.ts';
import { createDatabase } from './postgres.ts';
import { fixtureCatalog, fixtureProof, inventory, setupPair, startSession } from './fixtures.ts';

let database: Awaited<ReturnType<typeof createDatabase>>;

before(async () => {
  database = await createDatabase();
});

after(async () => {
  await database.close();
});

async function heartbeat(plane: ControlPlane, pair: any, role: 'service' | 'helper') {
  const instances = pair.devices[role].instances.size
    ? [await pair.report(role, 'starting')]
    : [];
  await pair.send(role, 'heartbeat', {
    agent_boot_id: pair.devices[role].boot,
    inventory: inventory(role),
    instances,
  });
}

test('a startup result arriving after its persisted phase deadline cannot continue startup', async () => {
  let now = new Date('2026-11-08T12:00:00Z');
  const plane = new ControlPlane(database.pool, new MemoryObjectStore(), {
    ...fixtureCatalog(),
    now: () => now,
  });
  const pair = await setupPair(plane, database.pool);
  const session = await plane.createSession(pair.user, randomUUID(), pair.plan);
  const prepare = await pair.next('service', 'prepare');
  await pair.next('helper', 'prepare');

  const justBeforeDeadline = new Date(new Date(prepare.phase_deadline_at).getTime() - 1);
  while (justBeforeDeadline.getTime() - now.getTime() > 20_000) {
    now = new Date(now.getTime() + 20_000);
    await heartbeat(plane, pair, 'service');
    await heartbeat(plane, pair, 'helper');
  }
  now = justBeforeDeadline;
  await heartbeat(plane, pair, 'service');
  await heartbeat(plane, pair, 'helper');
  now = new Date(now.getTime() + 2);
  await pair.result('service', prepare, {
    manifest_sha256: 'a'.repeat(64),
    prepared_version_id: 'service',
    build: fixtureProof(prepare.payload.version),
  });

  const command = await database.pool.query('SELECT state, result FROM commands WHERE id = $1', [
    prepare.command_id,
  ]);
  assert.notEqual(command.rows[0].state, 'completed');
  assert.equal(command.rows[0].result, null);
  const prepareStates = await database.pool.query(
    `SELECT state FROM commands WHERE session_id = $1 AND kind = 'prepare'`,
    [session.id],
  );
  assert.equal(prepareStates.rows.some((row) => row.state === 'failed'), true);
  const stopped = await plane.getSession(pair.user, session.id);
  assert.equal(stopped.state, 'stopping');
  assert.equal(stopped.stop_cause, 'startup_failure');
});

test('a heartbeat after the server deadline cannot revive the expired connection', async () => {
  let now = new Date('2026-11-08T13:00:00Z');
  const plane = new ControlPlane(database.pool, new MemoryObjectStore(), {
    ...fixtureCatalog(),
    now: () => now,
  });
  const pair = await setupPair(plane, database.pool);
  const before = await plane.getDevice(pair.user, pair.devices.service.id);
  now = new Date(new Date(before.heartbeat_deadline_at).getTime() + 1);

  await assert.rejects(
    pair.send('service', 'heartbeat', {
      agent_boot_id: pair.devices.service.boot,
      inventory: inventory('service'),
      instances: [],
    }),
    /reconcile_failed|credential_revoked/,
  );
  assert.equal((await plane.getDevice(pair.user, pair.devices.service.id)).state, 'offline');
});

test('closing a socket clears reconciliation but waits for the heartbeat deadline before offline', async () => {
  let now = new Date('2026-11-08T13:30:00Z');
  const plane = new ControlPlane(database.pool, new MemoryObjectStore(), {
    ...fixtureCatalog(),
    now: () => now,
  });
  const pair = await setupPair(plane, database.pool);
  const before = await plane.getDevice(pair.user, pair.devices.service.id);
  await plane.closeDevice(pair.devices.service.id, pair.devices.service.connection);
  const disconnected = await plane.getDevice(pair.user, pair.devices.service.id);
  assert.equal(disconnected.state, 'idle');
  assert.equal(disconnected.reconciled_at, null);
  assert.equal(disconnected.heartbeat_deadline_at, before.heartbeat_deadline_at);

  now = new Date(new Date(before.heartbeat_deadline_at).getTime() - 1);
  await plane.tick();
  assert.equal((await plane.getDevice(pair.user, pair.devices.service.id)).state, 'idle');
  now = new Date(now.getTime() + 2);
  await plane.tick();
  assert.equal((await plane.getDevice(pair.user, pair.devices.service.id)).state, 'offline');
});

test('reconcile arriving after its handshake deadline cannot make the device ready', async () => {
  let now = new Date('2026-11-08T14:00:00Z');
  const plane = new ControlPlane(database.pool, new MemoryObjectStore(), {
    ...fixtureCatalog(),
    now: () => now,
  });
  const pair = await setupPair(plane, database.pool);
  const device = pair.devices.service;
  const connection = await plane.openDevice(device.id, device.credential, () => undefined);
  now = new Date(now.getTime() + 30_001);

  await assert.rejects(
    plane.handleDevice(device.id, connection, 'reconcile', {
      agent_boot_id: device.boot,
      inventory: inventory('service'),
      instances: [],
      commands: [],
      requests: [],
    }),
    /reconcile_failed|credential_revoked/,
  );
  const row = await database.pool.query(
    'SELECT state, reconciled_at, control_connection_id FROM devices WHERE id = $1',
    [device.id],
  );
  assert.equal(row.rows[0].state, 'offline');
  assert.equal(row.rows[0].reconciled_at, null);
  assert.equal(row.rows[0].control_connection_id, null);
});

test('legal progress persists the new deadline before sending phase.update', async () => {
  const plane = new ControlPlane(database.pool, new MemoryObjectStore(), {
    ...fixtureCatalog(),
    now: () => new Date('2026-11-08T15:00:00Z'),
  });
  const pair = await setupPair(plane, database.pool);
  await plane.createSession(pair.user, randomUUID(), pair.plan);
  const prepare = await pair.next('service', 'prepare');
  const eventStart = pair.events.length;

  await pair.send('service', 'command.progress', {
    command_id: prepare.command_id,
    phase: 'download',
    completed_bytes: '10',
    total_bytes: '100',
    message: 'downloading fixture',
  });

  const row = (
    await database.pool.query(
      'SELECT phase, phase_deadline_at, deadline_at, progress_completed_bytes FROM commands WHERE id = $1',
      [prepare.command_id],
    )
  ).rows[0];
  assert.equal(row.phase, 'download');
  assert.equal(row.progress_completed_bytes, '10');
  const instance = (
    await database.pool.query('SELECT phase, phase_deadline_at FROM instances WHERE id = $1', [
      prepare.instance_id,
    ])
  ).rows[0];
  const session = (
    await database.pool.query('SELECT phase, phase_deadline_at FROM sessions WHERE id = $1', [
      prepare.session_id,
    ])
  ).rows[0];
  assert.equal(instance.phase, 'download');
  assert.equal(instance.phase_deadline_at.toISOString(), row.phase_deadline_at.toISOString());
  assert.equal(session.phase, 'download');
  assert.equal(session.phase_deadline_at.toISOString(), row.phase_deadline_at.toISOString());
  const events = pair.events.slice(eventStart).filter((event: any) => event.role === 'service');
  const phaseUpdate = events.find((event: any) => event.type === 'phase.update');
  assert.deepEqual(phaseUpdate?.payload, {
    command_id: prepare.command_id,
    phase: 'download',
    phase_deadline_at: row.phase_deadline_at.toISOString(),
    deadline_at: row.deadline_at.toISOString(),
  });
  assert.ok(
    events.findIndex((event: any) => event.type === 'phase.update') <
      events.findIndex((event: any) => event.type === 'recorded'),
  );
});

test('start commands use load-calibrate-connect phases and replace the prepare session deadline', async () => {
  const plane = new ControlPlane(database.pool, new MemoryObjectStore(), fixtureCatalog());
  const pair = await setupPair(plane, database.pool);
  const created = await plane.createSession(pair.user, randomUUID(), pair.plan);
  for (const role of ['service', 'helper'] as const) {
    const prepare = await pair.next(role, 'prepare');
    await pair.result(role, prepare, {
      manifest_sha256: 'a'.repeat(64),
      prepared_version_id: role,
      build: fixtureProof(prepare.payload.version),
    });
  }
  const start = await pair.next('service', 'start_service');
  assert.equal(start.phase, 'load');
  const before = await plane.getSession(pair.user, created.id);
  assert.equal(before.phase, 'load');
  assert.equal(before.phase_deadline_at, start.phase_deadline_at);

  await pair.send('service', 'command.progress', {
    command_id: start.command_id,
    phase: 'calibrate',
    completed_bytes: null,
    total_bytes: null,
    message: 'calibrating',
  });
  await pair.send('service', 'command.progress', {
    command_id: start.command_id,
    phase: 'connect',
    completed_bytes: null,
    total_bytes: null,
    message: 'connecting',
  });
  const progressed = await database.pool.query(
    'SELECT phase FROM commands WHERE id = $1 UNION ALL SELECT phase FROM instances WHERE id = $2 UNION ALL SELECT phase FROM sessions WHERE id = $3',
    [start.command_id, start.instance_id, start.session_id],
  );
  assert.deepEqual(progressed.rows.map((row) => row.phase), ['connect', 'connect', 'connect']);
});

test('preflight exposes required build preparation and a mismatch becomes persisted startup failure', async () => {
  const plane = new ControlPlane(database.pool, new MemoryObjectStore(), fixtureCatalog());
  const pair = await setupPair(plane, database.pool);
  const preflight = await plane.preflight(pair.user, pair.plan);
  const buildChecks = preflight.checks.filter(
    (check: any) => check.code === 'build_preparation_required',
  );
  assert.equal(buildChecks.length, 2);
  assert.equal(buildChecks.every((check: any) => check.passed), true);
  assert.equal(preflight.allowed, true);

  await plane.createSession(pair.user, randomUUID(), pair.plan);
  const prepare = await pair.next('service', 'prepare');
  await pair.result('service', prepare, {
    manifest_sha256: 'a'.repeat(64),
    prepared_version_id: 'service',
    build: fixtureProof(prepare.payload.version, '/fixture/build', { source_revision: 'another-commit' }),
  });
  const command = (
    await database.pool.query('SELECT state,result FROM commands WHERE id=$1', [prepare.command_id])
  ).rows[0];
  assert.equal(command.state, 'failed');
  assert.equal(command.result.result.build.source_revision, 'another-commit');
  assert.equal(command.result.error, null);
  assert.equal((await plane.getSession(pair.user, prepare.session_id)).error.code, 'build_mismatch');
});

test('a successful connectivity report must use an address advertised by its source', async () => {
  const plane = new ControlPlane(database.pool, new MemoryObjectStore(), fixtureCatalog());
  const pair = await setupPair(plane, database.pool);
  const connectivity = await plane.createConnectionTest(pair.user, {
    source_device_id: pair.devices.helper.id,
    target_device_id: pair.devices.service.id,
    target_addresses: ['192.0.2.1'],
    port: 40361,
    listener_python: '/fixture/python',
  });
  const listen = await pair.next('service', 'listen_test');
  await pair.send('service', 'test.listening', {
    command_id: listen.command_id,
    test_id: connectivity.id,
    bound_addresses: ['192.0.2.1'],
    port: 40361,
    python: '/fixture/python',
  });
  const connect = await pair.next('helper', 'connect_test');
  await pair.send('helper', 'test.result', {
    command_id: connect.command_id,
    test_id: connectivity.id,
    source_address: '198.51.100.99',
    target_address: '192.0.2.1',
    port: 40361,
    nonce_matched: true,
    rtt_samples_ms: Array(10).fill(1),
    transfer_bytes: '8000000',
    transfer_ms: 10,
    error: null,
  });
  assert.equal((await plane.getTest(pair.user, connectivity.id)).state, 'unreachable');
});

test('default request budget is the serving machine\'s, up to the remaining context', async () => {
  // With no maximum output the serving machine sets the budget (4096 - the room it keeps for the
  // helper - prompt tokens); the control plane only checks it fits 4096 - prompt tokens.
  const plane = new ControlPlane(database.pool, new MemoryObjectStore(), fixtureCatalog());
  const pair = await setupPair(plane, database.pool);
  const session = await startSession(plane, pair);
  const request = await plane.submitRequest(pair.user, session.id, randomUUID(), { prompt: 'budget' });
  await pair.next('service', 'run_request');
  const report = {
    request_id: request.id,
    instance_id: request.instance_id,
    prompt_tokens: 72,
    effective_max_output: 4096 - 72 + 1,
    committed_position: '72',
    timing: { ...EMPTY_TIMING, clock_id: request.instance_id, engine_received_ns: '0' },
  };
  await assert.rejects(pair.send('service', 'request.accepted', report), /context_budget_exceeded/);
  await assert.rejects(pair.send('service', 'request.accepted', { ...report, effective_max_output: 0 }), /context_budget_exceeded|invalid_input/);
  await pair.send('service', 'request.accepted', { ...report, effective_max_output: 4096 - 70 - 72 });
  const stored = await plane.getRequest(pair.user, request.id);
  assert.deepEqual([stored.prompt_tokens, stored.effective_max_output], [72, 3954]);
});

test('a given maximum output must be the one the serving machine accepted', async () => {
  const plane = new ControlPlane(database.pool, new MemoryObjectStore(), fixtureCatalog());
  const pair = await setupPair(plane, database.pool);
  const session = await startSession(plane, pair);
  const request = await plane.submitRequest(pair.user, session.id, randomUUID(), { prompt: 'budget', max_output_tokens: 100 });
  await pair.next('service', 'run_request');
  const report = {
    request_id: request.id,
    instance_id: request.instance_id,
    prompt_tokens: 72,
    effective_max_output: 99,
    committed_position: '72',
    timing: { ...EMPTY_TIMING, clock_id: request.instance_id, engine_received_ns: '0' },
  };
  await assert.rejects(pair.send('service', 'request.accepted', report), /context_budget_exceeded/);
  await pair.send('service', 'request.accepted', { ...report, effective_max_output: 100 });
  assert.equal((await plane.getRequest(pair.user, request.id)).effective_max_output, 100);
});

test('a maximum output the serving machine refuses fails only that request, with its reason', async () => {
  // between 4096 - 70 - prompt and 4096 - prompt: the control plane cannot know the prompt length at submission, the
  // serving machine answers 400 and the device ends the request without request.accepted
  const plane = new ControlPlane(database.pool, new MemoryObjectStore(), fixtureCatalog());
  const pair = await setupPair(plane, database.pool);
  const session = await startSession(plane, pair);
  const request = await plane.submitRequest(pair.user, session.id, randomUUID(), { prompt: 'budget', max_output_tokens: 4000 });
  await pair.next('service', 'run_request');
  const reason = 'prompt has 72 tokens; output must fit remaining 3954 of 4096 (70 kept for the helper)';
  await pair.send('service', 'request.end', {
    request_id: request.id, instance_id: request.instance_id, final_seq: '0', outcome: 'failed', reason: 'error', released: true,
    prompt_tokens: null, output_tokens: '0', timing: EMPTY_TIMING, statistics: EMPTY_STATS,
    error: { code: 'context_budget_exceeded', message: reason, field: null, device_id: null, phase: null, retryable: false },
  });
  const failed = await plane.getRequest(pair.user, request.id);
  assert.deepEqual([failed.state, failed.error?.code, failed.error?.message], ['failed', 'context_budget_exceeded', reason]);
  assert.equal((await plane.getSession(pair.user, session.id)).state, 'ready');
  const next = await plane.submitRequest(pair.user, session.id, randomUUID(), { prompt: 'after' });
  assert.ok(['pending', 'running'].includes(next.state));
});
