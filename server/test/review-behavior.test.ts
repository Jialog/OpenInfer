import assert from 'node:assert/strict';
import { after, before, test } from 'node:test';
import { randomUUID } from 'node:crypto';

import { ControlPlane } from '../src/control.ts';
import { EMPTY_STATS, EMPTY_TIMING } from '../src/protocol.ts';
import { MemoryObjectStore } from '../src/storage.ts';
import { createDatabase } from './postgres.ts';
import {
  fixtureCatalog,
  fixtureProof,
  fixtureError,
  fixtureMetrics,
  inventory,
  setupPair,
  startSession,
} from './fixtures.ts';

let database: Awaited<ReturnType<typeof createDatabase>>;

before(async () => {
  database = await createDatabase();
});

after(async () => {
  await database.close();
});

async function heartbeat(pair: any, role: 'service' | 'helper', state = 'connectable') {
  const instances = pair.devices[role].instances.size
    ? [await pair.report(role, state)]
    : [];
  await pair.send(role, 'heartbeat', {
    agent_boot_id: pair.devices[role].boot,
    inventory: inventory(role),
    instances,
  });
}

async function keepAliveUntil(
  pair: any,
  getNow: () => Date,
  setNow: (value: Date) => void,
  target: Date,
  state = 'connectable',
) {
  while (target.getTime() - getNow().getTime() > 20_000) {
    setNow(new Date(getNow().getTime() + 20_000));
    await heartbeat(pair, 'service', state);
    await heartbeat(pair, 'helper', state);
  }
  setNow(target);
}

function accepted(request: any) {
  return {
    request_id: request.id,
    instance_id: request.instance_id,
    prompt_tokens: 1,
    effective_max_output: 4095,
    committed_position: '1',
    timing: { ...EMPTY_TIMING, clock_id: request.instance_id, engine_received_ns: '1' },
  };
}

function oneChunk(request: any) {
  return {
    request_id: request.id,
    instance_id: request.instance_id,
    seq: '1',
    text: 'partial',
    token_count: 1,
    segment: 'answer',
    committed_position: '2',
    engine_first_output_ns: '2',
    engine_last_output_ns: '2',
    engine_first_chunk_tokens: 1,
  };
}

test('instance reports are constructible only from downlinked Command.instance_refs', async () => {
  const plane = new ControlPlane(database.pool, new MemoryObjectStore(), fixtureCatalog());
  const pair = await setupPair(plane, database.pool);
  await plane.createSession(pair.user, randomUUID(), pair.plan);
  for (const role of ['service', 'helper'] as const) {
    const prepare = await pair.next(role, 'prepare');
    const ref = pair.commandRef(role, prepare);
    assert.deepEqual(Object.keys(ref).sort(), [
      'config_sha256',
      'generation',
      'instance_id',
      'session_id',
    ]);
    assert.equal(ref.generation, 1);
    assert.match(ref.config_sha256, /^[0-9a-f]{64}$/);
    const report = await pair.report(role, 'starting', ref.instance_id);
    assert.equal(report.generation, ref.generation);
    assert.equal(report.config_sha256, ref.config_sha256);
    assert.deepEqual(report.metrics, fixtureMetrics());
  }
});

test('a new device boot reports a live old service instance, completes reconcile, and receives cleanup', async () => {
  const plane = new ControlPlane(database.pool, new MemoryObjectStore(), fixtureCatalog());
  const pair = await setupPair(plane, database.pool);
  const session = await startSession(plane, pair);
  const old = await pair.report('service', 'ready');
  const newBoot = randomUUID();
  await pair.reopen('service', newBoot);

  await pair.send('service', 'reconcile', {
    agent_boot_id: newBoot,
    inventory: inventory('service'),
    instances: [{ ...old, agent_boot_id: newBoot }],
    commands: [],
    requests: [],
  });

  assert.equal((await plane.getSession(pair.user, session.id)).state, 'stopping');
  assert.equal((await plane.getDevice(pair.user, pair.devices.service.id)).cleanup_required, true);
  assert.ok(pair.commands.some((command: any) => command.role === 'service' && command.kind === 'stop'));
  assert.ok(pair.events.some((event: any) => event.role === 'service' && event.type === 'reconciled'));
});

