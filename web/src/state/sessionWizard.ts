// The new-session wizard: choosing the devices goes straight to
// the checks, with the helper version left to Placement; choosing a version is an optional step. The service machine is any
// device a service version of the catalog runs on, with that version; the helper is optional. Idempotency handling
// follows the server's (docs/API.md).
import type {ApiErrorBody, Catalog, ConnectionTest, DeviceSummary, ID, Inventory, Preflight, SessionPlan, U64, VersionConfig} from '@/api/types';
import {latestTest, testStatus, usableHelperTest} from './connectivity';
import {diskFits} from '../../../server/src/disk';

export type WizardStep = 'devices' | 'version' | 'preflight' | 'submitting' | 'created';

export type WizardState = {
  step: WizardStep;
  serviceId: ID | null;
  /** The service version the service machine runs, one that runs on it (serviceVersionOptions). */
  serviceVersionId: string | null;
  /** The helper, or null for the service machine alone. */
  helperId: ID | null;
  connectionTestId: ID | null;
  /** The helper version the user named, or null to let Placement choose it. */
  versionId: string | null;
  draftModel: 'enabled' | 'disabled';
  preflight: Preflight | null;
  /** Increments for each preflight to run; a page effect keyed on it issues the call. */
  preflightRun: number;
  preflightPending: boolean;
  key: string | null;
  uncertain: boolean;
  error: ApiErrorBody | null;
  createdSessionId: ID | null;
};

export type WizardEvent =
  | {type: 'select_devices'; serviceId: ID; serviceVersionId: string; helperId: ID | null; connectionTestId: ID | null}
  | {type: 'choose_version'; versionId: string}
  | {type: 'retested'; connectionTestId: ID}
  | {type: 'set_draft_model'; value: 'enabled' | 'disabled'}
  | {type: 'preflight_result'; run: number; preflight: Preflight}
  | {type: 'preflight_failed'; run: number; error: ApiErrorBody}
  | {type: 'recheck'}
  | {type: 'back'; to: 'devices' | 'version'}
  | {type: 'devices_changed'; devices: DeviceSummary[]}
  | {type: 'start'; key: string}
  | {type: 'created'; sessionId: ID}
  | {type: 'create_failed'; error: ApiErrorBody}
  | {type: 'create_timeout'}
  | {type: 'retry'}
  | {type: 'abandon'};

export const initialWizard: WizardState = {
  step: 'devices',
  serviceId: null,
  serviceVersionId: null,
  helperId: null,
  connectionTestId: null,
  versionId: null,
  draftModel: 'enabled',
  preflight: null,
  preflightRun: 0,
  preflightPending: false,
  key: null,
  uncertain: false,
  error: null,
  createdSessionId: null,
};

export type SelectionInput = {
  serviceId: ID | null;
  helperId: ID | null;
  devices: Record<ID, DeviceSummary>;
  details: Record<ID, {inventory: Inventory}>;
  tests: ConnectionTest[];
  catalog: Catalog | null;
};

/** Whether a device can run a version at all, as the preflight decides it (server/src/control.ts, runnable):
 *  its system and processor, a card of the vendor its platform names, the version's engine available. */
function runsOn(inventory: Inventory, version: VersionConfig): boolean {
  const {os, arch, gpu_vendor} = version.platform;
  return inventory.os === os && inventory.arch === arch && (!gpu_vendor || inventory.gpus.some((g) => g.vendor === gpu_vendor))
    && inventory.engines.some((e) => e.name === version.engine && e.available);
}

/** The service versions a device with INVENTORY can serve, in the catalog's order: those that run on it and, WITH_HELPER,
 *  that a helper version is paired with. The first is the default (the catalog's first serving version where it runs). */
export function serviceVersionOptions(catalog: Catalog, inventory: Inventory, withHelper: boolean): string[] {
  return catalog.versions
    .filter((v) => v.role === 'service' && runsOn(inventory, v)
      && (!withHelper || catalog.versions.some((h) => h.role === 'helper' && h.compatible_service_version_ids.includes(v.id))))
    .map((v) => v.id);
}

