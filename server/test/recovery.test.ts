import assert from 'node:assert/strict';
import { after, before, test } from 'node:test';
import { randomUUID } from 'node:crypto';

import { ControlPlane } from '../src/control.ts';
import type { ObjectStore } from '../src/storage.ts';
import { MemoryObjectStore } from '../src/storage.ts';
import { EMPTY_STATS, EMPTY_TIMING } from '../src/protocol.ts';
import { createDatabase } from './postgres.ts';
import { fixtureCatalog, inventory, sendOutput, setupPair, startSession } from './fixtures.ts';

let database: Awaited<ReturnType<typeof createDatabase>>;

before(async () => {
  database = await createDatabase();
});

after(async () => {
  await database.close();
});

function accepted(request: any) {
  return {
    request_id: request.id,
    instance_id: request.instance_id,
    prompt_tokens: 1,
    effective_max_output: request.requested_max_output ?? 4095,
    committed_position: '1',
    timing: { ...EMPTY_TIMING, clock_id: request.instance_id, engine_received_ns: '0' },
  };
}

function chunk(request: any, seq: string, text: string) {
  return {
    request_id: request.id,
    instance_id: request.instance_id,
    seq,
    text,
    token_count: 1,
    segment: 'answer',
    committed_position: (1 + Number(seq)).toString(),
    engine_first_output_ns: '1000000000',
    engine_last_output_ns: seq === '1' ? '1000000000' : '2000000000',
    engine_first_chunk_tokens: 1,
  };
}

function completedEnd(request: any) {
  return {
    request_id: request.id,
    instance_id: request.instance_id,
    final_seq: '2',
    outcome: 'completed',
    reason: 'length',
    released: true,
    prompt_tokens: 1,
    output_tokens: '2',
    timing: {
      ...EMPTY_TIMING,
      clock_id: request.instance_id,
      engine_received_ns: '0',
      engine_first_output_ns: '1000000000',
      engine_last_output_ns: '2000000000',
      engine_first_chunk_tokens: 1,
      engine_finished_ns: '2000000000',
    },
    statistics: EMPTY_STATS,
    error: null,
  };
}

async function reconnect(
  plane: ControlPlane,
  pair: any,
  role: 'service' | 'helper',
  requests: any[] = [],
  reported: any[] = [],
) {
  const commands: any[] = [];
  const events: any[] = [];
  const device = pair.devices[role];
  const connection = await plane.openDevice(device.id, device.credential, (type, payload) => {
    events.push({ type, payload });
    if (type === 'command' && !commands.some((item) => item.command_id === payload.command_id)) {
      pair.acceptCommand(role, payload);
      commands.push(payload);
    }
  });
  const send = (type: string, payload: any) =>
    plane.handleDevice(device.id, connection, type, payload);
  await send('reconcile', {
    agent_boot_id: device.boot,
    inventory: inventory(role),
    instances: [await pair.report(role, 'connectable')],
    commands: reported,
    requests,
  });
  return { connection, commands, events, send };
}

async function heartbeat(plane: ControlPlane, pair: any, role: 'service' | 'helper') {
  await pair.send(role, 'heartbeat', {
    agent_boot_id: pair.devices[role].boot,
    inventory: inventory(role),
    instances: [await pair.report(role, 'connectable')],
  });
}

async function idleHeartbeat(pair: any, role: 'service' | 'helper') {
  await pair.send(role, 'heartbeat', {
    agent_boot_id: pair.devices[role].boot,
    inventory: inventory(role),
    instances: [],
  });
}

