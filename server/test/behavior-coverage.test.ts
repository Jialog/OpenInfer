import { randomUUID } from 'node:crypto';
import assert from 'node:assert/strict';
import { after, before, test } from 'node:test';

import { ControlPlane } from '../src/control.ts';
import { EMPTY_STATS, EMPTY_TIMING } from '../src/protocol.ts';
import { MemoryObjectStore } from '../src/storage.ts';
import { createDatabase } from './postgres.ts';
import { fixtureCatalog, fixtureProof, setupPair, startSession } from './fixtures.ts';

// The faults the mutation harness (mutations.mjs) plants, by ID: each names the
// behavior that must catch it.
export const MUTATION_COVERAGE = [
  ['M01', 'helper instance exit degrades a ready session', 'session exits, disconnects, and terminal cleanup'],
  ['M02', 'offline during startup begins stop', 'offline and disconnect deadlines preserve their one-shot semantics'],
  ['M03', 'warmup requires both peers to report one authenticated connection', 'startup sequencing requires service readiness and matching peer proof'],
  ['M04', 'service disconnect deadline stops the session', 'offline and disconnect deadlines preserve their one-shot semantics'],
  ['M05', 'a blocked session refuses a submission as not ready before it counts its requests', 'a submission to a session whose serving machine is gone is refused as not ready, even when the session is busy'],
  ['M06', 'helper control disconnect alone leaves submission enabled', 'offline and disconnect deadlines preserve their one-shot semantics'],
  ['M07', 'helper reconnect requires the old instance stopped', 'manual helper reconnect enforces stopped instance and valid direction'],
  ['M08', 'helper reconnect requires a valid direction record', 'manual helper reconnect enforces stopped instance and valid direction'],
  ['M09', 'terminal session late activity dispatches cleanup', 'session exits, disconnects, and terminal cleanup'],
  ['M10', 'preflight checks connection direction', 'preflight independently checks direction, validity, listener closure, idle devices, and capacity'],
  ['M11', 'preflight checks measurement validity', 'preflight independently checks direction, validity, listener closure, idle devices, and capacity'],
  ['M12', 'preflight requires listener closure', 'preflight independently checks direction, validity, listener closure, idle devices, and capacity'],
  ['M13', 'preflight requires idle devices', 'preflight independently checks direction, validity, listener closure, idle devices, and capacity'],
  ['M14', 'preflight checks capacity', 'preflight independently checks direction, validity, listener closure, idle devices, and capacity'],
  ['M15', 'removing an offline service stops its session', 'permanent removal applies service and helper role semantics'],
  ['M16', 'removing an offline helper degrades its session', 'permanent removal applies service and helper role semantics'],
  ['M17', 'unacknowledged command retries with the same id', 'command retry preserves id and original acknowledgement deadline'],
  ['M18', 'command retry does not reset acknowledgement deadline', 'command retry preserves id and original acknowledgement deadline'],
  ['M19', 'late startup result dispatches cleanup', 'late startup result creates cleanup without reviving the command'],
  ['M20', 'duplicate output does not extend deadlines', 'request deadlines and duplicate chunks are monotonic'],
  ['M21', 'drain expiry moves active request to cancelling', 'request deadlines and duplicate chunks are monotonic'],
  ['M22', 'device restart cannot claim an unproved stream', 'request recovery requires original stream proof and clears deadlines only on proof'],
  ['M23', 'a request fails at its own disconnect deadline', 'a request draining after a user stop still fails at its disconnect deadline'],
  ['M24', 'reconcile clears a pending request deadline', 'a pending request found by a reconcile that crosses its deadline loses the deadline'],
  ['M25', 'expired request end cannot revive persistence', 'request deadlines and duplicate chunks are monotonic'],
  ['M26', 'repeat disconnect preserves first deadline', 'offline and disconnect deadlines preserve their one-shot semantics'],
  ['M27', 'write paths enforce group ownership', 'read and write APIs reject a different group'],
  ['M28', 'read paths enforce group ownership', 'read and write APIs reject a different group'],
  ['M29', 'start command carries the session key', 'session key is device-only and session creation is idempotent'],
  ['M30', 'browser session view omits the session key', 'session key is device-only and session creation is idempotent'],
  ['M31', 'session creation idempotency key returns one session', 'session key is device-only and session creation is idempotent'],
  ['M32', 'service failure stops the session', 'service failure stops session'],
  ['M33', 'push disconnect degrades the session', 'helper loss degrades'],
  ['M34', 'helper start waits for service connectable', 'startup sequencing requires service readiness and matching peer proof'],
  ['M35', 'device reservation remains until instance stopped', 'completed stop requires exactly one report'],
  ['M36', 'conflicting chunk fails request', 'conflicting content for one sequence'],
  ['M37', 'archive waits for all chunks', 'restart reconciles the original stream'],
  ['M38', 'cancel timeout stops session', 'unconfirmed cancellation reaches'],
  ['M39', 'stop timeout retains uncleared devices', 'restart in startup and stop preserves deadlines'],
  ['M40', 'CSRF rejects an invalid modifying request', 'modifying requests enforce Origin and CSRF'],
  ['M41', 'request submission idempotency returns one request', 'fake devices traverse enrollment'],
] as const;