test('a helper instance missing after a new boot degrades but does not stop the healthy service', async () => {
  const plane = new ControlPlane(database.pool, new MemoryObjectStore(), fixtureCatalog());
  const pair = await setupPair(plane, database.pool);
  const session = await startSession(plane, pair);
  const newBoot = randomUUID();
  await pair.reopen('helper', newBoot);
  await pair.send('helper', 'reconcile', {
    agent_boot_id: newBoot,
    inventory: inventory('helper'),
    instances: [],
    commands: [],
    requests: [],
  });
  const degraded = await plane.getSession(pair.user, session.id);
  assert.equal(degraded.state, 'degraded');
  assert.notEqual(degraded.state, 'stopping');
  assert.equal((await plane.getDevice(pair.user, pair.devices.helper.id)).cleanup_required, true);
});

test('a stopped service in a degraded session fails its request and stops the session', async () => {
  const plane = new ControlPlane(database.pool, new MemoryObjectStore(), fixtureCatalog());
  const pair = await setupPair(plane, database.pool);
  const session = await startSession(plane, pair);
  const request = await plane.submitRequest(pair.user, session.id, randomUUID(), { prompt: 'active' });
  await pair.peer(false);
  assert.equal((await plane.getSession(pair.user, session.id)).state, 'degraded');
  await pair.status('service', 'stopped');
  assert.equal((await plane.getRequest(pair.user, request.id)).state, 'failed');
  assert.equal((await plane.getSession(pair.user, session.id)).state, 'stopping');
});

test('manual helper reconnect stops a live old instance before creating a replacement', async () => {
  const plane = new ControlPlane(database.pool, new MemoryObjectStore(), fixtureCatalog());
  const pair = await setupPair(plane, database.pool);
  const session = await startSession(plane, pair);
  await pair.peer(false);
  await plane.reconnectHelper(pair.user, session.id, pair.devices.helper.id);
  const stop = await pair.next('helper', 'stop');
  assert.deepEqual(stop.payload.instance_ids, [(await pair.report('helper', 'stopping')).instance_id]);
  assert.equal(pair.commands.some((command: any) => command.kind === 'prepare' && !command.used), false);
});

test('manual reconnect reuses new-boot cleanup and replaces the helper after stop proof', async () => {
  const plane = new ControlPlane(database.pool, new MemoryObjectStore(), fixtureCatalog());
  const pair = await setupPair(plane, database.pool);
  const session = await startSession(plane, pair);
  const old = await pair.report('helper', 'ready');
  const newBoot = randomUUID();
  await pair.reopen('helper', newBoot);
  await pair.send('helper', 'reconcile', {
    agent_boot_id: newBoot,
    inventory: inventory('helper'),
    instances: [{ ...old, agent_boot_id: newBoot }],
    commands: [],
    requests: [],
  });
  assert.equal((await plane.getSession(pair.user, session.id)).state, 'degraded');
  const cleanup = pair.commands.find(
    (command: any) =>
      command.role === 'helper' &&
      command.kind === 'stop' &&
      command.instance_id === old.instance_id &&
      !command.used,
  );
  assert.ok(cleanup);

  await plane.reconnectHelper(pair.user, session.id, pair.devices.helper.id);
  const reused = await pair.next('helper', 'stop');
  assert.equal(reused.command_id, cleanup.command_id);
  await pair.result('helper', reused, {
    instances: [await pair.report('helper', 'stopped', old.instance_id)],
    ports_free: true,
  });

  const replacement = await pair.next('helper', 'prepare');
  assert.equal(pair.commandRef('helper', replacement).generation, old.generation + 1);
});