/** Why the chosen devices themselves cannot be used, or null. */
export function deviceProblem(input: SelectionInput): string | null {
  const {serviceId, helperId, devices, details, catalog} = input;
  if (!serviceId) return 'Choose a service machine.';
  if (serviceId === helperId) return 'Choose two different devices.';
  const inventory = details[serviceId]?.inventory;
  if (!inventory || !catalog) return 'Reading the service machine and the catalog.';
  if (!serviceVersionOptions(catalog, inventory, helperId !== null).length) {
    return helperId === null || !serviceVersionOptions(catalog, inventory, false).length
      ? 'No service version of the catalog runs on this service machine.'
      : 'No service version of the catalog that runs on this service machine has a helper version; start it without a helper.';
  }
  if (devices[serviceId]?.state !== 'idle' || (helperId !== null && devices[helperId]?.state !== 'idle')) {
    return helperId === null ? 'The service machine must be idle.' : 'Both devices must be idle.';
  }
  return null;
}

/** Why the connection test from the helper to the service machine SERVICE (named SERVICE_NAME) does not count, or null.
 *  A test that passed stops counting when the address, port or a device program changed, as a
 *  device program restart does. */
export function testProblem(tests: ConnectionTest[], helperId: ID, serviceId: ID, serviceName: string): string | null {
  if (usableHelperTest(tests, helperId, serviceId)) return null;
  const test = latestTest(tests, helperId, serviceId);
  if (test && testStatus(test) === 'reachable') {
    return `The helper → ${serviceName} connection test is no longer valid: the address, port or device changed since it ran, as it does when a device program restarts.`;
  }
  return `Run a helper → ${serviceName} connection test first.`;
}

/** Why the chosen devices cannot go on to the next step, or null. The service machine alone needs no connection test. */
export function selectionProblem(input: SelectionInput): string | null {
  return deviceProblem(input) ?? (input.helperId === null ? null
    : testProblem(input.tests, input.helperId, input.serviceId as ID, input.devices[input.serviceId as ID].name));
}

const DEVICE_ERRORS = new Set(['device_busy', 'direction_unreachable', 'unsupported_platform', 'hardware_unvalidated']);
const VERSION_ERRORS = new Set(['capacity_insufficient', 'build_mismatch', 'version_setup_missing']);

function runPreflight(state: WizardState): WizardState {
  return {
    ...state,
    step: 'preflight',
    preflight: null,
    preflightPending: true,
    preflightRun: state.preflightRun + 1,
    error: null,
    uncertain: false,
  };
}

function rejectedStart(state: WizardState, error: ApiErrorBody): WizardState {
  if (DEVICE_ERRORS.has(error.code)) return {...state, step: 'devices', error, uncertain: false};
  if (VERSION_ERRORS.has(error.code)) return {...state, step: 'version', error, uncertain: false};
  return {...runPreflight(state), error};
}

export function wizardReducer(state: WizardState, event: WizardEvent): WizardState {
  switch (event.type) {
    case 'select_devices':
      return runPreflight({
        ...state,
        serviceId: event.serviceId,
        serviceVersionId: event.serviceVersionId,
        helperId: event.helperId,
        connectionTestId: event.connectionTestId,
        versionId: null,
        key: null,
      });
    case 'choose_version':
      return runPreflight({...state, versionId: event.versionId, key: null});
    case 'set_draft_model':
      return runPreflight({...state, draftModel: event.value, key: null});
    case 'recheck':
      return runPreflight(state);
    case 'retested':
      return state.step === 'preflight' ? runPreflight({...state, connectionTestId: event.connectionTestId, key: null}) : state;
    case 'preflight_result':
      if (event.run !== state.preflightRun) return state;
      return {...state, preflight: event.preflight, preflightPending: false};
    case 'preflight_failed':
      if (event.run !== state.preflightRun) return state;
      return {...state, error: event.error, preflightPending: false};
    case 'back':
      return {...state, step: event.to, error: null, preflightPending: false};
    case 'devices_changed': {
      if (state.step !== 'version' && state.step !== 'preflight') return state;
      const gone = event.devices.find(
        (d) => (d.id === state.serviceId || d.id === state.helperId) && (d.state === 'offline' || d.state === 'removed'),
      );
      if (!gone) return state;
      return {
        ...state,
        step: 'devices',
        preflightPending: false,
        error: {code: 'device_offline', message: `${gone.name} went offline.`, field: null, device_id: gone.id, phase: null, retryable: true},
      };
    }
    case 'start':
      if (!state.preflight?.allowed) return state;
      return {...state, step: 'submitting', key: state.key ?? event.key, uncertain: false, error: null};
    case 'created':
      return {...state, step: 'created', createdSessionId: event.sessionId, uncertain: false};
    case 'create_failed':
      return state.step === 'submitting' ? rejectedStart(state, event.error) : state;
    case 'create_timeout':
      return state.step === 'submitting' ? {...state, uncertain: true} : state;
    case 'retry':
      return state.step === 'submitting' ? {...state, uncertain: false} : state;
    case 'abandon':
      return state.step === 'submitting' ? {...state, step: 'preflight', uncertain: false} : state;
  }
}

