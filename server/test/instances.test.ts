import { randomUUID } from 'node:crypto';
import assert from 'node:assert/strict';
import { after, before, test } from 'node:test';

import { ControlPlane } from '../src/control.ts';
import { MemoryObjectStore } from '../src/storage.ts';
import { createDatabase } from './postgres.ts';
import { fixtureCatalog, inventory, setupPair, startSession } from './fixtures.ts';

let db: Awaited<ReturnType<typeof createDatabase>>;
before(async () => { db = await createDatabase(); });
after(async () => db.close());

async function commandState(id: string) {
  return (await db.pool.query('SELECT state FROM commands WHERE id=$1', [id])).rows[0].state;
}

test('instance status binds the report to the persisted config and boot identities', async () => {
  const p = new ControlPlane(db.pool, new MemoryObjectStore(), fixtureCatalog());
  const pair = await setupPair(p, db.pool);
  await p.createSession(pair.user, randomUUID(), pair.plan);

  const wrongConfig = await pair.report('service', 'connectable');
  wrongConfig.config_sha256 = 'b'.repeat(64);
  await assert.rejects(pair.send('service', 'instance.status', wrongConfig), /instance_mismatch/);

  const wrongBoot = await pair.report('service', 'connectable');
  wrongBoot.agent_boot_id = randomUUID();
  await assert.rejects(pair.send('service', 'instance.status', wrongBoot), /instance_mismatch/);
});

test('a new agent boot may report a live old instance and receives cleanup without reviving it', async () => {
  const p = new ControlPlane(db.pool, new MemoryObjectStore(), fixtureCatalog());
  const pair = await setupPair(p, db.pool);
  await p.createSession(pair.user, randomUUID(), pair.plan);
  const old = await pair.report('service', 'ready');

  await p.closeDevice(pair.devices.service.id, pair.devices.service.connection);
  const newBoot = randomUUID();
  const connection = await pair.reopen('service', newBoot);
  const reconcile = (report: Record<string, unknown>) => p.handleDevice(
    pair.devices.service.id,
    connection,
    'reconcile',
    { agent_boot_id: newBoot, inventory: inventory('service'), instances: [report], commands: [], requests: [] },
  );

  await reconcile({ ...old, agent_boot_id: newBoot });
  const saved = (await db.pool.query('SELECT state,stopped_at FROM instances WHERE id=$1', [old.instance_id])).rows[0];
  assert.equal(saved.state, 'cleanup_required');
  assert.equal(saved.stopped_at, null);
  assert.ok(pair.commands.some((command: any) => command.kind === 'stop' && !command.used));
});

test('failed and cleanup_required instances cannot be revived by late ready reports', async () => {
  const p = new ControlPlane(db.pool, new MemoryObjectStore(), fixtureCatalog());
  const pair = await setupPair(p, db.pool);
  await p.createSession(pair.user, randomUUID(), pair.plan);
  const report = await pair.report('service', 'failed');
  await pair.send('service', 'instance.status', report);
  await pair.send('service', 'instance.status', { ...report, state: 'ready', error: null });
  assert.equal((await db.pool.query('SELECT state FROM instances WHERE id=$1', [report.instance_id])).rows[0].state, 'failed');

  const helper = await pair.report('helper', 'ready');
  await db.pool.query("UPDATE instances SET state='cleanup_required' WHERE id=$1", [helper.instance_id]);
  await pair.send('helper', 'instance.status', helper);
  assert.equal((await db.pool.query('SELECT state FROM instances WHERE id=$1', [helper.instance_id])).rows[0].state, 'cleanup_required');
});

test('completed stop requires exactly one report for every payload instance id', async () => {
  const p = new ControlPlane(db.pool, new MemoryObjectStore(), fixtureCatalog());
  const pair = await setupPair(p, db.pool);
  const session = await startSession(p, pair);
  await p.stopSession(pair.user, session.id);
  const stop = await pair.next('service', 'stop');
  const report = await pair.report('service', 'stopped');

  await assert.rejects(pair.result('service', stop, { instances: [], ports_free: true }), /invalid_input/);
  assert.equal(await commandState(stop.command_id), 'executing');
  await assert.rejects(pair.result('service', stop, { instances: [report, report], ports_free: true }), /invalid_input/);
  assert.equal(await commandState(stop.command_id), 'executing');
  await pair.result('service', stop, { instances: [report], ports_free: true });
  assert.equal(await commandState(stop.command_id), 'completed');
});

