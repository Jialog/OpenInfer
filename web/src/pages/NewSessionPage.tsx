import {useCallback, useEffect, useReducer, useRef, useState} from 'react';
import {describeError, type ApiError} from '@/api/errors';
import type {Catalog, ConnectionTest, ID, Preflight, Session} from '@/api/types';
import {ChevronRight} from 'lucide-react';
import {PageHeader} from '@/components/page';
import {ProgressBar} from '@/components/progress';
import {SegmentBar, type Segment} from '@/components/segments';
import {StatusIcon, type Status} from '@/components/status';
import {Alert, AlertDescription} from '@/components/ui/alert';
import {Button} from '@/components/ui/button';
import {Card, CardContent, CardHeader} from '@/components/ui/card';
import {Checkbox} from '@/components/ui/checkbox';
import {Label} from '@/components/ui/label';
import {NativeSelect, NativeSelectOption} from '@/components/ui/native-select';
import {Pill} from '@/components/ui/pill';
import {formatBytes} from '@/lib/format';
import {navigate} from '@/lib/route';
import {directionRows, testErrorMessage, testStatus, usableHelperTest} from '@/state/connectivity';
import {describePreflight, type CheckRow, type PreflightView} from '@/state/preflightView';
import {buildPlan, canStart, chosenVersion, deviceProblem, helperVersionOptions, initialWizard, selectionProblem, serviceVersionOptions, startPlan, wizardReducer} from '@/state/sessionWizard';

/** The helper choice that means the service machine alone. */
const NO_HELPER = 'none';
import {useStore} from './Workspace';