let db: Awaited<ReturnType<typeof createDatabase>>;
before(async () => { db = await createDatabase(); });
after(async () => db.close());

test('mutation map has 41 stable, unique IDs', () => {
  assert.equal(MUTATION_COVERAGE.length, 41);
  assert.equal(new Set(MUTATION_COVERAGE.map(([id]) => id)).size, 41);
  assert.deepEqual(MUTATION_COVERAGE.map(([id]) => id), Array.from({ length: 41 }, (_, i) => `M${String(i + 1).padStart(2, '0')}`));
});

test('preflight independently checks direction, validity, listener closure, idle devices, and capacity [M10-M14]', async () => {
  const plane = new ControlPlane(db.pool, new MemoryObjectStore(), fixtureCatalog());
  const pair = await setupPair(plane, db.pool);
  const testId = pair.plan.helpers[0].connection_test_id;
  const original = (await db.pool.query('SELECT * FROM connection_tests WHERE id=$1', [testId])).rows[0];
  const denied = async () => {
    const result = await plane.preflight(pair.user, pair.plan);
    assert.equal(result.allowed, false);
    return result;
  };

  await db.pool.query('UPDATE connection_tests SET source_device_id=$2,target_device_id=$3 WHERE id=$1', [testId, original.target_device_id, original.source_device_id]);
  assert.equal((await denied()).checks.some((x: any) => x.code === 'direction_unreachable' && !x.passed), true);
  await db.pool.query('UPDATE connection_tests SET source_device_id=$2,target_device_id=$3,valid_until=$4 WHERE id=$1', [testId, original.source_device_id, original.target_device_id, new Date(0)]);
  assert.equal((await denied()).checks.some((x: any) => x.code === 'direction_unreachable' && !x.passed), true);
  await db.pool.query('UPDATE connection_tests SET valid_until=$2,listener_closed_at=NULL WHERE id=$1', [testId, original.valid_until]);
  assert.equal((await denied()).checks.some((x: any) => x.code === 'direction_unreachable' && !x.passed), true);
  await db.pool.query('UPDATE connection_tests SET listener_closed_at=$2 WHERE id=$1', [testId, original.listener_closed_at]);
  await db.pool.query("UPDATE devices SET state='occupied' WHERE id=$1", [pair.devices.helper.id]);
  assert.equal((await denied()).checks.some((x: any) => x.code === 'control_online' && !x.passed), true);
  await db.pool.query("UPDATE devices SET state='idle' WHERE id=$1", [pair.devices.helper.id]);

  const options = fixtureCatalog();
  options.requirements.service.memory_bytes = '999999999999';
  const lowCapacity = await new ControlPlane(db.pool, new MemoryObjectStore(), options).preflight(pair.user, pair.plan);
  assert.equal(lowCapacity.checks.some((x: any) => x.code === 'capacity_insufficient' && !x.passed), true);
});