test('manual reconnect replaces the helper when stopped status precedes the stop result', async () => {
  const plane = new ControlPlane(database.pool, new MemoryObjectStore(), fixtureCatalog());
  const pair = await setupPair(plane, database.pool);
  const session = await startSession(plane, pair);
  await pair.peer(false);
  const old = await pair.report('helper', 'stopping');

  await plane.reconnectHelper(pair.user, session.id, pair.devices.helper.id);
  const stop = await pair.next('helper', 'stop');
  await pair.status('helper', 'stopped');
  await pair.result('helper', stop, {
    instances: [await pair.report('helper', 'stopped', old.instance_id)],
    ports_free: true,
  });

  const replacement = await pair.next('helper', 'prepare');
  assert.equal(pair.commandRef('helper', replacement).generation, old.generation + 1);
});

test('manual reconnect accepts a changed helper boot when the measured addresses remain present', async () => {
  const plane = new ControlPlane(database.pool, new MemoryObjectStore(), fixtureCatalog());
  const pair = await setupPair(plane, database.pool);
  const session = await startSession(plane, pair);
  await pair.peer(false);
  const stopped = await pair.report('helper', 'stopped');
  const newBoot = randomUUID();
  await pair.reopen('helper', newBoot);
  await pair.send('helper', 'reconcile', {
    agent_boot_id: newBoot,
    inventory: inventory('helper'),
    instances: [{ ...stopped, agent_boot_id: newBoot }],
    commands: [],
    requests: [],
  });
  await plane.reconnectHelper(pair.user, session.id, pair.devices.helper.id);
  assert.ok(await pair.next('helper', 'prepare'));
});

test('a replacement helper that never connects times out, cleans up, and leaves reconnect retryable', async () => {
  let now = new Date('2026-11-08T12:00:00Z');
  const plane = new ControlPlane(database.pool, new MemoryObjectStore(), {
    ...fixtureCatalog(),
    now: () => now,
  });
  const pair = await setupPair(plane, database.pool);
  const session = await startSession(plane, pair);
  await pair.peer(false);
  await pair.status('helper', 'stopped');
  await plane.reconnectHelper(pair.user, session.id, pair.devices.helper.id);
  const prepare = await pair.next('helper', 'prepare');
  await pair.result('helper', prepare, {
    manifest_sha256: 'a'.repeat(64),
    prepared_version_id: 'helper',
    build: fixtureProof(prepare.payload.version),
  });
  const start = await pair.next('helper', 'start_helper');
  await pair.result('helper', start, { instance: await pair.report('helper', 'connectable') });

  const deadline = new Date(start.phase_deadline_at);
  await keepAliveUntil(pair, () => now, (value) => { now = value; }, new Date(deadline.getTime() + 1));
  await plane.tick();
  const degraded = await plane.getSession(pair.user, session.id);
  assert.equal(degraded.state, 'degraded');
  assert.equal(degraded.error.code, 'deadline_exceeded');
  assert.ok(pair.commands.some((command: any) => command.kind === 'stop' && !command.used));
});

test('parallel prepare progress keeps the session deadline at the maximum outstanding deadline', async () => {
  let now = new Date('2026-11-08T13:00:00Z');
  const plane = new ControlPlane(database.pool, new MemoryObjectStore(), {
    ...fixtureCatalog(),
    now: () => now,
  });
  const pair = await setupPair(plane, database.pool);
  const session = await plane.createSession(pair.user, randomUUID(), pair.plan);
  const service = await pair.next('service', 'prepare');
  const helper = await pair.next('helper', 'prepare');
  await pair.send('service', 'command.progress', {
    command_id: service.command_id,
    phase: 'build',
    completed_bytes: null,
    total_bytes: null,
    message: 'building service',
  });
  now = new Date(now.getTime() + 15_000);
  await pair.send('helper', 'command.progress', {
    command_id: helper.command_id,
    phase: 'download',
    completed_bytes: '1',
    total_bytes: '2',
    message: 'downloading helper',
  });
  const deadlines = await database.pool.query(
    'SELECT id, phase_deadline_at FROM commands WHERE id = ANY($1::uuid[])',
    [[service.command_id, helper.command_id]],
  );
  const maximum = Math.max(...deadlines.rows.map((row) => row.phase_deadline_at.getTime()));
  assert.equal(new Date((await plane.getSession(pair.user, session.id)).phase_deadline_at).getTime(), maximum);
});