export function NewSessionPage() {
  const {client, devices, live, stale, tests} = useStore();
  const [state, dispatch] = useReducer(wizardReducer, initialWizard);
  const [catalog, setCatalog] = useState<Catalog | null>(null);
  const [catalogError, setCatalogError] = useState<ApiError | null>(null);
  const [serviceId, setServiceId] = useState('');
  const [helperId, setHelperId] = useState('');
  const [serviceVersionId, setServiceVersionId] = useState('');
  const [versionId, setVersionId] = useState('');

  const loadCatalog = useCallback(() => {
    setCatalogError(null);
    client.get<Catalog>('/catalog').then(setCatalog).catch((e) => setCatalogError(e as ApiError));
  }, [client]);
  useEffect(loadCatalog, [loadCatalog]);

  useEffect(() => {
    dispatch({type: 'devices_changed', devices});
  }, [devices]);

  const {preflightRun, preflightPending} = state;
  useEffect(() => {
    if (!preflightPending || !catalog) return;
    client
      .post<Preflight>('/sessions/preflight', buildPlan(state, state.serviceVersionId as string))
      .then((preflight) => dispatch({type: 'preflight_result', run: preflightRun, preflight}))
      .catch((e) => dispatch({type: 'preflight_failed', run: preflightRun, error: (e as ApiError).body}));
    // Each run number issues one call; the plan is read from the state of that run.
  }, [preflightRun, catalog]);

  useEffect(() => {
    if (state.step === 'created' && state.createdSessionId) navigate(`#/sessions/${state.createdSessionId}`);
  }, [state.step, state.createdSessionId]);

  async function create(key: string) {
    if (!catalog) return;
    try {
      const {session} = await client.post<{session: Session}>('/sessions', startPlan(state), {idempotencyKey: key});
      dispatch({type: 'created', sessionId: session.id});
    } catch (e) {
      const error = e as ApiError;
      dispatch(error.outcomeUnknown ? {type: 'create_timeout'} : {type: 'create_failed', error: error.body});
    }
  }

  function start() {
    const key = state.key ?? crypto.randomUUID();
    dispatch({type: 'start', key});
    void create(key);
  }

  function retry() {
    dispatch({type: 'retry'});
    void create(state.key as string);
  }

  // The devices a service version of the catalog runs on, and the versions the chosen one can serve (the first: the default)
  const servers = devices.filter((d) => {
    const inventory = live.deviceDetails[d.id]?.inventory;
    return catalog && inventory && serviceVersionOptions(catalog, inventory, false).length > 0;
  });
  const helpers = devices.filter((d) => d.id !== serviceId);
  const serviceInventory = live.deviceDetails[serviceId]?.inventory;
  const serviceVersions = catalog && serviceInventory ? serviceVersionOptions(catalog, serviceInventory, helperId !== NO_HELPER) : [];
  const serviceVersion = serviceVersions.includes(serviceVersionId) ? serviceVersionId : serviceVersions[0] ?? '';
  const selection = {
    serviceId: serviceId || null,
    helperId: helperId === NO_HELPER ? null : helperId || null,
    devices: live.devices,
    details: live.deviceDetails,
    tests,
    catalog,
  };
  const problem = helperId === '' && serviceId ? 'Choose a helper, or no helper.' : selectionProblem(selection);
  // Only the connection test is missing or no longer counts: it can be run again from here.
  const retestHere = problem !== null && selection.helperId !== null && deviceProblem(selection) === null;
  const connectionFailed = state.preflight?.checks.some((c) => c.code === 'direction_unreachable' && !c.passed) ?? false;
  // From the device step the checks then start as Continue starts them, if the same devices are still chosen; from the
  // checks they run again with the new test.
  const retest = useRetest((testId, service, helper) => {
    if (state.step === 'preflight') dispatch({type: 'retested', connectionTestId: testId});
    else if (state.step === 'devices' && service === serviceId && helper === helperId) {
      dispatch({type: 'select_devices', serviceId: service, serviceVersionId: serviceVersion, helperId: helper, connectionTestId: testId});
    }
  });

  const failed = state.preflight?.checks.filter((c) => !c.passed) ?? [];
  // The helper's free GPU memory and disk as the last preflight read them.
  const helperReading = (code: string) => state.preflight?.checks.find((c) => c.code === code && c.device_id === state.helperId)?.available_bytes ?? null;
  const helperFree = helperReading('capacity_insufficient'), helperDiskFree = helperReading('disk_insufficient');
  // whether a device has model folders of its own, which the server's disk rule reads from its inventory
  const localModelFolders = (id: string) => live.deviceDetails[id]?.inventory.local_model_folders ?? false;
  const helperDisk = helperDiskFree === null || state.helperId === null ? null
    : {disk_available_bytes: helperDiskFree, local_model_folders: localModelFolders(state.helperId)};
  const options = catalog && state.serviceVersionId ? helperVersionOptions(catalog, helperFree, helperDisk, state.serviceVersionId) : [];
  const noVersionFits = state.preflight !== null && state.helperId !== null && state.preflight.plan.helpers[0].version_id === null;
  const chosenId = chosenVersion(state);
  useEffect(() => {
    if (state.step === 'version') setVersionId(chosenId ?? '');
  }, [state.step]);
  // Only the helper's capacity failure (its draft model does not fit) has this remedy, and only when
  // the catalog has a helper version without a draft model to run instead.
  const withoutDraft = catalog?.versions.some((v) => v.role === 'helper' && v.draft_model?.enabled === false
    && v.compatible_service_version_ids.includes(state.serviceVersionId as string)) ?? false;
  const showNoSelfSpec = (withoutDraft && failed.some((c) => c.code === 'capacity_insufficient' && c.device_id === state.helperId))
    || state.draftModel === 'disabled';
  const chosen = catalog?.versions.find((v) => v.id === chosenId);
  const label = (id: string | null) => catalog?.versions.find((v) => v.id === id)?.label ?? id ?? '';
  const checks = state.preflight
    ? describePreflight(state.preflight.checks, {
        deviceName: (id) => live.devices[id]?.name ?? id,
        roleOf: (id) => (id === state.serviceId ? 'service' : id === state.helperId ? 'helper' : null),
        noVersionFits,
        localModelFolders,
      })
    : null;

  const error = state.error && <Alert variant="destructive"><AlertDescription>{describeError(state.error, devices)}</AlertDescription></Alert>;
  const stepIndex = {devices: 0, version: 1, preflight: 2, submitting: 3, created: 3}[state.step];
  const stepStatus = (index: number): Status => (index < stepIndex ? 'done' : index > stepIndex ? 'pending' : 'current');
  const names = [state.serviceId, state.helperId].map((id) => (id ? live.devices[id]?.name ?? id : null));
  const segments: Segment[] = [
    {key: 'devices', label: 'Devices', status: stepStatus(0),
     detail: stepIndex > 0 && names[0] ? (names[1] ? `${names[0]} and ${names[1]}` : `${names[0]} alone`) : 'A service machine and a helper'},
    {key: 'version', label: 'Helper version', status: stepStatus(1),
     detail: stepIndex > 0 && state.helperId === null ? 'No helper' : stepIndex > 1 && chosen ? chosen.label : 'The most precise that fits'},
    {key: 'checks', label: 'Checks', status: checks && checks.failed.length > 0 && stepIndex === 2 ? 'failed' : stepStatus(2),
     detail: state.preflightPending ? 'Checking…' : checks ? `${checks.passed} of ${checks.total} passed` : 'Before anything starts'},
  ];

  return (
    <>
      <PageHeader title="New session" description="Choose the server and the helper. OpenInfer picks the most precise helper version that fits in the helper's free GPU memory and checks that everything is in place before starting." />
      <SegmentBar segments={segments} testId="wizard-steps" />
      {catalogError && (
        <Alert variant="destructive">
          <AlertDescription>
            {describeError(catalogError.body, devices)}{' '}
            <Button size="sm" variant="outline" onClick={loadCatalog}>Try again</Button>
          </AlertDescription>
        </Alert>
      )}

      {state.step === 'devices' && (
        <Card>
          <CardHeader title="Choose devices" description="The service machine is a device a service version of the catalog runs on. A helper is optional; it connects to the service machine over the tested connection." />
          <CardContent className="flex flex-col gap-4">
            <div className="grid gap-4 sm:grid-cols-2">
              <div className="flex min-w-0 flex-col gap-2">
                <Label htmlFor="service">Service machine</Label>
                <NativeSelect id="service" className="w-full" value={serviceId} onChange={(e) => setServiceId(e.target.value)}>
                  <NativeSelectOption value="">Choose a service machine</NativeSelectOption>
                  {servers.map((d) => <NativeSelectOption key={d.id} value={d.id}>{d.name}</NativeSelectOption>)}
                </NativeSelect>
              </div>
              <div className="flex min-w-0 flex-col gap-2">
                <Label htmlFor="helper">Helper</Label>
                <NativeSelect id="helper" className="w-full" value={helperId} onChange={(e) => setHelperId(e.target.value)}>
                  <NativeSelectOption value="">Choose a helper</NativeSelectOption>
                  <NativeSelectOption value={NO_HELPER}>No helper</NativeSelectOption>
                  {helpers.map((d) => <NativeSelectOption key={d.id} value={d.id}>{d.name}</NativeSelectOption>)}
                </NativeSelect>
              </div>
            </div>
            {serviceVersions.length > 1 && (
              <div className="flex min-w-0 flex-col gap-2">
                <Label htmlFor="service-version">Service version</Label>
                <NativeSelect id="service-version" className="w-full" value={serviceVersion} onChange={(e) => setServiceVersionId(e.target.value)}>
                  {serviceVersions.map((id) => <NativeSelectOption key={id} value={id}>{label(id)}</NativeSelectOption>)}
                </NativeSelect>
              </div>
            )}
            {error}
            {problem && <p className="text-sm text-muted-foreground">{problem}</p>}
            {(retestHere || retest.running) && <RetestButton retest={retest} serviceId={serviceId} helperId={helperId} />}
            <div className="flex flex-wrap gap-2 border-t pt-4">
              <Button
                disabled={problem !== null}
                onClick={() => dispatch({
                  type: 'select_devices', serviceId, serviceVersionId: serviceVersion, helperId: selection.helperId,
                  connectionTestId: selection.helperId === null ? null : usableHelperTest(tests, selection.helperId, serviceId)!.id,
                })}
              >
                Continue
              </Button>
            </div>
          </CardContent>
        </Card>
      )}

      {state.step === 'version' && (
        <Card>
          <CardHeader
            title="Choose the helper version"
            description={`The most precise version comes first. A less precise one needs less GPU memory and disk${helperFree && helperDiskFree ? `; the helper has ${formatBytes(helperFree)} of GPU memory and ${formatBytes(helperDiskFree)} of disk free` : ''}. The service machine runs ${label(state.serviceVersionId)}.`}
          />
          <CardContent className="flex flex-col gap-4">
            <div className="flex flex-col gap-2">
              <Label htmlFor="version">Helper version</Label>
              <NativeSelect id="version" className="w-full" value={versionId} onChange={(e) => setVersionId(e.target.value)}>
                <NativeSelectOption value="">Choose a version</NativeSelectOption>
                {options.map((o) => (
                  <NativeSelectOption key={o.id} value={o.id} disabled={o.fits === false}>
                    {o.label}
                    {o.memoryBytes && o.diskBytes ? ` · needs ${formatBytes(o.memoryBytes)} of GPU memory and ${formatBytes(o.diskBytes)} of disk` : ''}
                    {o.fits === false ? ' · does not fit' : ''}
                    {o.missing.length ? ` (incomplete: ${o.missing.join(', ')})` : ''}
                  </NativeSelectOption>
                ))}
              </NativeSelect>
            </div>
            {error}
            <div className="flex flex-wrap gap-2 border-t pt-4">
              <Button disabled={!versionId} onClick={() => dispatch({type: 'choose_version', versionId})}>Check this version</Button>
              <Button variant="outline" onClick={() => dispatch({type: 'back', to: 'devices'})}>Change devices</Button>
            </div>
          </CardContent>
        </Card>
      )}

      {state.step === 'preflight' && (
        <Card>
          <CardHeader title="Checks" description="The devices and the chosen versions are checked before anything is started or downloaded." />
          <CardContent className="flex flex-col gap-5">
            {state.preflightPending && (
              <p className="flex items-center gap-2.5 text-sm text-muted-foreground"><StatusIcon status="running" />Checking…</p>
            )}
            {state.preflight && (chosen ? (
              <div className="flex flex-col gap-0.5 rounded-lg border bg-subtle px-3.5 py-3 text-sm">
                <span className="text-muted-foreground">Helper version</span>
                <span data-testid="chosen-version" className="font-medium [overflow-wrap:anywhere]">{chosen.label}</span>
                <span className="text-[13px] text-muted-foreground">
                  {state.versionId === null ? 'Chosen by OpenInfer: the most precise helper version that fits in the helper\'s free GPU memory.' : 'Chosen by you.'}
                </span>
              </div>
            ) : noVersionFits && (
              <p className="text-sm">No helper version fits in the helper's free GPU memory or disk space. The failed check below says which is short and what the smallest version needs.</p>
            ))}
            {checks && <PreflightChecks view={checks} allowed={state.preflight!.allowed} />}
            {state.serviceId && state.helperId && (retest.running || (connectionFailed && !state.preflightPending)) && (
              <RetestButton retest={retest} serviceId={state.serviceId} helperId={state.helperId} />
            )}
            {showNoSelfSpec && (
              <div className="flex items-start gap-2.5 rounded-lg border bg-subtle px-3.5 py-3 text-sm">
                <Checkbox
                  id="no-draft-model"
                  className="mt-0.5"
                  checked={state.draftModel === 'disabled'}
                  disabled={state.preflightPending}
                  onCheckedChange={(checked) => dispatch({type: 'set_draft_model', value: checked === true ? 'disabled' : 'enabled'})}
                />
                <Label htmlFor="no-draft-model" className="leading-snug font-normal">Run without the draft model, because it does not fit</Label>
              </div>
            )}
            {error}
            <div className="flex flex-wrap gap-2 border-t pt-4">
              <Button disabled={!canStart(state, stale)} onClick={start}>Start session</Button>
              <Button variant="outline" disabled={state.preflightPending} onClick={() => dispatch({type: 'recheck'})}>Check again</Button>
              {state.helperId !== null && <Button variant="outline" onClick={() => dispatch({type: 'back', to: 'version'})}>Change version</Button>}
              <Button variant="outline" onClick={() => dispatch({type: 'back', to: 'devices'})}>Change devices</Button>
            </div>
            {stale && <p className="text-sm text-muted-foreground">Reconnecting to the server. Starting is paused.</p>}
          </CardContent>
        </Card>
      )}

      {(state.step === 'submitting' || state.step === 'created') && (
        <Card>
          <CardHeader title="Starting the session" />
          <CardContent className="flex flex-col gap-4">
            {!state.uncertain && (
              <p className="flex items-center gap-2.5 text-sm text-muted-foreground"><StatusIcon status="running" />Waiting for the server…</p>
            )}
            {state.uncertain && (
              <>
                <p className="text-sm">No response from the server. The session may have been created. Trying again will not start a second one.</p>
                <div className="flex flex-wrap gap-2">
                  <Button disabled={stale} onClick={retry}>Try again</Button>
                  <Button variant="outline" onClick={() => dispatch({type: 'abandon'})}>Back</Button>
                </div>
                {stale && <p className="text-sm text-muted-foreground">Reconnecting to the server. Starting is paused.</p>}
              </>
            )}
          </CardContent>
        </Card>
      )}
    </>
  );
}