test('command retry preserves id and original acknowledgement deadline [M17-M18]', async () => {
  let now = new Date('2026-11-08T12:00:00Z');
  const plane = new ControlPlane(db.pool, new MemoryObjectStore(), { ...fixtureCatalog(), now: () => now });
  const pair = await setupPair(plane, db.pool);
  await plane.createSession(pair.user, randomUUID(), pair.plan);
  const command = pair.commands.find((x: any) => x.kind === 'prepare' && x.role === 'service');
  const first = (await db.pool.query('SELECT ack_deadline_at,attempts FROM commands WHERE id=$1', [command.command_id])).rows[0];
  const eventOffset = pair.events.length;
  now = new Date(now.getTime() + 5_001);
  await plane.dispatch();
  const retried = pair.events.slice(eventOffset).find((x: any) => x.type === 'command' && x.payload.command_id === command.command_id);
  const second = (await db.pool.query('SELECT ack_deadline_at,attempts FROM commands WHERE id=$1', [command.command_id])).rows[0];
  assert.equal(retried?.payload.command_id, command.command_id);
  assert.equal(second.ack_deadline_at.toISOString(), first.ack_deadline_at.toISOString());
  assert.equal(second.attempts, first.attempts + 1);
});

test('read and write APIs reject a different group [M27-M28]', async () => {
  const plane = new ControlPlane(db.pool, new MemoryObjectStore(), fixtureCatalog());
  const pair = await setupPair(plane, db.pool);
  const session = await plane.createSession(pair.user, randomUUID(), pair.plan);
  const outsider = { user_id: randomUUID(), group_id: randomUUID() };
  await assert.rejects(plane.getSession(outsider, session.id), /forbidden/);
  await assert.rejects(plane.stopSession(outsider, session.id), /forbidden/);
  assert.equal((await db.pool.query('SELECT state FROM sessions WHERE id=$1', [session.id])).rows[0].state, 'starting');
});

test('session key is device-only and session creation is idempotent [M29-M31]', async () => {
  const plane = new ControlPlane(db.pool, new MemoryObjectStore(), fixtureCatalog());
  const pair = await setupPair(plane, db.pool);
  const key = randomUUID();
  const first = await plane.createSession(pair.user, key, pair.plan);
  const second = await plane.createSession(pair.user, key, { ...pair.plan, service_version_id: 'changed' });
  assert.equal(second.id, first.id);
  assert.equal('session_key' in first, false);
  assert.equal(JSON.stringify(first).includes('session_key'), false);
  for (const role of ['service', 'helper'] as const) {
    const prepare = await pair.next(role, 'prepare');
    await pair.result(role, prepare, {
      manifest_sha256: 'a'.repeat(64),
      prepared_version_id: role,
      build: fixtureProof(prepare.payload.version),
    });
  }
  const start = pair.events.find((x: any) => x.type === 'command' && x.payload.kind === 'start_service');
  assert.equal(typeof start?.payload.payload.session_auth?.key, 'string');
});

test('manual helper reconnect enforces stopped instance and valid direction [M07-M08]', async () => {
  const plane = new ControlPlane(db.pool, new MemoryObjectStore(), fixtureCatalog());
  const pair = await setupPair(plane, db.pool);
  const session = await startSession(plane, pair);
  await pair.peer(false);
  const testId = pair.plan.helpers[0].connection_test_id;
  const target = (await db.pool.query('SELECT target_address FROM connection_tests WHERE id=$1', [testId])).rows[0].target_address;
  await db.pool.query('UPDATE connection_tests SET target_address=$2 WHERE id=$1', [testId, '198.51.100.99']);
  await assert.rejects(plane.reconnectHelper(pair.user, session.id, pair.devices.helper.id), /direction_unreachable/);
  await db.pool.query('UPDATE connection_tests SET target_address=$2 WHERE id=$1', [testId, target]);
  await plane.reconnectHelper(pair.user, session.id, pair.devices.helper.id);
  const stop = await pair.next('helper', 'stop');
  assert.equal(stop.payload.reason, 'manual_reconnect');
  assert.equal(pair.commands.some((command: any) => command.kind === 'prepare' && !command.used), false);
});