test('recheck may report residual processes and ports without becoming a protocol error', async () => {
  let now = new Date('2026-11-08T14:00:00Z');
  const plane = new ControlPlane(database.pool, new MemoryObjectStore(), {
    ...fixtureCatalog(),
    now: () => now,
  });
  const pair = await setupPair(plane, database.pool);
  const session = await startSession(plane, pair);
  await plane.stopSession(pair.user, session.id);
  const serviceStop = await pair.next('service', 'stop');
  await pair.next('helper', 'stop');
  const target = new Date(new Date((await plane.getSession(pair.user, session.id)).stop_deadline_at).getTime() + 1);
  await keepAliveUntil(pair, () => now, (value) => { now = value; }, target, 'stopping');
  await plane.tick();
  assert.equal((await plane.getDevice(pair.user, pair.devices.service.id)).state, 'cleanup_required');

  await plane.recheckDevice(pair.user, pair.devices.service.id);
  const recheck = await pair.next('service', 'recheck');
  const residual = {
    ...(await pair.report('service', 'cleanup_required', serviceStop.instance_refs[0].instance_id)),
    processes: [{ pid: 123, process_group_id: 123, alive: true }],
  };
  await pair.result(
    'service',
    recheck,
    { instances: [residual], ports_free: false },
    'completed',
    fixtureError('cleanup_required', pair.devices.service.id, 'reconcile'),
  );
  const device = await plane.getDevice(pair.user, pair.devices.service.id);
  assert.equal(device.state, 'cleanup_required');
  assert.equal(device.error.code, 'port_busy');
  assert.equal(device.error.message, 'Fixture cleanup_required');
  assert.equal(
    (await database.pool.query('SELECT state FROM commands WHERE id=$1', [recheck.command_id])).rows[0].state,
    'completed',
  );
});

test('a stop that fails only on a taken port keeps the device for cleanup until a recheck finds the port free', async () => {
  // the device reports port_busy (every process gone, another process holds a port); its following "stopped" report must
  // not release the device: the Devices page offers Recheck, and only a recheck with the port free makes it idle again
  const plane = new ControlPlane(database.pool, new MemoryObjectStore(), fixtureCatalog());
  const pair = await setupPair(plane, database.pool);
  const session = await startSession(plane, pair);
  await plane.stopSession(pair.user, session.id);
  const serviceStop = await pair.next('service', 'stop');
  const helperStop = await pair.next('helper', 'stop');
  await pair.result('helper', helperStop, { instances: [await pair.report('helper', 'stopped')], ports_free: true });
  const stopped = await pair.report('service', 'stopped', serviceStop.instance_refs[0].instance_id);
  await pair.result('service', serviceStop, { instances: [stopped], ports_free: false }, 'failed',
    fixtureError('port_busy', pair.devices.service.id, 'kill'));
  await pair.status('service', 'stopped');
  let device = await plane.getDevice(pair.user, pair.devices.service.id);
  assert.deepEqual([device.state, device.cleanup_required, device.error?.code], ['cleanup_required', true, 'port_busy']);
  await plane.recheckDevice(pair.user, pair.devices.service.id);
  const recheck = await pair.next('service', 'recheck');
  const rechecked = await Promise.all(recheck.payload.instance_ids.map((id: string) => pair.report('service', 'stopped', id)));
  await pair.result('service', recheck, { instances: rechecked, ports_free: true });
  device = await plane.getDevice(pair.user, pair.devices.service.id);
  assert.deepEqual([device.state, device.cleanup_required, device.error], ['idle', false, null]);
});

test('a mismatched build proof is persisted as startup failure instead of rolled back', async () => {
  const plane = new ControlPlane(database.pool, new MemoryObjectStore(), fixtureCatalog());
  const pair = await setupPair(plane, database.pool);
  const session = await plane.createSession(pair.user, randomUUID(), pair.plan);
  const prepare = await pair.next('service', 'prepare');
  await pair.result('service', prepare, {
    manifest_sha256: 'a'.repeat(64),
    prepared_version_id: 'service',
    build: fixtureProof(prepare.payload.version, '/fixture/build', { source_revision: 'another-commit' }),
  });
  const command = (await database.pool.query('SELECT state,result FROM commands WHERE id=$1', [prepare.command_id])).rows[0];
  assert.equal(command.state, 'failed');
  assert.equal(command.result.result.build.source_revision, 'another-commit');
  assert.equal(command.result.error, null);
  const stopped = await plane.getSession(pair.user, session.id);
  assert.equal(stopped.state, 'stopping');
  assert.equal(stopped.error.code, 'build_mismatch');
});