type RetestRun = {serviceId: ID; helperId: ID; testIds: ID[]};

/** Runs the two connection tests of the chosen devices again (the ones the Devices page runs) and, once both have
 *  finished, hands over the new helper -> Mac test if it counts, so the checks can run again. The rule that a
 *  restarted device program voids a test is unchanged. It lives with the page, so the button may
 *  go away (the test counts again) while the other direction is still being tested. */
function useRetest(onPassed: (testId: ID, serviceId: ID, helperId: ID) => void) {
  const {client, devices, dispatchLive, live, memory, tests} = useStore();
  const [run, setRun] = useState<RetestRun | null>(null);
  // From the click until the tests exist: the button is off then too, so a second click starts no second round.
  const [starting, setStarting] = useState(false);
  const startingNow = useRef(false);
  const [error, setError] = useState<ApiError | null>(null);
  const passed = useRef(onPassed);
  passed.current = onPassed;
  const rowsFor = (serviceId: ID, helperId: ID) => directionRows(devices, live.deviceDetails, tests)
    .filter((r) => (r.sourceId === helperId && r.targetId === serviceId) || (r.sourceId === serviceId && r.targetId === helperId));

  async function start(serviceId: ID, helperId: ID) {
    if (startingNow.current) return;
    startingNow.current = true;
    setStarting(true);
    setError(null);
    const results = await Promise.allSettled(rowsFor(serviceId, helperId).map(async (row) => {
      const {test} = await client.post<{test: ConnectionTest}>('/connection-tests', row.plan);
      memory.rememberTest(row.sourceId, row.targetId, test.id);
      dispatchLive({type: 'test_loaded', test});
      return test.id;
    }));
    const refused = results.find((r): r is PromiseRejectedResult => r.status === 'rejected');
    if (refused) setError(refused.reason as ApiError);
    const testIds = results.flatMap((r) => (r.status === 'fulfilled' ? [r.value] : []));
    // A start that created nothing leaves a round already under way as it is.
    if (testIds.length) setRun({serviceId, helperId, testIds});
    startingNow.current = false;
    setStarting(false);
  }

  useEffect(() => {
    if (!run || run.testIds.some((id) => !live.connectionTests[id] || testStatus(live.connectionTests[id]) === 'running')) return;
    setRun(null);
    const usable = usableHelperTest(tests, run.helperId, run.serviceId);
    if (usable && run.testIds.includes(usable.id)) passed.current(usable.id, run.serviceId, run.helperId);
  }, [run, live.connectionTests]);

  return {rowsFor, start, running: run !== null || starting, error, errorText: error ? testErrorMessage(error.body, devices) : null};
}

