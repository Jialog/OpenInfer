import {describe, expect, it} from 'vitest';
import type {PreflightCheck} from '@/api/types';
import {describePreflight} from './preflightView';

const GiB = 2 ** 30;
function check(code: string, passed: boolean, patch: Partial<PreflightCheck> = {}): PreflightCheck {
  return {code, passed, device_id: null, message: `Check ${code.replaceAll('_', ' ')} passed.`, required_bytes: null, available_bytes: null, ...patch};
}

const names: Record<string, string> = {mac: 'service-mac', gpu: 'helper-gpu'};
const roles: Record<string, 'service' | 'helper'> = {mac: 'service', gpu: 'helper'};
const context = {deviceName: (id: string) => names[id] ?? id, roleOf: (id: string) => roles[id] ?? null};

// The 21 checks the backend returns for a plan that passes (control.ts check()).
const PASSED: PreflightCheck[] = [
  check('distinct_devices', true),
  ...['mac', 'gpu'].flatMap((d) => [
    check('control_online', true, {device_id: d}),
    check('unsupported_platform', true, {device_id: d}),
    check('hardware_unvalidated', true, {device_id: d}),
    check('version_setup_missing', true, {device_id: d}),
    check('role', true, {device_id: d}),
    check('build_preparation_required', true, {device_id: d}),
    check('capacity_insufficient', true, {device_id: d, required_bytes: String(15 * GiB), available_bytes: String(22.5 * GiB)}),
    check('disk_insufficient', true, {device_id: d, required_bytes: String(15 * GiB), available_bytes: String(109.9 * GiB)}),
  ]),
  check('version_compatibility', true),
  check('version_setup_missing', true),
  check('direction_unreachable', true),
  check('port_busy', true),
];