test('restart reconciles the original stream, replays only the missing suffix, and never reissues run_request', async () => {
  let now = new Date('2026-11-08T12:00:00Z');
  const options = { ...fixtureCatalog(), now: () => now };
  const store = new MemoryObjectStore();
  let plane = new ControlPlane(database.pool, store, options);
  const pair = await setupPair(plane, database.pool);
  const session = await startSession(plane, pair);
  const request = await plane.submitRequest(pair.user, session.id, randomUUID(), { prompt: 'recover me' });
  const run = await pair.next('service', 'run_request');
  await pair.send('service', 'request.accepted', accepted(request));
  await pair.send('service', 'output.chunk', chunk(request, '1', 'A'));

  plane = new ControlPlane(database.pool, store, options);
  await plane.recover();
  await reconnect(plane, pair, 'helper');
  const service = await reconnect(plane, pair, 'service', [
    {
      request_id: request.id,
      instance_id: request.instance_id,
      http_stream_alive: false,
      local_contiguous_seq: '2',
      local_final_seq: '2',
      complete_buffer: true,
      end: completedEnd(request),
    },
  ]);

  const replay = service.events.find((event) => event.type === 'output.replay');
  assert.deepEqual(replay?.payload, {
    request_id: request.id,
    instance_id: request.instance_id,
    after_seq: '1',
    through_seq: '2',
  });
  await service.send('output.chunk', chunk(request, '2', 'B'));

  assert.equal((await plane.getRequest(pair.user, request.id)).state, 'completed');
  assert.equal((await plane.getResult(pair.user, request.id)).text, 'AB');
  const runs = await database.pool.query(
    `SELECT id, attempts FROM commands WHERE request_id = $1 AND kind = 'run_request'`,
    [request.id],
  );
  assert.deepEqual(runs.rows.map((row) => row.id), [run.command_id]);
  assert.equal(runs.rows[0].attempts, 1);
  assert.equal(service.commands.some((command) => command.kind === 'run_request'), false);
});

// Re-check finding 3: the device's no-output deadline ended the request (the engine let it go) while its control
// connection was down. Its one end, cancelled by no_output_timeout and released, decides the request; the run_request's
// cancelled result in the same reconcile only settles the command, and the outbox's copies of both, sent again after the
// reconcile, are the same record. The session goes on: the next request runs.
for (const restarted of [false, true]) {
  test(`an end the device reached offline is the request's outcome after ${restarted ? 'a restart of the control plane' : 'a reconnect'}`, async () => {
    const options = fixtureCatalog();
    const store = new MemoryObjectStore();
    let plane = new ControlPlane(database.pool, store, options);
    const pair = await setupPair(plane, database.pool);
    const session = await startSession(plane, pair);
    const request = await plane.submitRequest(pair.user, session.id, randomUUID(), { prompt: 'silent engine' });
    const run = await pair.next('service', 'run_request');
    await pair.send('service', 'request.accepted', accepted(request));
    await pair.send('service', 'output.chunk', chunk(request, '1', 'A'));
    if (restarted) {
      plane = new ControlPlane(database.pool, store, options);
      await plane.recover();
      pair.devices.helper.connection = (await reconnect(plane, pair, 'helper')).connection;
    } else await plane.closeDevice(pair.devices.service.id, pair.devices.service.connection);
    const error = { code: 'no_output_timeout', message: 'the serving engine gave no output in time', field: null,
      device_id: pair.devices.service.id, phase: 'serve', retryable: false };
    const end = { request_id: request.id, instance_id: request.instance_id, final_seq: '1', outcome: 'cancelled', reason: 'cancelled',
      released: true, prompt_tokens: 1, output_tokens: '1', timing: EMPTY_TIMING, statistics: EMPTY_STATS, error };
    const result = { command_id: run.command_id, outcome: 'cancelled', result: {}, error };
    const service = await reconnect(plane, pair, 'service', [{ request_id: request.id, instance_id: request.instance_id,
      http_stream_alive: false, local_contiguous_seq: '1', local_final_seq: '1', complete_buffer: true, end }],
    [{ command_id: run.command_id, state: 'cancelled', result: {}, error }]);
    pair.devices.service.connection = service.connection;
    await service.send('request.end', end);                    // the outbox, after the reconcile
    await service.send('command.result', result);
    assert.equal(service.events.some(event => event.type === 'error'), false, JSON.stringify(service.events.filter(event => event.type === 'error')));
    const settled = await plane.getRequest(pair.user, request.id);
    assert.deepEqual([settled.state, settled.cancel_reason, settled.error?.code, settled.archive_state], ['cancelled', null, 'no_output_timeout', 'saved']);
    assert.deepEqual(settled.engine_end, end);
    assert.equal(service.commands.some(command => command.kind === 'cancel_request'), false, 'no fault cancel');
    assert.equal((await database.pool.query('SELECT state FROM commands WHERE id=$1', [run.command_id])).rows[0].state, 'completed');
    assert.equal((await plane.getSession(pair.user, session.id)).state, 'ready');
    const next = await plane.submitRequest(pair.user, session.id, randomUUID(), { prompt: 'next' });
    await plane.dispatch();
    const again = service.commands.find(command => command.kind === 'run_request' && command.request_id === next.id);
    await service.send('command.ack', { command_id: again.command_id, state: 'executing' });
    await service.send('request.accepted', accepted(next));
    await service.send('output.chunk', chunk(next, '1', 'A'));
    await service.send('output.chunk', chunk(next, '2', 'B'));
    await service.send('request.end', completedEnd(next));
    assert.equal((await plane.getRequest(pair.user, next.id)).state, 'completed');
  });
}