test('offline and disconnect deadlines preserve their one-shot semantics [M02,M04-M06,M26]', async () => {
  let now = new Date('2026-11-08T15:00:00Z');
  const plane = new ControlPlane(db.pool, new MemoryObjectStore(), { ...fixtureCatalog(), now: () => now });
  const pair = await setupPair(plane, db.pool);
  const session = await startSession(plane, pair);
  await pair.peer(false);
  assert.equal((await plane.getSession(pair.user, session.id)).state, 'degraded');

  await plane.closeDevice(pair.devices.helper.id, pair.devices.helper.connection);
  assert.equal((await plane.getSession(pair.user, session.id)).submissions_blocked, false);
  await plane.closeDevice(pair.devices.service.id, pair.devices.service.connection);
  const disconnected = await plane.getSession(pair.user, session.id);
  assert.equal(disconnected.submissions_blocked, true);
  const firstDeadline = disconnected.service_disconnect_deadline_at;
  await assert.rejects(plane.submitRequest(pair.user, session.id, randomUUID(), { prompt: 'blocked' }), /session_not_ready/);

  const connection = await plane.openDevice(pair.devices.service.id, pair.devices.service.credential, () => {});
  now = new Date(now.getTime() + 1_000);
  await plane.closeDevice(pair.devices.service.id, connection);
  assert.equal((await plane.getSession(pair.user, session.id)).service_disconnect_deadline_at, firstDeadline);
  now = new Date(new Date(firstDeadline).getTime() + 1);
  await plane.tick();
  assert.equal((await plane.getSession(pair.user, session.id)).state, 'stopping');

  const startupPlane = new ControlPlane(db.pool, new MemoryObjectStore(), { ...fixtureCatalog(), now: () => now });
  const startupPair = await setupPair(startupPlane, db.pool);
  const startup = await startupPlane.createSession(startupPair.user, randomUUID(), startupPair.plan);
  await startupPair.next('service', 'prepare');
  await startupPair.next('helper', 'prepare');
  now = new Date(now.getTime() + 30_001);
  await startupPlane.tick();
  assert.equal((await startupPlane.getSession(startupPair.user, startup.id)).state, 'stopping');
});

test('startup sequencing requires service readiness and the serving machine reporting each helper [M03,M34]', async () => {
  const plane = new ControlPlane(db.pool, new MemoryObjectStore(), fixtureCatalog());
  const pair = await setupPair(plane, db.pool);
  await plane.createSession(pair.user, randomUUID(), pair.plan);
  for (const role of ['service', 'helper'] as const) {
    const prepare = await pair.next(role, 'prepare');
    await pair.result(role, prepare, { manifest_sha256: 'a'.repeat(64), prepared_version_id: role, build: fixtureProof(prepare.payload.version) });
  }
  assert.equal(pair.commands.some((x: any) => x.kind === 'start_helper'), false);
  const serviceStart = await pair.next('service', 'start_service');
  await pair.result('service', serviceStart, { instance: await pair.report('service', 'connectable') });
  const helperStart = await pair.next('helper', 'start_helper');
  await pair.result('helper', helperStart, { instance: await pair.report('helper', 'connectable') });
  const service = await pair.report('service', 'connectable');
  const helper = await pair.report('helper', 'connectable');
  // a helper does not report its own connection: only the serving machine's draft table knows its writers
  await assert.rejects(pair.send('helper', 'peer.status', { session_id: helper.session_id, instance_id: helper.instance_id, peer_instance_id: service.instance_id, push_connection_id: randomUUID(), state: 'connected', authenticated: false, error: null }),
    (e: any) => e.code === 'invalid_input');
  assert.equal(pair.commands.some((x: any) => x.kind === 'warmup'), false);
  await pair.peer(true);
  assert.equal(pair.commands.some((x: any) => x.kind === 'warmup'), true);
});

test('late startup result creates cleanup without reviving the command [M19]', async () => {
  const plane = new ControlPlane(db.pool, new MemoryObjectStore(), fixtureCatalog());
  const pair = await setupPair(plane, db.pool);
  const session = await plane.createSession(pair.user, randomUUID(), pair.plan);
  const prepare = await pair.next('service', 'prepare');
  await plane.stopSession(pair.user, session.id);
  await pair.result('service', prepare, { manifest_sha256: 'a'.repeat(64), prepared_version_id: 'service', build: fixtureProof(prepare.payload.version) });
  const cleanup = await db.pool.query("SELECT 1 FROM commands WHERE session_id=$1 AND kind='stop' AND payload->>'reason'='late_result'", [session.id]);
  assert.equal(cleanup.rowCount, 1);
  assert.equal((await db.pool.query('SELECT state FROM commands WHERE id=$1', [prepare.command_id])).rows[0].state, 'cancelled');
});

