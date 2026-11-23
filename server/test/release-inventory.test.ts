// A device is selectable again only with an inventory probed after its instances ended. Two orders of the reports: the
// instance's `stopped` reaches the control plane before the inventory probed after the stop, and a heartbeat whose probe
// began before the stop carries the old memory together with `stopped`. Both must end with a preflight that passes, and an older
// inventory that arrives after a newer one never replaces it.
import assert from 'node:assert/strict';
import { after, before, test } from 'node:test';

import { ControlPlane } from '../src/control.ts';
import { MemoryObjectStore } from '../src/storage.ts';
import { createDatabase } from './postgres.ts';
import { fixtureCatalog, inventory, setupPair, startSession } from './fixtures.ts';

let database: Awaited<ReturnType<typeof createDatabase>>;
before(async () => { database = await createDatabase(); });
after(async () => { await database.close(); });

// the memory the engines still held: the service version needs 100 bytes over the control plane's reserve of 1000
const held = (role: string) => ({ ...inventory(role), memory_available_bytes: '1000' });

async function stoppedSession() {
  const plane = new ControlPlane(database.pool, new MemoryObjectStore(), fixtureCatalog());
  const pair = await setupPair(plane, database.pool);
  const session = await startSession(plane, pair);
  const old = held('service');                                // probed while the engines ran
  await pair.send('service', 'heartbeat', { agent_boot_id: pair.devices.service.boot, inventory: old, instances: [await pair.report('service', 'connectable')] });
  await plane.stopSession(pair.user, session.id);
  const helperStop = await pair.next('helper', 'stop');
  await pair.result('helper', helperStop, { instances: [await pair.report('helper', 'stopped')], ports_free: true, inventory: inventory('helper') });
  const stop = await pair.next('service', 'stop');
  // the END's terminal commit: the first inventory probed after it has the sequence after the old one's
  const stopped = { ...await pair.report('service', 'stopped'), inventory_after: old.sequence + 1 };
  return { plane, pair, session, old, stop, stopped };
}

const device = async (s: any) => (await database.pool.query('SELECT * FROM devices WHERE id=$1', [s.pair.devices.service.id])).rows[0];
const capacity = (preflight: any, s: any) => preflight.checks.find((c: any) => c.code === 'capacity_insufficient' && !c.passed && c.device_id === s.pair.devices.service.id);

test('a stopped report before the inventory probed after the stop leaves the device reserved until that inventory', async () => {
  const s = await stoppedSession();
  await s.pair.send('service', 'instance.status', s.stopped);
  assert.equal((await s.plane.getSession(s.pair.user, s.session.id)).state, 'ended');
  assert.equal((await device(s)).state, 'occupied');          // the process exited; its memory is not known freed
  assert.equal((await s.plane.preflight(s.pair.user, s.pair.plan)).allowed, false);
  await s.pair.result('service', s.stop, { instances: [s.stopped], ports_free: true, inventory: inventory('service') });
  assert.equal((await device(s)).state, 'idle');
  const preflight = await s.plane.preflight(s.pair.user, s.pair.plan);
  assert.equal(preflight.allowed, true, JSON.stringify(preflight.checks.filter((c: any) => !c.passed)));
  assert.equal(capacity(preflight, s), undefined);
});

test('a heartbeat probed before the stop carries the old memory with stopped: the result probed after it releases', async () => {
  const s = await stoppedSession();
  await s.pair.send('service', 'heartbeat', { agent_boot_id: s.pair.devices.service.boot, inventory: s.old, instances: [s.stopped] });
  assert.equal((await device(s)).state, 'occupied');
  assert.equal((await s.plane.preflight(s.pair.user, s.pair.plan)).allowed, false);
  const fresh = inventory('service');
  await s.pair.result('service', s.stop, { instances: [s.stopped], ports_free: true, inventory: fresh });
  assert.equal((await device(s)).state, 'idle');
  assert.equal((await s.plane.preflight(s.pair.user, s.pair.plan)).allowed, true);
  // a heartbeat that began before that probe and arrives after it changes nothing
  await s.pair.send('service', 'heartbeat', { agent_boot_id: s.pair.devices.service.boot, inventory: { ...s.old, sequence: fresh.sequence - 1 }, instances: [] });
  assert.equal((await device(s)).inventory.memory_available_bytes, fresh.memory_available_bytes);
  assert.equal((await s.plane.preflight(s.pair.user, s.pair.plan)).allowed, true);
});

test('an inventory newer than the stop releases the device whatever carries it', async () => {
  const s = await stoppedSession();
  await s.pair.send('service', 'instance.status', s.stopped);
  assert.equal((await device(s)).state, 'occupied');
  await s.pair.send('service', 'heartbeat', { agent_boot_id: s.pair.devices.service.boot, inventory: inventory('service'), instances: [s.stopped] });
  assert.equal((await device(s)).state, 'idle');
  assert.equal((await s.plane.preflight(s.pair.user, s.pair.plan)).allowed, true);
});
