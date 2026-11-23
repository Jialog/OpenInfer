import {readFileSync} from 'node:fs';
import {resolve} from 'node:path';
import {describe, expect, it} from 'vitest';
import type {Catalog, DeviceSummary, Inventory} from '@/api/types';
import {makeCatalog, makeDevice, makeError, makeInventory, makePreflight, makeTest} from '@/test/factories';
import {describeDevice} from './deviceView';
import {
  buildPlan,
  canStart,
  chosenVersion,
  helperVersionOptions,
  initialWizard,
  selectionProblem,
  serviceVersionOptions,
  startPlan,
  wizardReducer,
  type WizardState,
} from './sessionWizard';

const mac = makeDevice({id: 'mac', kind: 'mac'});
const helper = makeDevice({id: 'helper', kind: 'linux'});
const devices: Record<string, DeviceSummary> = {mac, helper};
const details: Record<string, {inventory: Inventory}> = {mac: {inventory: makeInventory('mac')}, helper: {inventory: makeInventory('linux')}};
const reachable = makeTest({id: 'test-1', source_device_id: 'helper', target_device_id: 'mac', state: 'reachable', valid: true});

// Choosing the devices goes straight to the checks, with the helper version left to Placement.
const atPreflight: WizardState = wizardReducer(initialWizard, {type: 'select_devices', serviceId: 'mac', serviceVersionId: 'service-v1', helperId: 'helper', connectionTestId: 'test-1'});
const placedPlan = (versionId: string | null) => ({...makePreflight().plan, helpers: [{...makePreflight().plan.helpers[0], version_id: versionId}]});
const passed: WizardState = wizardReducer(atPreflight, {type: 'preflight_result', run: atPreflight.preflightRun, preflight: makePreflight({plan: placedPlan('helper-v1')})});
const atVersion: WizardState = wizardReducer(passed, {type: 'back', to: 'version'});
const submitting: WizardState = wizardReducer(passed, {type: 'start', key: 'key-1'});

// The new-session wizard.
describe('choosing devices', () => {
  const input = {devices, details, tests: [reachable], catalog: makeCatalog()};

  it('accepts exactly one Mac and one other device', () => {
    expect(selectionProblem({...input, serviceId: 'mac', helperId: 'helper'})).toBeNull();
  });

  it('rejects an incomplete choice', () => {
    expect(selectionProblem({...input, serviceId: null, helperId: 'helper'})).not.toBeNull();
  });

  it('rejects the same device in both roles', () => {
    expect(selectionProblem({...input, serviceId: 'mac', helperId: 'mac'})).toMatch(/different/i);
  });

  it('rejects a service machine that runs no service version of the catalog', () => {
    expect(selectionProblem({...input, serviceId: 'helper', helperId: 'mac'})).toMatch(/no service version/i);
  });

  it('rejects a device that is not idle', () => {
    const busy = {...devices, helper: {...helper, state: 'occupied' as const}};
    expect(selectionProblem({...input, devices: busy, serviceId: 'mac', helperId: 'helper'})).toMatch(/idle|free|busy/i);
  });

  it('asks for a helper -> Mac test when there is no valid one', () => {
    expect(selectionProblem({...input, tests: [], serviceId: 'mac', helperId: 'helper'})).toMatch(/connection test/i);
  });

  // A restarted device program makes the test invalid; the page says that, not "run one".
  it('says the helper -> Mac test is no longer valid when it passed but no longer counts', () => {
    const stale = {...reachable, valid: false, invalid_reason: 'direction_unreachable'};
    expect(selectionProblem({...input, tests: [stale], serviceId: 'mac', helperId: 'helper'}))
      .toBe(`The helper → ${input.devices.mac.name} connection test is no longer valid: the address, port or device changed since it ran, as it does when a device program restarts.`);
  });

  it('valid devices -> preflight, which runs once with the helper version left to Placement', () => {
    expect(atPreflight.step).toBe('preflight');
    expect(atPreflight.connectionTestId).toBe('test-1');
    expect(atPreflight.versionId).toBeNull();
    expect(atPreflight.preflight).toBeNull();
    expect(atPreflight.preflightPending).toBe(true);
    expect(atPreflight.preflightRun).toBe(initialWizard.preflightRun + 1);
    expect(buildPlan(atPreflight, 'service-v1').helpers[0].version_id).toBeNull();
  });
});