test('recover gives every device one fresh thirty-second heartbeat window without extending business deadlines', async () => {
  let now = new Date('2026-11-08T12:30:00Z');
  const options = { ...fixtureCatalog(), now: () => now };
  let plane = new ControlPlane(database.pool, new MemoryObjectStore(), options);
  const pair = await setupPair(plane, database.pool);
  const session = await plane.createSession(pair.user, randomUUID(), pair.plan);
  await pair.next('service', 'prepare');
  await pair.next('helper', 'prepare');
  const businessDeadline = (await plane.getSession(pair.user, session.id)).phase_deadline_at;

  now = new Date(now.getTime() + 120_000);
  plane = new ControlPlane(database.pool, new MemoryObjectStore(), options);
  await plane.recover();
  for (const role of ['service', 'helper'] as const) {
    const device = await plane.getDevice(pair.user, pair.devices[role].id);
    assert.notEqual(device.state, 'offline');
    assert.equal(device.reconciled_at, null);
    assert.equal(device.heartbeat_deadline_at, new Date(now.getTime() + 30_000).toISOString());
  }
  assert.equal((await plane.getSession(pair.user, session.id)).phase_deadline_at, businessDeadline);

  now = new Date(now.getTime() + 29_999);
  await plane.tick();
  assert.notEqual((await plane.getDevice(pair.user, pair.devices.service.id)).state, 'offline');
  now = new Date(now.getTime() + 2);
  await plane.tick();
  assert.equal((await plane.getDevice(pair.user, pair.devices.service.id)).state, 'offline');
});

test('restart fails and stops a session when the device cannot prove the original request stream', async () => {
  const options = { ...fixtureCatalog(), now: () => new Date('2026-11-08T13:00:00Z') };
  let plane = new ControlPlane(database.pool, new MemoryObjectStore(), options);
  const pair = await setupPair(plane, database.pool);
  const session = await startSession(plane, pair);
  const request = await plane.submitRequest(pair.user, session.id, randomUUID(), { prompt: 'lost stream' });
  await pair.next('service', 'run_request');
  await pair.send('service', 'request.accepted', accepted(request));

  plane = new ControlPlane(database.pool, new MemoryObjectStore(), options);
  await plane.recover();
  await reconnect(plane, pair, 'helper');
  const service = await reconnect(plane, pair, 'service', []);

  const failed = await plane.getRequest(pair.user, request.id);
  assert.equal(failed.state, 'failed');
  assert.equal(failed.error.code, 'reconcile_failed');
  const stopping = await plane.getSession(pair.user, session.id);
  assert.equal(stopping.state, 'stopping');
  assert.equal(stopping.stop_cause, 'reconcile_failure');
  assert.equal(service.commands.some((command) => command.kind === 'stop'), true);
});

test('an unconfirmed cancellation reaches its persisted deadline and stops the session', async () => {
  let now = new Date('2026-11-08T14:00:00Z');
  const plane = new ControlPlane(database.pool, new MemoryObjectStore(), {
    ...fixtureCatalog(),
    now: () => now,
  });
  const pair = await setupPair(plane, database.pool);
  const session = await startSession(plane, pair);
  const request = await plane.submitRequest(pair.user, session.id, randomUUID(), { prompt: 'timeout' });
  await pair.next('service', 'run_request');
  await pair.send('service', 'request.accepted', accepted(request));

  const initial = await plane.getRequest(pair.user, request.id);
  const beforeNoOutput = new Date(new Date(initial.no_output_deadline_at).getTime() - 1);
  while (beforeNoOutput.getTime() - now.getTime() > 20_000) {
    now = new Date(now.getTime() + 20_000);
    await heartbeat(plane, pair, 'service');
    await heartbeat(plane, pair, 'helper');
  }
  now = beforeNoOutput;
  await heartbeat(plane, pair, 'service');
  await heartbeat(plane, pair, 'helper');
  now = new Date(now.getTime() + 2);
  await plane.tick();
  const cancelling = await plane.getRequest(pair.user, request.id);
  assert.equal(cancelling.state, 'cancelling');
  assert.ok(cancelling.cancel_deadline_at);

  const beforeCancel = new Date(new Date(cancelling.cancel_deadline_at).getTime() - 1);
  while (beforeCancel.getTime() - now.getTime() > 20_000) {
    now = new Date(now.getTime() + 20_000);
    await heartbeat(plane, pair, 'service');
    await heartbeat(plane, pair, 'helper');
  }
  now = beforeCancel;
  await heartbeat(plane, pair, 'service');
  await heartbeat(plane, pair, 'helper');
  now = new Date(now.getTime() + 2);
  await plane.tick();

  const failed = await plane.getRequest(pair.user, request.id);
  assert.equal(failed.state, 'failed');
  assert.equal(failed.error.code, 'cancel_timeout');
  const stopping = await plane.getSession(pair.user, session.id);
  assert.equal(stopping.state, 'stopping');
  assert.equal(stopping.stop_cause, 'cancel_timeout');
});

