import assert from 'node:assert/strict';
import { after, before, test } from 'node:test';
import { randomUUID } from 'node:crypto';

import { ControlPlane } from '../src/control.ts';
import { MemoryObjectStore } from '../src/storage.ts';
import { createDatabase } from './postgres.ts';
import { fixtureCatalog, fixtureError, inventory, setupPair, startSession } from './fixtures.ts';

// A recheck clears a device's cleanup only on evidence: the instance whose port was taken stays named in every recheck
// until one finds its port free, and a recheck result of an earlier boot of the device only completes its command.

let database: Awaited<ReturnType<typeof createDatabase>>;

before(async () => {
  database = await createDatabase();
});

after(async () => {
  await database.close();
});

// The session's serving machine stopped every process, but a port of it stays taken: its stop fails with port_busy.
async function portBusy(plane: ControlPlane, pair: any) {
  const session = await startSession(plane, pair);
  await plane.stopSession(pair.user, session.id);
  const serviceStop = await pair.next('service', 'stop');
  const helperStop = await pair.next('helper', 'stop');
  await pair.result('helper', helperStop, { instances: [await pair.report('helper', 'stopped')], ports_free: true });
  const instance = serviceStop.instance_refs[0].instance_id;
  const stopped = await pair.report('service', 'stopped', instance);
  await pair.result('service', serviceStop, { instances: [stopped], ports_free: false }, 'failed',
    fixtureError('port_busy', pair.devices.service.id, 'kill'));
  return instance;
}

test('the instance of a port_busy stop is named in every recheck until one finds its port free', async () => {
  // re-check of the device program, A item 6: the stop failed on a taken port; a later report says the instance
  // stopped (its processes are gone), which sets its stopped_at. Before: the recheck named no instance
  // (instance_ids=[]), the device answered ports_free=true for nothing, and the device was released.
  const plane = new ControlPlane(database.pool, new MemoryObjectStore(), fixtureCatalog());
  const pair = await setupPair(plane, database.pool);
  const instance = await portBusy(plane, pair);
  await pair.status('service', 'stopped');
  await plane.recheckDevice(pair.user, pair.devices.service.id);
  let recheck = await pair.next('service', 'recheck');
  assert.deepEqual(recheck.payload.instance_ids, [instance]);
  // the device still finds the port taken: still cleanup, still port_busy, and the next recheck names it again
  await pair.result('service', recheck, { instances: [await pair.report('service', 'stopped', instance)], ports_free: false });
  let device = await plane.getDevice(pair.user, pair.devices.service.id);
  assert.deepEqual([device.state, device.cleanup_required, device.error?.code], ['cleanup_required', true, 'port_busy']);
  await plane.recheckDevice(pair.user, pair.devices.service.id);
  recheck = await pair.next('service', 'recheck');
  assert.deepEqual(recheck.payload.instance_ids, [instance]);
  await pair.result('service', recheck, { instances: [await pair.report('service', 'stopped', instance)], ports_free: true });
  device = await plane.getDevice(pair.user, pair.devices.service.id);
  assert.deepEqual([device.state, device.cleanup_required, device.error], ['idle', false, null]);
});

test('a recheck result of an earlier boot only completes its command; the current boot decides the cleanup', async () => {
  // re-check of the device program, A item 7: the device recorded a recheck that found everything stopped and the
  // ports free, then restarted (boot B) before the result arrived; in the same reconcile it says, as boot B sees it,
  // that the instance still needs cleaning up. Before: the old result cleared the device (cleanup_required=false)
  // while its instance stayed cleanup_required.
  const plane = new ControlPlane(database.pool, new MemoryObjectStore(), fixtureCatalog());
  const pair = await setupPair(plane, database.pool);
  const instance = await portBusy(plane, pair);
  await plane.recheckDevice(pair.user, pair.devices.service.id);
  const recheck = await pair.next('service', 'recheck');
  assert.deepEqual(recheck.payload.instance_ids, [instance]);
  const old = await pair.report('service', 'stopped', instance);
  const boot = randomUUID();
  await pair.reopen('service', boot);
  await pair.send('service', 'reconcile', {
    agent_boot_id: boot,
    inventory: inventory('service'),
    instances: [await pair.report('service', 'cleanup_required', instance)],
    commands: [{ command_id: recheck.command_id, state: 'completed', result: { instances: [old], ports_free: true }, error: null }],
    requests: [],
  });
  const command = (await database.pool.query('SELECT state FROM commands WHERE id=$1', [recheck.command_id])).rows[0];
  assert.equal(command.state, 'completed');
  const device = await plane.getDevice(pair.user, pair.devices.service.id);
  assert.deepEqual([device.state, device.cleanup_required], ['cleanup_required', true]);
  const row = (await database.pool.query('SELECT state, stopped_at FROM instances WHERE id=$1', [instance])).rows[0];
  assert.deepEqual([row.state, row.stopped_at], ['cleanup_required', null]);
});
