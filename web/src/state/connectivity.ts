// The connection test between two devices and the prompt to clean up its listener.
import {describeError} from '@/api/errors';
import type {ApiErrorBody, ConnectionTest, DeviceSummary, ID, Inventory, TestPlan} from '@/api/types';

export const DEFAULT_TEST_PORT = 40360;

export type TestStatus = 'running' | 'reachable' | 'unreachable' | 'unknown';

// The only place that reads the values of ConnectionTest.state. A value not listed here is shown as it
// is and never counts as reachable.
const TEST_STATUS: Record<string, TestStatus> = {
  listening: 'running',
  testing: 'running',
  reachable: 'reachable',
  unreachable: 'unreachable',
};

export function testStatus(test: ConnectionTest): TestStatus {
  return TEST_STATUS[test.state] ?? 'unknown';
}

const STATUS_LABEL: Partial<Record<TestStatus, string>> = {
  reachable: 'Reachable',
  unreachable: 'Unreachable',
};

/** Text for a finished test, or null while it is running. */
export function testResultLabel(test: ConnectionTest): string | null {
  const status = testStatus(test);
  if (status === 'running') return null;
  return STATUS_LABEL[status] ?? test.state;
}

export type DirectionRow = {
  key: string;
  sourceId: ID;
  targetId: ID;
  label: string;
  test: ConnectionTest | null;
  plan: TestPlan | null;
  blocked: string | null;
  running: boolean;
  note: string | null;
};

export function isOnline(device: DeviceSummary): boolean {
  return device.state !== 'offline' && device.state !== 'removed';
}

export function isMac(inventory: Inventory): boolean {
  return inventory.os === 'darwin';
}

export function waitingForAnotherDevice(devices: DeviceSummary[]): boolean {
  return devices.length === 1;
}

/** The newest test for one direction, or null. */
export function latestTest(tests: ConnectionTest[], sourceId: ID, targetId: ID): ConnectionTest | null {
  return tests
    .filter((t) => t.source_device_id === sourceId && t.target_device_id === targetId)
    .reduce<ConnectionTest | null>((best, t) => (!best || t.started_at > best.started_at ? t : best), null);
}

function planFor(sourceId: ID, targetId: ID, target: Inventory): {plan: TestPlan | null; blocked: string | null} {
  // The listener must run under the interpreter the engine on the target will use.
  const purpose = isMac(target) ? 'mlx' : 'helper';
  const python = target.python_executables.find((p) => p.purpose === purpose);
  if (!python) return {plan: null, blocked: `The target device did not report a ${purpose} Python interpreter.`};
  if (target.addresses.length === 0) return {plan: null, blocked: 'The target device did not report a network address.'};
  return {
    plan: {
      source_device_id: sourceId,
      target_device_id: targetId,
      target_addresses: target.addresses.map((a) => a.address),
      port: DEFAULT_TEST_PORT,
      listener_python: python.path,
    },
    blocked: null,
  };
}

function directionNote(sourceDetails: Inventory | undefined, targetDetails: Inventory | undefined, test: ConnectionTest | null): string | null {
  if (!test || testStatus(test) !== 'unreachable' || !sourceDetails || !targetDetails) return null;
  return isMac(sourceDetails) && !isMac(targetDetails)
    ? 'This reverse direction did not pass. The current roles do not use this direction.'
    : null;
}

export function directionRows(
  devices: DeviceSummary[],
  details: Record<ID, {inventory: Inventory}>,
  tests: ConnectionTest[],
): DirectionRow[] {
  const online = devices.filter(isOnline);
  if (online.length < 2) return [];
  const rows: DirectionRow[] = [];
  for (const source of online) {
    for (const target of online) {
      if (source.id === target.id) continue;
      const test = latestTest(tests, source.id, target.id);
      const targetInventory = details[target.id]?.inventory;
      const {plan, blocked} = targetInventory
        ? planFor(source.id, target.id, targetInventory)
        : {plan: null, blocked: 'Reading device details.'};
      rows.push({
        key: `${source.id}:${target.id}`,
        sourceId: source.id,
        targetId: target.id,
        label: `${source.name} → ${target.name}`,
        test,
        plan,
        blocked,
        running: test !== null && testStatus(test) === 'running',
        note: directionNote(details[source.id]?.inventory, targetInventory, test),
      });
    }
  }
  return rows;
}

export function testErrorMessage(error: ApiErrorBody, devices: DeviceSummary[]): string {
  return error.code === 'port_busy' ? 'The test port is in use. Waiting for the device to be free.' : describeError(error, devices);
}

/** The newest helper -> Mac test, if it can be used to start a session. */
export function usableHelperTest(tests: ConnectionTest[], helperId: ID, serviceId: ID): ConnectionTest | null {
  const test = latestTest(tests, helperId, serviceId);
  return test && testStatus(test) === 'reachable' && test.valid ? test : null;
}

export function cleanupAction(device: DeviceSummary): 'recheck' | 'remove' | null {
  if (device.state === 'cleanup_required') return 'recheck';
  return device.state === 'offline' && device.cleanup_required ? 'remove' : null;
}