test('completed stop rejects a stopped report while an owned process is still alive', async () => {
  const p = new ControlPlane(db.pool, new MemoryObjectStore(), fixtureCatalog());
  const pair = await setupPair(p, db.pool);
  const session = await startSession(p, pair);
  await p.stopSession(pair.user, session.id);
  const stop = await pair.next('service', 'stop');
  const report = {
    ...(await pair.report('service', 'stopped', stop.instance_refs[0].instance_id)),
    processes: [{ pid: 123, process_group_id: 123, alive: true }],
  };

  await assert.rejects(
    pair.result('service', stop, { instances: [report], ports_free: true }),
    /invalid_input/,
  );
  assert.equal(await commandState(stop.command_id), 'executing');
  const instance = (
    await db.pool.query('SELECT state,stopped_at FROM instances WHERE id=$1', [report.instance_id])
  ).rows[0];
  assert.notEqual(instance.state, 'stopped');
  assert.equal(instance.stopped_at, null);
  const reservation = (
    await db.pool.query(
      'SELECT released_at FROM session_devices WHERE session_id=$1 AND device_id=$2',
      [session.id, pair.devices.service.id],
    )
  ).rows[0];
  assert.equal(reservation.released_at, null);
});

test('completed recheck requires exactly one report for every payload instance id', async () => {
  const p = new ControlPlane(db.pool, new MemoryObjectStore(), fixtureCatalog());
  const pair = await setupPair(p, db.pool);
  await p.createSession(pair.user, randomUUID(), pair.plan);
  await db.pool.query("UPDATE devices SET state='cleanup_required',cleanup_required=true WHERE id=$1", [pair.devices.service.id]);
  await p.recheckDevice(pair.user, pair.devices.service.id);
  const recheck = await pair.next('service', 'recheck');
  const report = await pair.report('service', 'stopped');

  await assert.rejects(pair.result('service', recheck, { instances: [], ports_free: true }), /invalid_input/);
  assert.equal(await commandState(recheck.command_id), 'executing');
  await assert.rejects(pair.result('service', recheck, { instances: [report, report], ports_free: true }), /invalid_input/);
  assert.equal(await commandState(recheck.command_id), 'executing');
  await pair.result('service', recheck, { instances: [report], ports_free: true });
  assert.equal(await commandState(recheck.command_id), 'completed');
});

test('recheck records stopped instances but keeps the reservation until ports are free', async () => {
  const p = new ControlPlane(db.pool, new MemoryObjectStore(), fixtureCatalog());
  const pair = await setupPair(p, db.pool);
  const session = await startSession(p, pair);
  await p.stopSession(pair.user, session.id);
  await db.pool.query(
    "UPDATE devices SET state='cleanup_required',cleanup_required=true WHERE id=$1",
    [pair.devices.service.id],
  );

  await p.recheckDevice(pair.user, pair.devices.service.id);
  const residual = await pair.next('service', 'recheck');
  const stopped = await pair.report('service', 'stopped');
  await pair.result('service', residual, { instances: [stopped], ports_free: false });

  const instance = (await db.pool.query(
    'SELECT state,stopped_at FROM instances WHERE id=$1',
    [stopped.instance_id],
  )).rows[0];
  assert.equal(instance.state, 'stopped');
  assert.ok(instance.stopped_at);
  const blocked = (await db.pool.query(
    'SELECT d.state,sd.released_at FROM devices d JOIN session_devices sd ON sd.device_id=d.id WHERE d.id=$1 AND sd.session_id=$2',
    [pair.devices.service.id, session.id],
  )).rows[0];
  assert.equal(blocked.state, 'cleanup_required');
  assert.equal(blocked.released_at, null);

  await p.recheckDevice(pair.user, pair.devices.service.id);
  const clear = await pair.next('service', 'recheck');
  // the instance of the taken port stays named until a recheck finds its port free (re-check of the device program,
  // A item 6), stopped_at or not
  assert.deepEqual(clear.payload.instance_ids, [stopped.instance_id]);
  await pair.result('service', clear, { instances: [stopped], ports_free: true });

  const released = (await db.pool.query(
    'SELECT d.state,sd.released_at FROM devices d JOIN session_devices sd ON sd.device_id=d.id WHERE d.id=$1 AND sd.session_id=$2',
    [pair.devices.service.id, session.id],
  )).rows[0];
  assert.equal(released.state, 'idle');
  assert.ok(released.released_at);
});

