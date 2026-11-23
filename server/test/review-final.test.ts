import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { after, before, test } from 'node:test';

import { ControlPlane } from '../src/control.ts';
import { MemoryObjectStore } from '../src/storage.ts';
import { createDatabase } from './postgres.ts';
import {
  fixtureCatalog,
  fixtureProof,
  fixtureError,
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

async function heartbeat(pair: any, role: 'service' | 'helper', state: string) {
  await pair.send(role, 'heartbeat', {
    agent_boot_id: pair.devices[role].boot,
    inventory: inventory(role),
    instances: [await pair.report(role, state)],
  });
}

async function reconnect(
  plane: ControlPlane,
  pair: any,
  role: 'service' | 'helper',
  body: { instances: any[]; commands?: any[]; requests?: any[] },
) {
  await plane.closeDevice(pair.devices[role].id, pair.devices[role].connection);
  await pair.reopen(role);
  return pair.send(role, 'reconcile', {
    agent_boot_id: pair.devices[role].boot,
    inventory: inventory(role),
    instances: body.instances,
    commands: body.commands ?? [],
    requests: body.requests ?? [],
  });
}

for (const state of ['failed', 'cleanup_required'] as const) {
  test(`repeated missing-instance reconcile remains possible after ${state} state`, async () => {
    const plane = new ControlPlane(database.pool, new MemoryObjectStore(), fixtureCatalog());
    const pair = await setupPair(plane, database.pool);
    await startSession(plane, pair);
    await pair.status('helper', state);

    for (let attempt = 0; attempt < 2; attempt += 1) {
      await reconnect(plane, pair, 'helper', { instances: [] });
      const device = await plane.getDevice(pair.user, pair.devices.helper.id);
      assert.ok(device.reconciled_at);
      assert.equal(device.cleanup_required, true);
    }
  });
}

test('a ready instance ignores an older connectable start result while recording the command result', async () => {
  const plane = new ControlPlane(database.pool, new MemoryObjectStore(), fixtureCatalog());
  const pair = await setupPair(plane, database.pool);
  await plane.createSession(pair.user, randomUUID(), pair.plan);
  for (const role of ['service', 'helper'] as const) {
    const prepare = await pair.next(role, 'prepare');
    await pair.result(role, prepare, {
      manifest_sha256: 'a'.repeat(64),
      prepared_version_id: role,
      build: fixtureProof(prepare.payload.version),
    });
  }
  const start = await pair.next('service', 'start_service');
  await pair.status('service', 'ready');
  await pair.result('service', start, { instance: await pair.report('service', 'connectable') });

  const command = (
    await database.pool.query('SELECT state FROM commands WHERE id=$1', [start.command_id])
  ).rows[0];
  assert.equal(command.state, 'completed');
  const instance = (await plane.getSession(pair.user, start.session_id)).instances.find(
    (item: any) => item.instance_id === start.instance_id,
  );
  assert.equal(instance.state, 'ready');
});

test('a failed cleanup stop persists the device reason and leaves the helper degraded', async () => {
  const plane = new ControlPlane(database.pool, new MemoryObjectStore(), fixtureCatalog());
  const pair = await setupPair(plane, database.pool);
  const session = await startSession(plane, pair);
  await pair.peer(false);
  await plane.reconnectHelper(pair.user, session.id, pair.devices.helper.id);
  const stop = await pair.next('helper', 'stop');
  const failure = fixtureError('kill_failed', pair.devices.helper.id, 'kill');
  await pair.result('helper', stop, {}, 'failed', failure);

  const device = await plane.getDevice(pair.user, pair.devices.helper.id);
  assert.equal(device.state, 'cleanup_required');
  assert.equal(device.cleanup_required, true);
  assert.equal(device.error.code, 'kill_failed');
  const degraded = await plane.getSession(pair.user, session.id);
  assert.equal(degraded.state, 'degraded');
  assert.equal(degraded.error.code, 'kill_failed');
});

test('a failed replacement-helper prepare preserves the reported disk-full reason', async () => {
  const plane = new ControlPlane(database.pool, new MemoryObjectStore(), fixtureCatalog());
  const pair = await setupPair(plane, database.pool);
  const session = await startSession(plane, pair);
  await pair.peer(false);
  await pair.status('helper', 'stopped');
  await plane.reconnectHelper(pair.user, session.id, pair.devices.helper.id);
  const prepare = await pair.next('helper', 'prepare');
  const failure = fixtureError('disk_full', pair.devices.helper.id, 'prepare');
  await pair.result('helper', prepare, {}, 'failed', failure);

  const degraded = await plane.getSession(pair.user, session.id);
  assert.equal(degraded.state, 'degraded');
  assert.equal(degraded.error.code, 'disk_full');
  const device = await plane.getDevice(pair.user, pair.devices.helper.id);
  assert.equal(device.cleanup_required, true);
  assert.equal(device.error.code, 'disk_full');
});

for (const outcome of ['residual', 'failed'] as const) {
  test(`offline reconcile accepts a ${outcome} recheck result`, async () => {
    let now = new Date('2026-11-09T16:00:00Z');
    const plane = new ControlPlane(database.pool, new MemoryObjectStore(), {
      ...fixtureCatalog(),
      now: () => now,
    });
    const pair = await setupPair(plane, database.pool);
    await startSession(plane, pair);
    await pair.status('helper', 'cleanup_required');
    await plane.recheckDevice(pair.user, pair.devices.helper.id);
    const initial = await pair.next('helper', 'recheck');
    const stopped = await pair.report(
      'helper',
      'stopped',
      initial.instance_refs[0].instance_id,
    );
    await pair.result(
      'helper',
      initial,
      { instances: [stopped], ports_free: false },
      'completed',
      fixtureError('cleanup_required', pair.devices.helper.id, 'reconcile'),
    );
    now = new Date(now.getTime() + 20_000);
    await plane.recheckDevice(pair.user, pair.devices.helper.id);
    const recheck = await pair.next('helper', 'recheck');
    // the instance of the taken port stays named until a recheck finds its port free (re-check of the device program,
    // A item 6), stopped_at or not
    assert.deepEqual(recheck.instance_refs.map((r: any) => r.instance_id), [stopped.instance_id]);

    await plane.closeDevice(pair.devices.helper.id, pair.devices.helper.connection);
    const deadline = (await plane.getDevice(pair.user, pair.devices.helper.id)).heartbeat_deadline_at;
    now = new Date(new Date(deadline).getTime() + 1);
    await plane.tick();
    assert.equal((await plane.getDevice(pair.user, pair.devices.helper.id)).state, 'offline');
    await pair.reopen('helper');
    const error = fixtureError(
      outcome === 'residual' ? 'cleanup_required' : 'recheck_failed',
      pair.devices.helper.id,
      'reconcile',
    );
    await pair.send('helper', 'reconcile', {
      agent_boot_id: pair.devices.helper.boot,
      inventory: inventory('helper'),
      instances: [],
      commands: [
        outcome === 'residual'
          ? {
              command_id: recheck.command_id,
              state: 'completed',
              result: { instances: [stopped], ports_free: false },
              error,
            }
          : {
              command_id: recheck.command_id,
              state: 'failed',
              result: null,
              error,
            },
      ],
      requests: [],
    });

    const device = await plane.getDevice(pair.user, pair.devices.helper.id);
    assert.equal(device.state, 'cleanup_required');
    assert.equal(device.cleanup_required, true);
    assert.equal(device.error.code, 'port_busy');
    assert.ok(device.reconciled_at);
  });
}

test('failed cleanup does not enqueue another stop on every heartbeat', async () => {
  const plane = new ControlPlane(database.pool, new MemoryObjectStore(), fixtureCatalog());
  const pair = await setupPair(plane, database.pool);
  await startSession(plane, pair);
  await pair.status('helper', 'cleanup_required');
  const stop = await pair.next('helper', 'stop');
  await pair.result(
    'helper',
    stop,
    {},
    'failed',
    fixtureError('kill_failed', pair.devices.helper.id, 'kill'),
  );

  for (let count = 0; count < 3; count += 1) {
    await heartbeat(pair, 'helper', 'cleanup_required');
  }
  const stops = await database.pool.query(
    "SELECT id FROM commands WHERE device_id=$1 AND instance_id=$2 AND kind='stop'",
    [pair.devices.helper.id, stop.instance_id],
  );
  assert.equal(stops.rowCount, 1);
  const session = await plane.getSession(pair.user, stop.session_id);
  await plane.reconnectHelper(pair.user, session.id, pair.devices.helper.id);
  const retry = await pair.next('helper', 'stop');
  assert.notEqual(retry.command_id, stop.command_id);
});

test('a reconcile conflict still completes the handshake and permits heartbeat', async () => {
  const plane = new ControlPlane(database.pool, new MemoryObjectStore(), fixtureCatalog());
  const pair = await setupPair(plane, database.pool);
  await startSession(plane, pair);
  const prepare = pair.commands.find(
    (command: any) => command.role === 'service' && command.kind === 'prepare',
  );
  const report = await pair.report('service', 'ready');
  await plane.closeDevice(pair.devices.service.id, pair.devices.service.connection);
  await pair.reopen('service');
  await pair.send('service', 'reconcile', {
    agent_boot_id: pair.devices.service.boot,
    inventory: inventory('service'),
    instances: [report],
    commands: [
      {
        command_id: prepare.command_id,
        state: 'completed',
        result: {
          manifest_sha256: 'b'.repeat(64),
          prepared_version_id: 'service',
          build: fixtureProof(prepare.payload.version),
        },
        error: null,
      },
    ],
    requests: [],
  });
  await heartbeat(pair, 'service', 'ready');
  assert.ok((await plane.getDevice(pair.user, pair.devices.service.id)).reconciled_at);
});

test('run-request failure remains request-scoped and does not set session error', async () => {
  const plane = new ControlPlane(database.pool, new MemoryObjectStore(), fixtureCatalog());
  const pair = await setupPair(plane, database.pool);
  const session = await startSession(plane, pair);
  const request = await plane.submitRequest(pair.user, session.id, randomUUID(), { prompt: 'reject me' });
  const run = await pair.next('service', 'run_request');
  await pair.result(
    'service',
    run,
    {},
    'failed',
    fixtureError('http_400', pair.devices.service.id, 'serve'),
  );

  assert.equal((await plane.getRequest(pair.user, request.id)).error.code, 'http_400');
  const healthy = await plane.getSession(pair.user, session.id);
  assert.equal(healthy.state, 'ready');
  assert.equal(healthy.error, null);
});

test('sent unacknowledged run request absent from reconcile is resent with the same id', async () => {
  const plane = new ControlPlane(database.pool, new MemoryObjectStore(), fixtureCatalog());
  const pair = await setupPair(plane, database.pool);
  const session = await startSession(plane, pair);
  const request = await plane.submitRequest(pair.user, session.id, randomUUID(), { prompt: 'half open' });
  const run = pair.commands.find(
    (command: any) => command.role === 'service' && command.kind === 'run_request',
  );
  assert.ok(run);
  const beforeCommand = (
    await database.pool.query(
      'SELECT deadline_at,phase_deadline_at,ack_deadline_at FROM commands WHERE id=$1',
      [run.command_id],
    )
  ).rows[0];
  const beforeRequest = (
    await database.pool.query('SELECT no_output_deadline_at FROM requests WHERE id=$1', [request.id])
  ).rows[0];
  const eventStart = pair.events.length;
  await reconnect(plane, pair, 'service', {
    instances: [await pair.report('service', 'ready')],
    requests: [],
  });

  const reconciled = pair.events
    .slice(eventStart)
    .find((event: any) => event.role === 'service' && event.type === 'reconciled');
  assert.ok(reconciled);
  assert.ok(reconciled.payload.commands.some((command: any) => command.command_id === run.command_id));
  assert.ok(pair.events.slice(eventStart).some((event: any) => event.type === 'command' && event.payload.command_id === run.command_id), 'dispatch must resend the original command after reconciliation');
  assert.equal((await plane.getRequest(pair.user, request.id)).state, 'running');
  assert.equal((await plane.getSession(pair.user, session.id)).state, 'ready');
  const commands = await database.pool.query(
    "SELECT id,deadline_at,phase_deadline_at,ack_deadline_at FROM commands WHERE request_id=$1 AND kind='run_request'",
    [request.id],
  );
  assert.equal(commands.rowCount, 1);
  assert.equal(commands.rows[0].id, run.command_id);
  assert.equal(commands.rows[0].deadline_at.toISOString(), beforeCommand.deadline_at.toISOString());
  assert.equal(
    commands.rows[0].phase_deadline_at.toISOString(),
    beforeCommand.phase_deadline_at.toISOString(),
  );
  assert.equal(
    commands.rows[0].ack_deadline_at.toISOString(),
    beforeCommand.ack_deadline_at.toISOString(),
  );
  const afterRequest = (
    await database.pool.query('SELECT no_output_deadline_at FROM requests WHERE id=$1', [request.id])
  ).rows[0];
  assert.equal(
    afterRequest.no_output_deadline_at.toISOString(),
    beforeRequest.no_output_deadline_at.toISOString(),
  );
});

test('unacknowledged delivery with a stored gap chunk is execution evidence, not permission to rerun', async () => {
  const plane = new ControlPlane(database.pool, new MemoryObjectStore(), fixtureCatalog());
  const pair = await setupPair(plane, database.pool);
  const session = await startSession(plane, pair);
  const request = await plane.submitRequest(pair.user, session.id, randomUUID(), { prompt: 'gap evidence' });
  await pair.send('service', 'output.chunk', {
    request_id: request.id, instance_id: request.instance_id, seq: '2', text: 'B',
    token_count: 1, segment: 'answer', committed_position: '3', engine_first_output_ns: '1',
    engine_last_output_ns: '2', engine_first_chunk_tokens: 1,
  });
  assert.equal((await plane.getRequest(pair.user, request.id)).contiguous_seq, '0');
  await reconnect(plane, pair, 'service', {
    instances: [await pair.report('service', 'ready')], requests: [],
  });
  assert.equal((await plane.getRequest(pair.user, request.id)).state, 'failed');
  assert.equal((await plane.getSession(pair.user, session.id)).state, 'stopping');
});
