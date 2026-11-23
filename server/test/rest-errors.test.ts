import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { after, before, test } from 'node:test';

import { ControlPlane } from '../src/control.ts';
import { Fault, type ErrorDetails } from '../src/protocol.ts';
import { MemoryObjectStore } from '../src/storage.ts';
import { fixtureCatalog, setupPair, startSession } from './fixtures.ts';
import { createDatabase } from './postgres.ts';

let database: Awaited<ReturnType<typeof createDatabase>>;

before(async () => {
  database = await createDatabase();
});

after(async () => {
  await database.close();
});

async function expectBusinessFault(
  operation: Promise<unknown>,
  expected: Pick<ErrorDetails, 'code' | 'device_id' | 'phase'> & { status: number },
) {
  let thrown: unknown;
  try {
    await operation;
  } catch (error) {
    thrown = error;
  }

  assert.ok(thrown instanceof Fault, `expected Fault, got ${String(thrown)}`);
  assert.equal(thrown.status, expected.status);
  const body = thrown.body();
  assert.equal(body.code, expected.code);
  assert.equal(body.device_id, expected.device_id);
  assert.equal(body.phase, expected.phase);
  assert.notEqual(body.message, body.code, 'business errors need an actionable reason');
  assert.equal(body.retryable, false);
  return body;
}

test('connection-test conflicts identify the busy device and connect phase', async () => {
  const plane = new ControlPlane(database.pool, new MemoryObjectStore(), fixtureCatalog());
  const pair = await setupPair(plane, database.pool);
  await startSession(plane, pair);

  await expectBusinessFault(
    plane.createConnectionTest(pair.user, {
      source_device_id: pair.devices.helper.id,
      target_device_id: pair.devices.service.id,
      target_addresses: ['192.0.2.1'],
      port: 40361,
      listener_python: '/fixture/python',
    }),
    { code: 'device_busy', status: 409, device_id: pair.devices.helper.id, phase: 'connect' },
  );
});

test('connection-test port conflicts identify the target device and connect phase', async () => {
  const plane = new ControlPlane(database.pool, new MemoryObjectStore(), fixtureCatalog());
  const pair = await setupPair(plane, database.pool);
  const plan = {
    source_device_id: pair.devices.helper.id,
    target_device_id: pair.devices.service.id,
    target_addresses: ['192.0.2.1'],
    port: 40361,
    listener_python: '/fixture/python',
  };
  await plane.createConnectionTest(pair.user, plan);

  await expectBusinessFault(plane.createConnectionTest(pair.user, plan), {
    code: 'port_busy',
    status: 409,
    device_id: pair.devices.service.id,
    phase: 'connect',
  });
});

test('request submission reports the unavailable service device and serve phase', async () => {
  const plane = new ControlPlane(database.pool, new MemoryObjectStore(), fixtureCatalog());
  const pair = await setupPair(plane, database.pool);
  const session = await startSession(plane, pair);
  await database.pool.query('UPDATE devices SET reconciled_at=NULL WHERE id=$1', [pair.devices.service.id]);

  await expectBusinessFault(
    plane.submitRequest(pair.user, session.id, randomUUID(), { prompt: 'test-only prompt' }),
    { code: 'session_not_ready', status: 409, device_id: pair.devices.service.id, phase: 'serve' },
  );
});

test('helper reconnect reports the busy helper and connect phase', async () => {
  const busyPlane = new ControlPlane(database.pool, new MemoryObjectStore(), fixtureCatalog());
  const busyPair = await setupPair(busyPlane, database.pool);
  const busySession = await startSession(busyPlane, busyPair);
  await busyPair.peer(false);
  await database.pool.query('UPDATE devices SET reconciled_at=NULL WHERE id=$1', [busyPair.devices.helper.id]);

  await expectBusinessFault(
    busyPlane.reconnectHelper(busyPair.user, busySession.id, busyPair.devices.helper.id),
    { code: 'device_busy', status: 409, device_id: busyPair.devices.helper.id, phase: 'connect' },
  );
});

test('helper reconnect identifies the helper whose tested path is no longer valid', async () => {
  const pathPlane = new ControlPlane(database.pool, new MemoryObjectStore(), fixtureCatalog());
  const pathPair = await setupPair(pathPlane, database.pool);
  const pathSession = await startSession(pathPlane, pathPair);
  await pathPair.peer(false);
  await database.pool.query(
    "UPDATE devices SET inventory=jsonb_set(inventory, '{addresses}', $2::jsonb) WHERE id=$1",
    [pathPair.devices.helper.id, JSON.stringify([{ address: '192.0.2.99', interface: 'fixture' }])],
  );

  await expectBusinessFault(
    pathPlane.reconnectHelper(pathPair.user, pathSession.id, pathPair.devices.helper.id),
    { code: 'direction_unreachable', status: 409, device_id: pathPair.devices.helper.id, phase: 'connect' },
  );
});

test('device recheck and removal conflicts identify the device and reconcile phase', async () => {
  const plane = new ControlPlane(database.pool, new MemoryObjectStore(), fixtureCatalog());
  const pair = await setupPair(plane, database.pool);

  await expectBusinessFault(plane.recheckDevice(pair.user, pair.devices.service.id), {
    code: 'device_busy',
    status: 409,
    device_id: pair.devices.service.id,
    phase: 'reconcile',
  });
  await expectBusinessFault(plane.removeDevice(pair.user, pair.devices.service.id, true), {
    code: 'device_busy',
    status: 409,
    device_id: pair.devices.service.id,
    phase: 'reconcile',
  });
});