test('object-store failure marks archival failed while preserving readable chunks', async () => {
  const failingStore: ObjectStore = {
    async put() {
      throw new Error('fixture put failure');
    },
    async get() {
      throw new Error('fixture object absent');
    },
  };
  const plane = new ControlPlane(database.pool, failingStore, fixtureCatalog());
  const pair = await setupPair(plane, database.pool);
  const session = await startSession(plane, pair);
  const request = await plane.submitRequest(pair.user, session.id, randomUUID(), { prompt: 'archive' });
  await sendOutput(plane, pair, request);

  const failed = await plane.getRequest(pair.user, request.id);
  assert.equal(failed.state, 'failed');
  assert.equal(failed.archive_state, 'failed');
  assert.equal(failed.archive_error.code, 'archive_failed');
  assert.deepEqual(
    (await plane.getChunks(pair.user, request.id, '0', 100)).chunks.map((item: any) => item.text),
    ['A', 'B'],
  );
  await assert.rejects(plane.getResult(pair.user, request.id), /archive_failed/);
});

test('conflicting content for one sequence fails the request and blocks another submission', async () => {
  const plane = new ControlPlane(database.pool, new MemoryObjectStore(), fixtureCatalog());
  const pair = await setupPair(plane, database.pool);
  const session = await startSession(plane, pair);
  const request = await plane.submitRequest(pair.user, session.id, randomUUID(), { prompt: 'conflict' });
  await pair.next('service', 'run_request');
  await pair.send('service', 'request.accepted', accepted(request));
  await pair.send('service', 'output.chunk', chunk(request, '1', 'A'));
  await assert.rejects(
    pair.send('service', 'output.chunk', chunk(request, '1', 'different')),
    /chunk_conflict/,
  );

  const failed = await plane.getRequest(pair.user, request.id);
  assert.equal(failed.state, 'failed');
  assert.equal(failed.error.code, 'chunk_conflict');
  assert.equal((await plane.getSession(pair.user, session.id)).state, 'stopping');
  await assert.rejects(
    plane.submitRequest(pair.user, session.id, randomUUID(), { prompt: 'must not run' }),
    /session_not_ready/,
  );
});

test('an unconfirmed close_test timeout keeps the port reserved and creates another cleanup command', async () => {
  let now = new Date('2026-11-08T15:00:00Z');
  const plane = new ControlPlane(database.pool, new MemoryObjectStore(), {
    ...fixtureCatalog(),
    now: () => now,
  });
  const pair = await setupPair(plane, database.pool);
  const connectivity = await plane.createConnectionTest(pair.user, {
    source_device_id: pair.devices.helper.id,
    target_device_id: pair.devices.service.id,
    target_addresses: ['192.0.2.1'],
    port: 40360,
    listener_python: '/fixture/python',
  });
  await pair.next('service', 'listen_test');

  const beforeTestDeadline = new Date(new Date(connectivity.deadline_at).getTime() - 1);
  while (beforeTestDeadline.getTime() - now.getTime() > 20_000) {
    now = new Date(now.getTime() + 20_000);
    await idleHeartbeat(pair, 'service');
    await idleHeartbeat(pair, 'helper');
  }
  now = beforeTestDeadline;
  await idleHeartbeat(pair, 'service');
  await idleHeartbeat(pair, 'helper');
  now = new Date(now.getTime() + 2);
  await plane.tick();
  const firstClose = await pair.next('service', 'close_test');

  await assert.rejects(
    plane.createConnectionTest(pair.user, {
      source_device_id: pair.devices.helper.id,
      target_device_id: pair.devices.service.id,
      target_addresses: ['192.0.2.1'],
      port: 40360,
      listener_python: '/fixture/python',
    }),
    /port_busy/,
  );

  const beforeCloseDeadline = new Date(new Date(firstClose.deadline_at).getTime() - 1);
  while (beforeCloseDeadline.getTime() - now.getTime() > 20_000) {
    now = new Date(now.getTime() + 20_000);
    await idleHeartbeat(pair, 'service');
    await idleHeartbeat(pair, 'helper');
  }
  now = beforeCloseDeadline;
  await idleHeartbeat(pair, 'service');
  now = new Date(now.getTime() + 2);
  await plane.tick();
  const retriedClose = await pair.next('service', 'close_test');
  assert.notEqual(retriedClose.command_id, firstClose.command_id);
  assert.equal((await plane.getTest(pair.user, connectivity.id)).listener_closed_at, null);
});