test('permanent removal applies service and helper role semantics [M15-M16]', async () => {
  for (const role of ['service', 'helper'] as const) {
    const plane = new ControlPlane(db.pool, new MemoryObjectStore(), fixtureCatalog());
    const pair = await setupPair(plane, db.pool);
    const session = await startSession(plane, pair);
    const device = pair.devices[role];
    await db.pool.query("UPDATE devices SET state='offline',cleanup_required=true,reconciled_at=NULL WHERE id=$1", [device.id]);
    await plane.removeDevice(pair.user, device.id, true);
    assert.equal((await plane.getDevice(pair.user, device.id)).state, 'removed');
    assert.equal((await plane.getSession(pair.user, session.id)).state, role === 'service' ? 'stopping' : 'degraded');
  }
});

test('request deadlines and duplicate chunks are monotonic [M20-M21,M25]', async () => {
  let now = new Date('2026-11-08T18:00:00Z');
  const plane = new ControlPlane(db.pool, new MemoryObjectStore(), { ...fixtureCatalog(), now: () => now });
  const pair = await setupPair(plane, db.pool);
  const session = await startSession(plane, pair);
  const request = await plane.submitRequest(pair.user, session.id, randomUUID(), { prompt: 'deadline' });
  await pair.next('service', 'run_request');
  await pair.send('service', 'request.accepted', {
    request_id: request.id, instance_id: request.instance_id, prompt_tokens: 1,
    effective_max_output: 4095, committed_position: '1',
    timing: { ...EMPTY_TIMING, clock_id: request.instance_id, engine_received_ns: '0' },
  });
  const chunk = {
    request_id: request.id, instance_id: request.instance_id, seq: '1', text: 'A', token_count: 1, segment: 'answer',
    committed_position: '2', engine_first_output_ns: '1', engine_last_output_ns: '1', engine_first_chunk_tokens: 1,
  };
  await pair.send('service', 'output.chunk', chunk);
  const deadline = (await plane.getRequest(pair.user, request.id)).no_output_deadline_at;
  now = new Date(now.getTime() + 1_000);
  await pair.send('service', 'output.chunk', chunk);
  assert.equal((await plane.getRequest(pair.user, request.id)).no_output_deadline_at, deadline);

  await db.pool.query('UPDATE requests SET persistence_deadline_at=$2,no_output_deadline_at=$3 WHERE id=$1', [request.id, new Date(now.getTime() - 1), new Date(now.getTime() + 600_000)]);
  await pair.send('service', 'request.end', {
    request_id: request.id, instance_id: request.instance_id, final_seq: '1', outcome: 'completed', reason: 'length',
    released: true, prompt_tokens: 1, output_tokens: '1', timing: EMPTY_TIMING, statistics: EMPTY_STATS, error: null,
  });
  const expired = await plane.getRequest(pair.user, request.id);
  assert.notEqual(expired.engine_end, null);
  assert.equal(expired.state, 'failed');
  assert.equal(expired.error.code, 'persistence_failed');

  const drainPlane = new ControlPlane(db.pool, new MemoryObjectStore(), { ...fixtureCatalog(), now: () => now });
  const drainPair = await setupPair(drainPlane, db.pool);
  const drainSession = await startSession(drainPlane, drainPair);
  const draining = await drainPlane.submitRequest(drainPair.user, drainSession.id, randomUUID(), { prompt: 'drain' });
  await drainPair.next('service', 'run_request');
  await drainPlane.stopSession(drainPair.user, drainSession.id);
  const stopping = await drainPlane.getSession(drainPair.user, drainSession.id);
  now = new Date(new Date(stopping.drain_deadline_at).getTime() + 1);
  await drainPlane.tick();
  assert.equal((await drainPlane.getRequest(drainPair.user, draining.id)).state, 'cancelling');
});