test('recheck clearing a terminal reservation publishes the changed session', async () => {
  let now = new Date('2026-11-09T12:00:00Z');
  const p = new ControlPlane(db.pool, new MemoryObjectStore(), {
    ...fixtureCatalog(),
    now: () => now,
  });
  const pair = await setupPair(p, db.pool);
  const session = await startSession(p, pair);
  await p.stopSession(pair.user, session.id);

  const helperStop = await pair.next('helper', 'stop');
  await pair.result('helper', helperStop, {
    instances: [await pair.report('helper', 'stopped')],
    ports_free: true,
  });
  await db.pool.query(
    'UPDATE devices SET heartbeat_deadline_at=$2 WHERE id=ANY($1::uuid[])',
    [[pair.devices.service.id, pair.devices.helper.id], new Date(now.getTime() + 120_000)],
  );
  now = new Date(now.getTime() + 51_000);
  await p.tick();

  const terminal = await p.getSession(pair.user, session.id);
  assert.equal(terminal.state, 'ended');
  assert.deepEqual(terminal.uncleared_device_ids, [pair.devices.service.id]);

  const changes: any[][] = [];
  p.on('changed', (batch) => changes.push(batch));
  await p.recheckDevice(pair.user, pair.devices.service.id);
  const recheck = await pair.next('service', 'recheck');
  await pair.result('service', recheck, {
    instances: [await pair.report('service', 'stopped')],
    ports_free: true,
  });

  assert.deepEqual((await p.getSession(pair.user, session.id)).uncleared_device_ids, []);
  assert.ok(
    changes.flat().some((change) => change.table === 'sessions' && change.id === session.id),
    'releasing the terminal reservation must publish a session target for incremental clients',
  );
});

// The first session downloads the model for minutes. An instance that is downloading carries the bytes its
// prepare command has reported (commands.progress_*), so the website can show how far the download is; outside the
// download phase it carries none.
test('a downloading instance carries the bytes its prepare command reported, and none outside the download', async () => {
  const at = new Date('2026-11-14T19:05:40Z');
  const p = new ControlPlane(db.pool, new MemoryObjectStore(), { ...fixtureCatalog(), now: () => at });
  const pair = await setupPair(p, db.pool);
  const session = await p.createSession(pair.user, randomUUID(), pair.plan);
  const prepare = await pair.next('helper', 'prepare');
  const helperInstance = async () => (await p.getSession(pair.user, session.id)).instances.find((i: any) => i.device_id === pair.devices.helper.id);
  assert.equal((await helperInstance()).progress, null, 'nothing reported yet');

  const progress = (phase: string, done: string | null, total: string | null) => pair.send('helper', 'command.progress', {
    command_id: prepare.command_id, phase, completed_bytes: done, total_bytes: total, message: 'unsloth/Qwen3.8-27B-GGUF' });
  await progress('download', '0', '18702184960');
  assert.equal((await helperInstance()).progress, null, 'a first report of 0 bytes is not stored (control.ts command.progress)');
  await progress('download', '1000000000', '18702184960');
  assert.deepEqual((await helperInstance()).progress, { completed_bytes: '1000000000', total_bytes: '18702184960', at: at.toISOString() });
  const service = (await p.getSession(pair.user, session.id)).instances.find((i: any) => i.device_id === pair.devices.service.id);
  assert.equal(service.progress, null, 'the other device has reported nothing');
  const device = await p.getDevice(pair.user, pair.devices.helper.id);
  assert.deepEqual(device.instances.find((i: any) => i.session_id === session.id).progress, (await helperInstance()).progress);

  await progress('build', null, null);
  assert.equal((await helperInstance()).phase, 'build');
  assert.equal((await helperInstance()).progress, null, 'the download is over');
});