function RetestButton({retest, serviceId, helperId}: {retest: ReturnType<typeof useRetest>; serviceId: ID; helperId: ID}) {
  const rows = retest.rowsFor(serviceId, helperId);
  const ready = rows.length === 2 && rows.every((r) => r.plan !== null && !r.running);
  return (
    <div className="flex flex-col gap-2">
      <Button variant="outline" className="self-start" disabled={retest.running || !ready} onClick={() => void retest.start(serviceId, helperId)}>
        {retest.running ? 'Testing…' : rows.some((r) => r.test !== null) ? 'Test both directions again' : 'Test both directions'}
      </Button>
      {retest.errorText && <p className="text-[13px] break-words text-danger">{retest.errorText}</p>}
      {rows.map((r) => r.blocked && <p key={r.key} className="text-[13px] text-muted-foreground">{r.label}: {r.blocked}</p>)}
    </div>
  );
}

function CheckLine({row}: {row: CheckRow}) {
  return (
    <div className="flex min-w-0 flex-1 flex-col gap-0.5">
      <span className="min-w-0 [overflow-wrap:anywhere]">
        <span className="font-medium">{row.label}</span>
        {row.device && <span className="text-muted-foreground"> · {row.device}</span>}
      </span>
      {row.detail && <span className="text-[13px] [overflow-wrap:anywhere] text-muted-foreground">{row.detail}</span>}
      {row.remedy && <span className="text-[13px] [overflow-wrap:anywhere]">{row.remedy}</span>}
    </div>
  );
}