export function canStart(state: WizardState, stale: boolean): boolean {
  return state.step === 'preflight' && state.preflight?.allowed === true && !state.preflightPending && !stale;
}

/** The plan a preflight checks: the helper version is null while Placement chooses it; no helper, none. */
export function buildPlan(state: WizardState, serviceVersionId: string): SessionPlan {
  return {
    service_device_id: state.serviceId as ID,
    service_version_id: serviceVersionId,
    helpers: state.helperId === null ? [] : [{
      device_id: state.helperId as ID,
      version_id: state.versionId,
      draft_model: state.draftModel,
      acknowledge_no_draft_model: state.draftModel === 'disabled',
      connection_test_id: state.connectionTestId as ID,
    }],
  };
}

/** The helper version the checks are about: the one the last preflight returned, else the one the user named; none
 *  without a helper. */
export function chosenVersion(state: WizardState): string | null {
  if (state.helperId === null) return null;
  return state.preflight ? state.preflight.plan.helpers[0].version_id : state.versionId;
}

/** The plan a session starts with: the one the passing preflight returned, which names the helper version. */
export function startPlan(state: WizardState): SessionPlan {
  return (state.preflight as Preflight).plan;
}

export type VersionOption = {
  id: string; label: string; memoryBytes: U64 | null; diskBytes: U64 | null; fits: boolean | null; missing: string[];
};

/** The helper's disk as the server's disk rule reads it: its free disk and whether it has model folders of its own. */
export type DiskReading = Pick<Inventory, 'disk_available_bytes' | 'local_model_folders'>;

/** The helper versions to pick for the service version SERVICE_VERSION_ID: Placement's candidates in its order with the
 *  free GPU memory and disk each needs, then the other helper versions paired with it, with what they lack. A version fits
 *  when both fit (as Placement decides: its disk by the server's own rule, diskFits); fits is false when either reading
 *  shows it does not, null when a reading is missing and the other does not rule it out. */
export function helperVersionOptions(catalog: Catalog, gpuFree: U64 | null, disk: DiskReading | null,
                                     serviceVersionId: string = catalog.service_version_id): VersionOption[] {
  const label = (id: string) => catalog.versions.find((v) => v.id === id)?.label ?? id;
  const placement = catalog.placement[serviceVersionId] ?? [];
  const placed = placement.map(({version_id, memory_bytes, disk_bytes}) => {
    const gpu = gpuFree === null ? null : BigInt(memory_bytes) <= BigInt(gpuFree);
    const onDisk = disk === null ? null : diskFits(disk, BigInt(disk_bytes));
    return {id: version_id, label: label(version_id), memoryBytes: memory_bytes, diskBytes: disk_bytes,
            fits: gpu === false || onDisk === false ? false : gpu && onDisk ? true : null, missing: []};
  });
  const others = catalog.versions
    .filter((v) => v.role === 'helper' && v.compatible_service_version_ids.includes(serviceVersionId)
      && !placement.some((p) => p.version_id === v.id))
    .map((v) => ({id: v.id, label: v.label, memoryBytes: null, diskBytes: null, fits: null, missing: v.validation.missing}));
  return [...placed, ...others];
}