test('device reservation remains until its instance is stopped [M35]', async () => {
  const plane = new ControlPlane(db.pool, new MemoryObjectStore(), fixtureCatalog());
  const pair = await setupPair(plane, db.pool);
  const session = await startSession(plane, pair);
  await plane.stopSession(pair.user, session.id);
  const helperStop = await pair.next('helper', 'stop');
  await pair.result('helper', helperStop, { instances: [await pair.report('helper', 'stopped')], ports_free: true });
  assert.equal((await plane.getSession(pair.user, session.id)).state, 'stopping');
  assert.equal((await plane.getDevice(pair.user, pair.devices.service.id)).state, 'occupied');
});

test('session exits, disconnects, and terminal cleanup are observable [M01,M09,M31-M33]', async () => {
  const plane = new ControlPlane(db.pool, new MemoryObjectStore(), fixtureCatalog());
  const pair = await setupPair(plane, db.pool);
  const session = await startSession(plane, pair);
  await pair.status('helper', 'stopped');
  assert.equal((await plane.getSession(pair.user, session.id)).state, 'degraded');
  await pair.status('service', 'failed');
  assert.equal((await plane.getSession(pair.user, session.id)).state, 'stopping');

  const terminalPlane = new ControlPlane(db.pool, new MemoryObjectStore(), fixtureCatalog());
  const terminalPair = await setupPair(terminalPlane, db.pool);
  const terminal = await startSession(terminalPlane, terminalPair);
  await terminalPlane.stopSession(terminalPair.user, terminal.id);
  await terminalPair.stopAll();
  assert.equal((await terminalPlane.getSession(terminalPair.user, terminal.id)).state, 'ended');
  const service = await terminalPair.report('service', 'ready');
  await terminalPair.status('service', 'ready');
  const cleanup = terminalPair.commands.find((command: any) =>
    command.kind === 'stop' && !command.used &&
    command.instance_refs?.some((ref: any) => ref.instance_id === service.instance_id));
  assert.ok(cleanup);
  assert.equal((await terminalPlane.getSession(terminalPair.user, terminal.id)).state, 'ended');
});

// M05 and M23 change what a caller sees.
test('a submission to a session whose serving machine is gone is refused as not ready, even when the session is busy [M05]', async () => {
  const plane = new ControlPlane(db.pool, new MemoryObjectStore(), fixtureCatalog());
  const pair = await setupPair(plane, db.pool);
  const session = await startSession(plane, pair);
  await plane.submitRequest(pair.user, session.id, randomUUID(), { prompt: 'running' });
  await pair.next('service', 'run_request');
  await plane.closeDevice(pair.devices.service.id, pair.devices.service.connection);
  await assert.rejects(plane.submitRequest(pair.user, session.id, randomUUID(), { prompt: 'second' }), /session_not_ready/);
});

test('a request draining after a user stop still fails at its disconnect deadline [M23]', async () => {
  let now = new Date('2026-11-08T19:00:00Z');
  const plane = new ControlPlane(db.pool, new MemoryObjectStore(), { ...fixtureCatalog(), now: () => now });
  const pair = await setupPair(plane, db.pool);
  const session = await startSession(plane, pair);
  const request = await plane.submitRequest(pair.user, session.id, randomUUID(), { prompt: 'drain' });
  await pair.next('service', 'run_request');
  await pair.send('service', 'request.accepted', {
    request_id: request.id, instance_id: request.instance_id, prompt_tokens: 1, effective_max_output: 4095, committed_position: '1',
    timing: { ...EMPTY_TIMING, clock_id: request.instance_id, engine_received_ns: '0' },
  });
  const start = now.getTime();
  await plane.closeDevice(pair.devices.service.id, pair.devices.service.connection);
  now = new Date(start + 295_000);
  await plane.stopSession(pair.user, session.id);       // a user stop lets a running request drain
  assert.equal((await plane.getRequest(pair.user, request.id)).state, 'running');
  now = new Date(start + 300_001);                       // past the disconnect deadline, before the drain deadline
  await plane.tick();
  const failed = await plane.getRequest(pair.user, request.id);
  assert.deepEqual([failed.state, failed.error?.code], ['failed', 'service_offline']);
});