// The catalogue and the devices the simulator ships (../simulator, read from web/): what the website makes of them.
describe('the simulated catalogue and devices', () => {
  const read = (file: string) => JSON.parse(readFileSync(resolve(process.cwd(), '../simulator', file), 'utf8'));
  const catalog: Catalog = {...read('catalog.json').catalog, service_version_id: 'demo-serve-4bit', placement: {}};
  const inventory = (name: string): Inventory => ({...read('devices.json').find((d: {name: string}) => d.name === name).inventory, sequence: 1});

  it('offers the serving version to the simulated Mac only, and both helper versions with it', () => {
    expect(serviceVersionOptions(catalog, inventory('mac'), true)).toEqual(['demo-serve-4bit']);
    expect(serviceVersionOptions(catalog, inventory('gpu'), false)).toEqual([]);
    expect(helperVersionOptions(catalog, null, null).map((o) => o.id)).toEqual(['demo-help-8bit', 'demo-help-4bit']);
  });

  it('shows each simulated device with the role it can take', () => {
    expect(describeDevice(inventory('mac')).roles).toEqual(['Can be the server (MLX)']);
    expect(describeDevice(inventory('gpu')).roles).toEqual(['Can be a helper (llama.cpp, NVIDIA RTX A5000 24.0 GiB)']);
  });
});

describe('version and preflight', () => {
  it('the version Placement chose is the one shown, offered first and started', () => {
    expect(chosenVersion(passed)).toBe('helper-v1');
    expect(chosenVersion(atVersion)).toBe('helper-v1');
    expect(startPlan(passed).helpers[0].version_id).toBe('helper-v1');
    // a recheck asks Placement again rather than fixing its last choice
    expect(buildPlan(wizardReducer(passed, {type: 'recheck'}), 'service-v1').helpers[0].version_id).toBeNull();
  });

  it('when no version fits nothing is chosen and nothing can start', () => {
    const none = wizardReducer(atPreflight, {type: 'preflight_result', run: atPreflight.preflightRun, preflight: makePreflight({allowed: false, plan: placedPlan(null)})});
    expect(chosenVersion(none)).toBeNull();
    expect(canStart(none, false)).toBe(false);
  });

  it('choosing another version checks that one by name', () => {
    expect(atVersion.step).toBe('version');
    const other = wizardReducer(atVersion, {type: 'choose_version', versionId: 'helper-v2'});
    expect(other.step).toBe('preflight');
    expect(other.preflightPending).toBe(true);
    expect(buildPlan(other, 'service-v1').helpers[0].version_id).toBe('helper-v2');
  });

  it('a passing preflight allows starting', () => {
    expect(canStart(passed, false)).toBe(true);
  });

  it('a failing preflight shows its checks and does not allow starting', () => {
    const failed = wizardReducer(atPreflight, {
      type: 'preflight_result', run: atPreflight.preflightRun,
      preflight: makePreflight({allowed: false, checks: [{code: 'capacity_insufficient', passed: false, device_id: 'helper', message: 'Not enough memory.', required_bytes: '10', available_bytes: '5'}]}),
    });
    expect(failed.step).toBe('preflight');
    expect(failed.preflight?.checks[0].message).toBe('Not enough memory.');
    expect(canStart(failed, false)).toBe(false);
  });

  it('cannot start while the data is stale', () => {
    expect(canStart(passed, true)).toBe(false);
  });

  it('ignores a preflight result from an older run', () => {
    const rerun = wizardReducer(passed, {type: 'recheck'});
    const late = wizardReducer(rerun, {type: 'preflight_result', run: passed.preflightRun, preflight: makePreflight()});
    expect(late.preflight).toBeNull();
    expect(late.preflightPending).toBe(true);
  });

  it('a preflight call error shows and can be run again', () => {
    const failed = wizardReducer(atPreflight, {type: 'preflight_failed', run: atPreflight.preflightRun, error: makeError({message: 'Server error.'})});
    expect(failed.error?.message).toBe('Server error.');
    expect(failed.preflightPending).toBe(false);
    const again = wizardReducer(failed, {type: 'recheck'});
    expect(again.preflightPending).toBe(true);
    expect(again.error).toBeNull();
  });

  it('can go back to choose a different version or devices', () => {
    expect(wizardReducer(passed, {type: 'back', to: 'version'}).step).toBe('version');
    expect(wizardReducer(passed, {type: 'back', to: 'devices'}).step).toBe('devices');
  });

  it('a device going offline during version or preflight -> back to devices', () => {
    const offline = [{...helper, state: 'offline' as const}, mac];
    for (const state of [atVersion, atPreflight, passed]) {
      const next = wizardReducer(state, {type: 'devices_changed', devices: offline});
      expect(next.step).toBe('devices');
      expect(next.error?.message).toMatch(/offline/i);
    }
  });

  it('does not react to devices that stay online', () => {
    expect(wizardReducer(passed, {type: 'devices_changed', devices: [mac, helper]})).toEqual(passed);
  });

  it('builds a plan with the draft model on by default', () => {
    expect(buildPlan(passed, 'service-v1')).toEqual({
      service_device_id: 'mac', service_version_id: 'service-v1',
      helpers: [{device_id: 'helper', version_id: null, draft_model: 'enabled',
                 acknowledge_no_draft_model: false, connection_test_id: 'test-1'}],
    });
  });

  it('marks acknowledge only when the draft model is off, and rechecks', () => {
    const off = wizardReducer(passed, {type: 'set_draft_model', value: 'disabled'});
    expect(off.preflight).toBeNull();
    expect(off.preflightPending).toBe(true);
    const helperPlan = buildPlan(off, 'service-v1').helpers[0];
    expect(helperPlan.draft_model).toBe('disabled');
    expect(helperPlan.acknowledge_no_draft_model).toBe(true);
  });
});