test('reconcile persists a failed prepare report whose command result is null', async () => {
  const plane = new ControlPlane(database.pool, new MemoryObjectStore(), fixtureCatalog());
  const pair = await setupPair(plane, database.pool);
  const session = await plane.createSession(pair.user, randomUUID(), pair.plan);
  const prepare = await pair.next('service', 'prepare');
  const report = await pair.report('service', 'starting', prepare.instance_id);
  await plane.closeDevice(pair.devices.service.id, pair.devices.service.connection);
  await pair.reopen('service');
  await pair.send('service', 'reconcile', {
    agent_boot_id: pair.devices.service.boot,
    inventory: inventory('service'),
    instances: [report],
    commands: [
      {
        command_id: prepare.command_id,
        state: 'failed',
        result: null,
        error: fixtureError('prepare_failed', pair.devices.service.id, 'prepare'),
      },
    ],
    requests: [],
  });

  const command = (
    await database.pool.query('SELECT state,result FROM commands WHERE id=$1', [prepare.command_id])
  ).rows[0];
  assert.equal(command.state, 'failed');
  assert.equal(command.result.result, null);
  assert.equal(command.result.error.code, 'prepare_failed');
  const stopped = await plane.getSession(pair.user, session.id);
  assert.equal(stopped.state, 'stopping');
  assert.equal(stopped.error.code, 'prepare_failed');
});

test('preflight explains when the helper cannot fit the enabled draft model', async () => {
  const options = fixtureCatalog();
  options.requirements.helper = {
    ...options.requirements.helper,
    memory_bytes: '21000000000',
  };
  const plane = new ControlPlane(database.pool, new MemoryObjectStore(), options);
  const pair = await setupPair(plane, database.pool);

  const preflight = await plane.preflight(pair.user, pair.plan);
  const capacity = preflight.checks.find(
    (check: any) =>
      check.code === 'capacity_insufficient' && check.device_id === pair.devices.helper.id,
  );
  assert.equal(preflight.allowed, false);
  assert.ok(capacity);
  assert.equal(capacity.passed, false);
  assert.equal(capacity.required_bytes, '21000000000');
  assert.equal(capacity.available_bytes, '20000000000');
  assert.match(capacity.message, /draft|草稿/i);
});

test('a failed listener command immediately fails the connection test with the device error', async () => {
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
  const error = fixtureError('port_busy', pair.devices.service.id, 'connect');
  await pair.result('service', listen, {}, 'failed', error);
  const failed = await plane.getTest(pair.user, connectivity.id);
  assert.equal(failed.state, 'unreachable');
  assert.deepEqual(failed.error, error);
  assert.ok(pair.commands.some((command: any) => command.kind === 'close_test' && !command.used));
});

test('no-output cancellation preserves a released end report and archives partial output', async () => {
  let now = new Date('2026-11-08T15:00:00Z');
  const store = new MemoryObjectStore();
  const plane = new ControlPlane(database.pool, store, { ...fixtureCatalog(), now: () => now });
  const pair = await setupPair(plane, database.pool);
  const session = await startSession(plane, pair);
  const request = await plane.submitRequest(pair.user, session.id, randomUUID(), { prompt: 'partial' });
  await pair.next('service', 'run_request');
  await pair.send('service', 'request.accepted', accepted(request));
  await pair.send('service', 'output.chunk', oneChunk(request));
  const target = new Date(new Date((await plane.getRequest(pair.user, request.id)).no_output_deadline_at).getTime() + 1);
  await keepAliveUntil(pair, () => now, (value) => { now = value; }, target);
  await plane.tick();
  assert.equal((await plane.getRequest(pair.user, request.id)).state, 'cancelling');
  await pair.send('service', 'request.end', {
    request_id: request.id,
    instance_id: request.instance_id,
    final_seq: '1',
    outcome: 'cancelled',
    reason: 'cancelled',
    released: true,
    prompt_tokens: 1,
    output_tokens: '1',
    timing: { ...EMPTY_TIMING, clock_id: request.instance_id, engine_received_ns: '1', engine_first_output_ns: '2', engine_last_output_ns: '2', engine_first_chunk_tokens: 1, engine_finished_ns: '3' },
    statistics: EMPTY_STATS,
    error: fixtureError('no_output_timeout', pair.devices.service.id, 'serve'),
  });
  const archived = await plane.getRequest(pair.user, request.id);
  assert.equal(archived.state, 'cancelled');
  assert.equal(archived.archive_state, 'saved');
  assert.equal((await plane.getResult(pair.user, request.id)).text, 'partial');
});