test('a stop result from before a restart of the device is taken as history in the next reconcile', async () => {
  // the device stopped the instance and recorded the stop's result, then
  // restarted (a new boot) before the result reached the control plane; its reconcile carries its instances as the
  // new boot sees them and the old result, whose instance reports name the old boot
  const plane = new ControlPlane(database.pool, new MemoryObjectStore(), fixtureCatalog());
  const pair = await setupPair(plane, database.pool);
  const session = await startSession(plane, pair);
  await plane.stopSession(pair.user, session.id);
  const stop = await pair.next('service', 'stop');
  const old = await pair.report('service', 'stopped');
  const boot = randomUUID();
  await pair.reopen('service', boot);
  await pair.send('service', 'reconcile', {
    agent_boot_id: boot,
    inventory: inventory('service'),
    instances: [{ ...old, agent_boot_id: boot }],
    commands: [{ command_id: stop.command_id, state: 'completed', result: { instances: [old], ports_free: true }, error: null }],
    requests: [],
  });
  const command = (await database.pool.query('SELECT state FROM commands WHERE id=$1', [stop.command_id])).rows[0];
  assert.equal(command.state, 'completed');
  const device = (await database.pool.query('SELECT agent_boot_id, reconciled_at FROM devices WHERE id=$1', [pair.devices.service.id])).rows[0];
  assert.equal(device.agent_boot_id, boot);
  assert.ok(device.reconciled_at);
});

// M24: a request still pending when the serving machine went away keeps no disconnect
// deadline once its device reconciled, even when the session's deadline passes while that reconcile is applied (then the
// session does not resume, and its resume does not clear the request's deadline for it).
test('a pending request found by a reconcile that crosses its deadline loses the deadline', async () => {
  let now = new Date('2026-11-08T20:00:00Z');
  const plane = new ControlPlane(database.pool, new MemoryObjectStore(), { ...fixtureCatalog(), now: () => now });
  const pair = await setupPair(plane, database.pool);
  const session = await startSession(plane, pair);
  const dispatch = (plane as any).dispatch.bind(plane);
  (plane as any).dispatch = async () => {};              // the connection is lost after the request's commit, before its dispatch
  const request = await plane.submitRequest(pair.user, session.id, randomUUID(), { prompt: 'pending' });
  await plane.closeDevice(pair.devices.service.id, pair.devices.service.connection);
  (plane as any).dispatch = dispatch;
  assert.equal((await plane.getRequest(pair.user, request.id)).state, 'pending');
  const deadline = new Date((await plane.getRequest(pair.user, request.id)).disconnect_deadline_at).getTime();
  now = new Date(deadline - 2);
  const device = pair.devices.service;
  const connection = await plane.openDevice(device.id, device.credential, () => {});
  const sweep = (plane as any).sweep.bind(plane);
  (plane as any).sweep = async () => { await sweep(); now = new Date(deadline + 1); };   // the reconcile's own sweep is done
  await plane.handleDevice(device.id, connection, 'reconcile', {
    agent_boot_id: device.boot, inventory: inventory('service'), instances: [await pair.report('service', 'connectable')], commands: [], requests: [],
  });
  (plane as any).sweep = sweep;
  const seen = await plane.getRequest(pair.user, request.id);
  assert.equal(seen.disconnect_deadline_at, null);
});