describe('preflight view', () => {
  it('counts passed checks out of all', () => {
    const view = describePreflight(PASSED, context);
    expect(view.total).toBe(21);
    expect(view.passed).toBe(21);
    expect(view.failed).toEqual([]);
    expect(view.passedRows).toHaveLength(21);
  });

  it('gives every known check a readable name and never shows a code or task number', () => {
    const view = describePreflight(PASSED, context);
    const text = JSON.stringify(view.passedRows.map(({label, device, detail, remedy}) => [label, device, detail, remedy]));
    expect(text).not.toMatch(/setup missing/i);
    expect(text).not.toMatch(/passed\./);
    expect(text).not.toMatch(/_/);
    const labels = view.passedRows.map((r) => r.label);
    expect(labels).toContain('Memory');
    expect(labels).toContain('GPU memory');
    expect(labels).toContain('Disk');
    expect(labels).toContain('Model version');
    expect(labels).toContain('Connection from helper to server');
  });

  it('names the device a check belongs to', () => {
    const view = describePreflight(PASSED, context);
    const memory = view.passedRows.find((r) => r.label === 'Memory')!;
    expect(memory.device).toBe('service-mac');
    expect(view.passedRows.find((r) => r.label === 'GPU memory')!.device).toBe('helper-gpu');
    expect(view.passedRows.find((r) => r.label === 'Model version')!.device).toBeNull();
  });

  it('writes byte amounts as needed and available GiB', () => {
    const view = describePreflight(PASSED, context);
    expect(view.passedRows.find((r) => r.label === 'Memory')!.detail).toBe('Needs 15.0 GiB, 22.5 GiB available');
    expect(view.passedRows.find((r) => r.label === 'Disk' && r.device === 'service-mac')!.detail).toBe('Needs 15.0 GiB, 109.9 GiB available');
  });

  it('says an engine build will be prepared rather than that it already exists', () => {
    const view = describePreflight(PASSED, context);
    const build = view.passedRows.find((r) => r.label === 'Engine build')!;
    expect(build.detail).toMatch(/will be prepared/i);
  });

  it('puts failures first with their reason and what to do', () => {
    const checks = [
      ...PASSED.filter((c) => c.code !== 'disk_insufficient'),
      check('disk_insufficient', false, {device_id: 'gpu', message: 'Requires 30000000000 bytes; device currently has 1000000000 bytes available.',
                                         required_bytes: '30000000000', available_bytes: '1000000000'}),
      check('direction_unreachable', false, {message: 'The tested helper-to-service address is no longer valid.'}),
    ];
    const view = describePreflight(checks, context);
    expect(view.total).toBe(checks.length);
    expect(view.passed).toBe(checks.length - 2);
    expect(view.failed.map((r) => r.label)).toEqual(['Disk', 'Connection from helper to server']);
    expect(view.failed[0]).toMatchObject({device: 'helper-gpu', detail: 'Needs 27.9 GiB, 0.9 GiB available'});
    expect(view.failed[0].remedy).toMatch(/free disk space/i);
    expect(view.failed[1].detail).toBe('The tested helper-to-service address is no longer valid.');
    expect(view.passedRows.every((r) => r.passed)).toBe(true);
  });

  it('shows a service machine without an M2 Pro as an unverified notice, not as a failure', () => {
    const message = 'Apple M3 Pro has not been verified as a serving machine (the verified chip is the Apple M2 Pro); it may serve.';
    const checks = [...PASSED.filter((c) => !(c.code === 'hardware_unvalidated' && c.device_id === 'mac')),
                    check('hardware_unverified', true, {device_id: 'mac', message})];
    const view = describePreflight(checks, context);
    expect(view.failed).toEqual([]);
    expect(view.passed).toBe(view.total);
    expect(view.notices).toEqual([expect.objectContaining({label: 'Unverified hardware', device: 'service-mac', detail: message, passed: true})]);
    expect(view.passedRows.some((r) => r.key.startsWith('hardware_unverified'))).toBe(false);
    expect(describePreflight(PASSED, context).notices).toEqual([]);
  });

  it('when no helper version fits, says what is short and the smallest need instead of suggesting a smaller version', () => {
    const short = (code: string) => [
      ...PASSED.filter((c) => !(c.code === code && c.device_id === 'gpu')),
      check(code, false, {device_id: 'gpu', message: 'No helper version fits.', required_bytes: String(14.7 * GiB), available_bytes: String(12 * GiB)}),
    ];
    const memory = describePreflight(short('capacity_insufficient'), {...context, noVersionFits: true}).failed[0];
    expect(memory.remedy).toBe('No helper version fits in the free GPU memory of this card: the smallest needs 14.7 GiB. Free GPU memory on the helper, then check again.');
    const disk = describePreflight(short('disk_insufficient'), {...context, noVersionFits: true}).failed[0];
    expect(disk.remedy).toBe('No helper version fits in the free disk space: the smallest needs 14.7 GiB. Free disk space on the helper, then check again.');
    // a version the user chose that does not fit keeps the old advice
    expect(describePreflight(short('capacity_insufficient'), context).failed[0].remedy).toMatch(/smaller helper version/);
  });

  it('a passed disk check of a device with model folders of its own says the disk is checked when the session prepares', () => {
    const disk = [check('disk_insufficient', true, {device_id: 'gpu', required_bytes: '800', available_bytes: '300'})];
    const row = describePreflight(disk, {...context, localModelFolders: (id: string) => id === 'gpu'}).passedRows[0];
    expect(row.detail).toMatch(/model files of its own.*when the session prepares/);
    expect(row.detail).not.toMatch(/Needs|available/);
    // without such folders the passed check shows its amounts
    expect(describePreflight(disk, context).passedRows[0].detail).toMatch(/^Needs/);
  });

  it('shows the message of a check it does not know', () => {
    const view = describePreflight([check('brand_new_check', false, {message: 'Something new went wrong.'})], context);
    expect(view.failed[0].label).toBe('Something new went wrong.');
    expect(view.failed[0].detail).toBeNull();
  });

  it('names the draft model setup check apart from version setup', () => {
    const view = describePreflight(PASSED, context);
    const setup = view.passedRows.filter((r) => r.key.startsWith('version_setup_missing'));
    expect(setup.map((r) => r.label).sort()).toEqual(['Draft model setup', 'Version setup', 'Version setup']);
  });
});