describe('helper version options', () => {
  // Placement's order (most precise first) with each version's memory need, as GET /catalog lists it.
  const catalog = makeCatalog();

  const free = (bytes: string) => ({disk_available_bytes: bytes, local_model_folders: false});
  const disk = free(String(100 * 2 ** 30));

  it('lists the versions in Placement order with their needs, then the incomplete ones', () => {
    const options = helperVersionOptions(catalog, String(20 * 2 ** 30), disk);
    expect(options.map((o) => o.id)).toEqual(['helper-big', 'helper-v1', 'helper-small', 'helper-v2']);
    expect(options.map((o) => o.fits)).toEqual([false, true, true, null]);
    expect(options[0].memoryBytes).toBe(String(33 * 2 ** 30));
    expect(options[0].diskBytes).toBe(String(27 * 2 ** 30));
    expect(options[3].memoryBytes).toBeNull();
  });

  it('a version that needs exactly the free memory fits', () => {
    expect(helperVersionOptions(catalog, String(19 * 2 ** 30), disk).find((o) => o.id === 'helper-v1')!.fits).toBe(true);
    expect(helperVersionOptions(catalog, String(19 * 2 ** 30 - 1), disk).find((o) => o.id === 'helper-v1')!.fits).toBe(false);
  });

  it('a version whose files do not fit the free disk does not fit, an exact fit does', () => {
    const gpu = String(40 * 2 ** 30);
    expect(helperVersionOptions(catalog, gpu, free(String(13 * 2 ** 30))).map((o) => o.fits)).toEqual([false, true, true, null]);
    expect(helperVersionOptions(catalog, gpu, free(String(13 * 2 ** 30 - 1))).map((o) => o.fits)).toEqual([false, false, true, null]);
  });

  it('a helper that reports model folders of its own is not ruled out by its disk, as the server decides', () => {
    // the server's rule (diskFits): how much is missing is known only once the helper's preparation checked the files
    const gpu = String(40 * 2 ** 30), folders = {disk_available_bytes: '300', local_model_folders: true};
    expect(helperVersionOptions(catalog, gpu, folders).map((o) => o.fits)).toEqual([true, true, true, null]);
    expect(helperVersionOptions(catalog, String(17 * 2 ** 30), folders).map((o) => o.fits)).toEqual([false, false, true, null]);
    expect(helperVersionOptions(catalog, gpu, {...folders, local_model_folders: false}).map((o) => o.fits)).toEqual([false, false, false, null]);
  });

  it('without a reading of the free memory or disk no version is ruled out by it', () => {
    expect(helperVersionOptions(catalog, null, null).map((o) => o.fits)).toEqual([null, null, null, null]);
    expect(helperVersionOptions(catalog, null, free(String(13 * 2 ** 30))).map((o) => o.fits)).toEqual([false, null, null, null]);
  });
});

