import {describe, expect, it} from 'vitest';
import type {ConnectionTest, DeviceSummary, Inventory} from '@/api/types';
import {makeDevice, makeError, makeInventory, makeTest} from '@/test/factories';
import {
  DEFAULT_TEST_PORT,
  cleanupAction,
  directionRows,
  isMac,
  isOnline,
  testErrorMessage,
  testStatus,
  usableHelperTest,
  waitingForAnotherDevice,
} from './connectivity';

const mac = makeDevice({id: 'mac', kind: 'mac', name: 'studio'});
const helper = makeDevice({id: 'helper', kind: 'linux', name: 'gpu-box'});
const devices: DeviceSummary[] = [mac, helper];
const details: Record<string, {inventory: Inventory}> = {
  mac: {inventory: makeInventory('mac')},
  helper: {inventory: makeInventory('linux')},
};

// The connection test between two devices and the prompt to clean up its listener.
describe('directions', () => {
  it('needs a second device before anything is shown', () => {
    expect(waitingForAnotherDevice([mac])).toBe(true);
    expect(waitingForAnotherDevice(devices)).toBe(false);
    expect(directionRows([mac], details, [])).toEqual([]);
  });

  it('shows both directions once two devices are online', () => {
    const rows = directionRows(devices, details, []);
    expect(rows.map((r) => r.label).sort()).toEqual(['gpu-box → studio', 'studio → gpu-box']);
  });

  it('does not offer a test while the second device is offline', () => {
    const rows = directionRows([mac, {...helper, state: 'offline'}], details, []);
    expect(rows).toEqual([]);
  });

  it('counts an occupied device as online', () => {
    expect(isOnline({...helper, state: 'occupied'})).toBe(true);
    expect(isOnline({...helper, state: 'offline'})).toBe(false);
    expect(isOnline({...helper, state: 'removed'})).toBe(false);
  });

  it('builds the helper -> Mac plan against the MLX interpreter on default port 40360', () => {
    const row = directionRows(devices, details, []).find((r) => r.sourceId === 'helper')!;
    expect(row.plan).toEqual({
      source_device_id: 'helper',
      target_device_id: 'mac',
      target_addresses: ['192.0.2.10'],
      port: DEFAULT_TEST_PORT,
      listener_python: '/opt/mlx/bin/python',
    });
    expect(DEFAULT_TEST_PORT).toBe(40360);
  });

  it('builds the Mac -> helper plan against the helper interpreter', () => {
    const row = directionRows(devices, details, []).find((r) => r.sourceId === 'mac')!;
    expect(row.plan?.listener_python).toBe('/opt/helper/bin/python');
  });

  it('explains why a plan cannot be built when the interpreter or address is missing', () => {
    const missing = {...details, mac: {inventory: makeInventory('mac', {python_executables: []})}};
    const row = directionRows(devices, missing, []).find((r) => r.sourceId === 'helper')!;
    expect(row.plan).toBeNull();
    expect(row.blocked).toMatch(/interpreter/i);
  });

  it('waits for device details before offering a test', () => {
    const row = directionRows(devices, {}, [])[0];
    expect(row.plan).toBeNull();
  });

  it('shows the latest test for each direction', () => {
    const old = makeTest({source_device_id: 'helper', target_device_id: 'mac', started_at: '2026-11-08T10:00:00Z', state: 'unreachable'});
    const latest = makeTest({source_device_id: 'helper', target_device_id: 'mac', started_at: '2026-11-08T11:00:00Z', state: 'reachable'});
    const row = directionRows(devices, details, [latest, old]).find((r) => r.sourceId === 'helper')!;
    expect(row.test?.id).toBe(latest.id);
  });

  it('a failed test can be run again', () => {
    const failed = makeTest({source_device_id: 'helper', target_device_id: 'mac', state: 'unreachable'});
    const row = directionRows(devices, details, [failed]).find((r) => r.sourceId === 'helper')!;
    expect(row.plan).not.toBeNull();
    expect(row.running).toBe(false);
  });

  it('a test in progress cannot be started again', () => {
    for (const state of ['listening', 'testing'] as const) {
      const active = makeTest({source_device_id: 'helper', target_device_id: 'mac', state});
      expect(directionRows(devices, details, [active]).find((r) => r.sourceId === 'helper')!.running).toBe(true);
    }
  });

  it('notes that a failed Mac -> helper direction is not used by the current roles', () => {
    const failed = makeTest({source_device_id: 'mac', target_device_id: 'helper', state: 'unreachable'});
    const row = directionRows(devices, details, [failed]).find((r) => r.sourceId === 'mac')!;
    expect(row.note).toMatch(/not use this direction/i);
    const up = makeTest({source_device_id: 'helper', target_device_id: 'mac', state: 'unreachable'});
    expect(directionRows(devices, details, [up]).find((r) => r.sourceId === 'helper')!.note).toBeNull();
  });

  it('says to wait for the device when the port is busy', () => {
    expect(testErrorMessage(makeError({code: 'port_busy', message: 'Port in use.'}), [])).toMatch(/wait.*device.*free/i);
    expect(testErrorMessage(makeError({code: 'direction_unreachable', message: 'Nope.'}), [])).toBe('Nope.');
  });

  it('classifies each test state in one place', () => {
    const status = (state: string) => testStatus(makeTest({state: state as ConnectionTest['state']}));
    expect(['listening', 'testing'].map(status)).toEqual(['running', 'running']);
    expect(status('reachable')).toBe('reachable');
    expect(status('unreachable')).toBe('unreachable');
    expect(['pending', 'cancelled'].map(status)).toEqual(['unknown', 'unknown']);
  });

  it('treats a state it does not know as unknown: not usable, not running, can be run again', () => {
    const odd = makeTest({source_device_id: 'helper', target_device_id: 'mac', state: 'something_new' as ConnectionTest['state'], valid: true});
    expect(testStatus(odd)).toBe('unknown');
    expect(usableHelperTest([odd], 'helper', 'mac')).toBeNull();
    const row = directionRows(devices, details, [odd]).find((r) => r.sourceId === 'helper')!;
    expect(row.running).toBe(false);
    expect(row.plan).not.toBeNull();
  });

  it('detects a Mac from the inventory', () => {
    expect(isMac(makeInventory('mac'))).toBe(true);
    expect(isMac(makeInventory('linux'))).toBe(false);
  });

  it('accepts only the canonical darwin value, with no fuzzy match', () => {
    for (const os of ['Darwin', 'macOS', 'mac', ' darwin']) expect(isMac(makeInventory('mac', {os}))).toBe(false);
  });

  it('uses only a reachable and still valid helper -> Mac test for a session', () => {
    const valid = makeTest({source_device_id: 'helper', target_device_id: 'mac', state: 'reachable', valid: true});
    expect(usableHelperTest([valid], 'helper', 'mac')?.id).toBe(valid.id);
    expect(usableHelperTest([{...valid, valid: false}], 'helper', 'mac')).toBeNull();
    expect(usableHelperTest([{...valid, state: 'unreachable'}], 'helper', 'mac')).toBeNull();
  });

  it('does not count a Mac -> helper success for the helper -> Mac direction', () => {
    const reverse = makeTest({source_device_id: 'mac', target_device_id: 'helper', state: 'reachable', valid: true});
    expect(usableHelperTest([reverse], 'helper', 'mac')).toBeNull();
  });

  it('does not use an older valid test when the latest one failed', () => {
    const old = makeTest({source_device_id: 'helper', target_device_id: 'mac', state: 'reachable', valid: true, started_at: '2026-11-08T10:00:00Z'});
    const latest = makeTest({source_device_id: 'helper', target_device_id: 'mac', state: 'unreachable', started_at: '2026-11-08T11:00:00Z'});
    expect(usableHelperTest([old, latest], 'helper', 'mac')).toBeNull();
  });
});

describe('cleanup prompts', () => {
  it('offers recheck for an online device awaiting cleanup', () => {
    expect(cleanupAction({...mac, state: 'cleanup_required', cleanup_required: true})).toBe('recheck');
  });

  it('offers removal for an offline device awaiting cleanup', () => {
    expect(cleanupAction({...mac, state: 'offline', cleanup_required: true})).toBe('remove');
  });

  it('offers nothing otherwise', () => {
    expect(cleanupAction(mac)).toBeNull();
    expect(cleanupAction({...mac, state: 'offline', cleanup_required: false})).toBeNull();
    expect(cleanupAction({...mac, state: 'occupied'})).toBeNull();
  });
});