test('reconciling a pending request clears the original disconnect deadline and unblocks submissions', async () => {
  const plane = new ControlPlane(database.pool, new MemoryObjectStore(), fixtureCatalog());
  const pair = await setupPair(plane, database.pool);
  const session = await startSession(plane, pair);
  const dispatch = plane.dispatch.bind(plane);
  (plane as any).dispatch = async () => undefined;
  const request = await plane.submitRequest(pair.user, session.id, randomUUID(), { prompt: 'pending' });
  (plane as any).dispatch = dispatch;
  assert.equal(request.state, 'pending');
  await plane.closeDevice(pair.devices.service.id, pair.devices.service.connection);
  const report = await pair.report('service', 'ready');
  await pair.reopen('service');
  await pair.send('service', 'reconcile', {
    agent_boot_id: pair.devices.service.boot,
    inventory: inventory('service'),
    instances: [report],
    commands: [],
    requests: [],
  });
  const recovered = await plane.getRequest(pair.user, request.id);
  assert.equal(recovered.disconnect_deadline_at, null);
  assert.equal((await plane.getSession(pair.user, session.id)).submissions_blocked, false);
  assert.equal(recovered.state, 'running');
});

test('unrelated inventory addresses do not invalidate a still-present measured path', async () => {
  const plane = new ControlPlane(database.pool, new MemoryObjectStore(), fixtureCatalog());
  const pair = await setupPair(plane, database.pool);
  const changed = inventory('helper');
  changed.addresses.push({ address: '198.51.100.9', interface: 'vpn0' });
  await pair.send('helper', 'heartbeat', {
    agent_boot_id: pair.devices.helper.boot,
    inventory: changed,
    instances: [],
  });
  const preflight = await plane.preflight(pair.user, pair.plan);
  assert.equal(preflight.allowed, true);
  assert.equal(preflight.checks.find((check: any) => check.code === 'direction_unreachable').passed, true);
});

test('a released end after run_request failure remains failed rather than cancelled', async () => {
  const plane = new ControlPlane(database.pool, new MemoryObjectStore(), fixtureCatalog());
  const pair = await setupPair(plane, database.pool);
  const session = await startSession(plane, pair);
  const request = await plane.submitRequest(pair.user, session.id, randomUUID(), { prompt: 'failure' });
  const run = await pair.next('service', 'run_request');
  await pair.result('service', run, {}, 'failed', fixtureError('http_error', pair.devices.service.id, 'serve'));
  await pair.send('service', 'request.end', {
    request_id: request.id,
    instance_id: request.instance_id,
    final_seq: '0',
    outcome: 'failed',
    reason: 'error',
    released: true,
    prompt_tokens: null,
    output_tokens: '0',
    timing: EMPTY_TIMING,
    statistics: EMPTY_STATS,
    error: fixtureError('http_error', pair.devices.service.id, 'serve'),
  });
  assert.equal((await plane.getRequest(pair.user, request.id)).state, 'failed');
});

test('the original helper instances reconnecting themselves cannot leave degraded state', async () => {
  const plane = new ControlPlane(database.pool, new MemoryObjectStore(), fixtureCatalog());
  const pair = await setupPair(plane, database.pool);
  const session = await startSession(plane, pair);
  await pair.peer(false);
  assert.equal((await plane.getSession(pair.user, session.id)).state, 'degraded');
  await pair.peer(true);
  assert.equal((await plane.getSession(pair.user, session.id)).state, 'degraded');
});