describe('submitting', () => {
  it('start -> submitting with the key', () => {
    expect(submitting.step).toBe('submitting');
    expect(submitting.key).toBe('key-1');
  });

  it('start is refused when preflight has not passed', () => {
    expect(wizardReducer(atPreflight, {type: 'start', key: 'x'})).toEqual(atPreflight);
  });

  it('created -> done with the session id', () => {
    const next = wizardReducer(submitting, {type: 'created', sessionId: 's-1'});
    expect(next.step).toBe('created');
    expect(next.createdSessionId).toBe('s-1');
  });

  it('timeout keeps the same key and retries with it', () => {
    const uncertain = wizardReducer(submitting, {type: 'create_timeout'});
    expect(uncertain.step).toBe('submitting');
    expect(uncertain.uncertain).toBe(true);
    expect(uncertain.key).toBe('key-1');
    const retried = wizardReducer(uncertain, {type: 'retry'});
    expect(retried.uncertain).toBe(false);
    expect(retried.key).toBe('key-1');
  });

  it('giving up after a timeout and starting again reuses the key while the plan is unchanged', () => {
    const uncertain = wizardReducer(submitting, {type: 'create_timeout'});
    const back = wizardReducer(uncertain, {type: 'abandon'});
    expect(back.step).toBe('preflight');
    expect(wizardReducer(back, {type: 'start', key: 'key-2'}).key).toBe('key-1');
  });

  // After the tests are run again from the checks, the checks run again with the new test and the same version.
  it('runs the checks again with a new connection test, keeping the chosen version', () => {
    const chosen = wizardReducer(passed, {type: 'choose_version', versionId: 'helper-v2'});
    const next = wizardReducer(chosen, {type: 'retested', connectionTestId: 'test-2'});
    expect(next).toMatchObject({step: 'preflight', connectionTestId: 'test-2', versionId: 'helper-v2', preflight: null, preflightPending: true,
                                preflightRun: chosen.preflightRun + 1, key: null});
    expect(buildPlan(next, 'mlx').helpers[0].connection_test_id).toBe('test-2');
    expect(wizardReducer(initialWizard, {type: 'retested', connectionTestId: 'test-2'})).toBe(initialWizard);
  });

  it('changing the plan drops the key', () => {
    const uncertain = wizardReducer(submitting, {type: 'create_timeout'});
    const back = wizardReducer(uncertain, {type: 'abandon'});
    const changed = wizardReducer(back, {type: 'choose_version', versionId: 'helper-v2'});
    expect(changed.key).toBeNull();
  });

  it.each([
    ['device_busy', 'devices'],
    ['direction_unreachable', 'devices'],
    ['unsupported_platform', 'devices'],
    ['hardware_unvalidated', 'devices'],
    ['capacity_insufficient', 'version'],
    ['build_mismatch', 'version'],
    ['version_setup_missing', 'version'],
    ['preflight_failed', 'preflight'],
    ['internal', 'preflight'],
  ])('a rejected start with %s returns to the %s step', (code, step) => {
    const next = wizardReducer(submitting, {type: 'create_failed', error: makeError({code, message: 'No.'})});
    expect(next.step).toBe(step);
    expect(next.error?.message).toBe('No.');
  });

  it('re-runs the preflight when a rejected start returns to the preflight step', () => {
    const next = wizardReducer(submitting, {type: 'create_failed', error: makeError({code: 'preflight_failed'})});
    expect(next.preflightPending).toBe(true);
    expect(next.preflightRun).toBe(submitting.preflightRun + 1);
    expect(next.preflight).toBeNull();
  });
});