function PreflightChecks({view, allowed}: {view: PreflightView; allowed: boolean}) {
  return (
    <div className="flex flex-col gap-4">
      <ProgressBar value={view.passed} max={view.total} label={`${view.passed} of ${view.total} checks passed`} />
      {view.failed.length > 0 && (
        <ul data-testid="preflight-failed" className="divide-y rounded-lg border">
          {view.failed.map((row) => (
            <li key={row.key} className="flex items-start gap-3 px-4 py-3 text-sm">
              <StatusIcon status="failed" className="mt-0.5" />
              <CheckLine row={row} />
              <Pill tone="danger">Failed</Pill>
            </li>
          ))}
        </ul>
      )}
      {view.notices.length > 0 && (
        <ul data-testid="preflight-notices" className="divide-y rounded-lg border">
          {view.notices.map((row) => (
            <li key={row.key} className="flex items-start gap-3 px-4 py-3 text-sm">
              <StatusIcon status="attention" className="mt-0.5" />
              <CheckLine row={row} />
              <Pill tone="warning">Unverified</Pill>
            </li>
          ))}
        </ul>
      )}
      {allowed && view.failed.length === 0 && (
        <p className="flex items-center gap-2.5 text-sm"><StatusIcon status="done" />Everything is in place. The session can start.</p>
      )}
      {view.passedRows.length > 0 && (
        <details className="group text-sm">
          <summary className="flex w-fit cursor-pointer list-none items-center gap-1 text-muted-foreground select-none hover:text-foreground [&::-webkit-details-marker]:hidden">
            <ChevronRight aria-hidden className="size-4 transition-transform group-open:rotate-90" />
            <span>{view.passedRows.length === 1 ? 'Show the passed check' : `Show ${view.passedRows.length} passed checks`}</span>
          </summary>
          <ul className="mt-3 grid gap-x-8 gap-y-3 sm:grid-cols-2">
            {view.passedRows.map((row) => (
              <li key={row.key} className="flex min-w-0 items-start gap-2.5">
                <StatusIcon status="done" className="mt-0.5" />
                <CheckLine row={row} />
                <Pill tone="success">Passed</Pill>
              </li>
            ))}
          </ul>
        </details>
      )}
    </div>
  );
}