test('request seeds are decimal U64 values and the downlinked command preserves the same seed', async () => {
  const plane = new ControlPlane(database.pool, new MemoryObjectStore(), fixtureCatalog());
  const pair = await setupPair(plane, database.pool);
  const session = await startSession(plane, pair);
  const request = await plane.submitRequest(pair.user, session.id, randomUUID(), { prompt: 'seed' });
  const run = await pair.next('service', 'run_request');
  assert.match(request.seed, /^(0|[1-9][0-9]*)$/);
  assert.ok(BigInt(request.seed) <= 9223372036854775807n);
  assert.equal(run.payload.seed, request.seed);
});

// Re-check finding 4: a user's stop while a request runs. The serving machine drains it; the helpers keep serving until
// it has (no request of the session running on the serving engine), or until the drain deadline, and only then get
// their stop, with the session's own drain, TERM and KILL deadlines.
for (const ends of ['drained', 'at the drain deadline'] as const) {
  test(`a user's stop tells the helpers to stop once the serving machine has ${ends === 'drained' ? 'drained' : 'not drained by the drain deadline'}`, async () => {
    let now = new Date('2026-11-21T10:00:00Z');
    const plane = new ControlPlane(database.pool, new MemoryObjectStore(), { ...fixtureCatalog(), now: () => now });
    const pair = await setupPair(plane, database.pool);
    const session = await startSession(plane, pair);
    const request = await plane.submitRequest(pair.user, session.id, randomUUID(), { prompt: 'drain me' });
    await pair.next('service', 'run_request');
    await pair.send('service', 'request.accepted', accepted(request));
    await pair.send('service', 'output.chunk', oneChunk(request));
    await plane.stopSession(pair.user, session.id);
    const stops = () => pair.commands.filter((command: any) => command.kind === 'stop');
    assert.deepEqual(stops().map((command: any) => command.role), ['service'], 'only the serving machine stops at once');
    await pair.send('service', 'command.ack', { command_id: stops()[0].command_id, state: 'executing' });
    now = new Date(now.getTime() + 5_000);
    await heartbeat(pair, 'service');
    await heartbeat(pair, 'helper');
    await plane.tick();
    assert.deepEqual(stops().map((command: any) => command.role), ['service'], 'the helper serves while the request runs');
    if (ends === 'drained') {
      await pair.send('service', 'request.end', { request_id: request.id, instance_id: request.instance_id, final_seq: '1', outcome: 'completed',
        reason: 'eos', released: true, prompt_tokens: 1, output_tokens: '1', timing: EMPTY_TIMING, statistics: EMPTY_STATS, error: null });
      assert.equal((await plane.getRequest(pair.user, request.id)).state, 'completed');
    } else {
      now = new Date(now.getTime() + 25_001);
      await heartbeat(pair, 'service');
      await heartbeat(pair, 'helper');
    }
    await plane.tick();
    const [serving, helping] = stops();
    assert.equal(helping?.role, 'helper', 'the helper is told to stop now');
    assert.equal(stops().length, 2);
    for (const field of ['drain_deadline_at', 'term_deadline_at', 'kill_deadline_at'])
      assert.equal(new Date(helping.payload[field]).getTime(), new Date(serving.payload[field]).getTime(), field);
    assert.equal(new Date(helping.deadline_at).getTime(), new Date(serving.payload.kill_deadline_at).getTime());
    await plane.tick();
    assert.equal(stops().length, 2, 'one stop per device');
    for (const role of ['service', 'helper']) {
      const stop = pair.commands.find((command: any) => command.kind === 'stop' && command.role === role);
      if (role === 'helper') await pair.send(role, 'command.ack', { command_id: stop.command_id, state: 'executing' });
      await pair.result(role, stop, { instances: [await pair.report(role, 'stopped')], ports_free: true });
    }
    assert.equal((await plane.getSession(pair.user, session.id)).state, 'ended');
  });
}
