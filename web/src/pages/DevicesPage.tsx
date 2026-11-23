import {useState, type FormEvent, type ReactNode} from 'react';
import {ChevronRight, Monitor, Server} from 'lucide-react';
import type {ConnectionTest, DeviceSummary, Enrollment} from '@/api/types';
import {describeError, type ApiError} from '@/api/errors';
import {ListRow, PageHeader} from '@/components/page';
import {StatusIcon, type Status} from '@/components/status';
import {Alert, AlertDescription} from '@/components/ui/alert';
import {Button} from '@/components/ui/button';
import {Card, CardContent, CardHeader, CardList} from '@/components/ui/card';
import {Input} from '@/components/ui/input';
import {Label} from '@/components/ui/label';
import {Pill, type Tone} from '@/components/ui/pill';
import {formatMbps, formatRoundTrip} from '@/lib/format';
import {useAction} from '@/lib/useAction';
import {
  cleanupAction,
  directionRows,
  isMac,
  testErrorMessage,
  testResultLabel,
  testStatus,
  waitingForAnotherDevice,
  type DirectionRow,
  type TestStatus,
} from '@/state/connectivity';
import {describeDevice, type DeviceView} from '@/state/deviceView';
import {useStore} from './Workspace';

// The devices are simulated (the repository's simulator/): a token is typed into the simulator's terminal, which runs
// beside the server and reads its certificate file, so the page gives no address or fingerprint to copy.
const SIMULATOR_COMMAND = 'npm run devices';

const DEVICE_STATE: Record<DeviceSummary['state'], {label: string; tone: Tone}> = {
  idle: {label: 'Idle', tone: 'success'},
  occupied: {label: 'In use', tone: 'neutral'},
  cleanup_required: {label: 'Needs cleanup', tone: 'warning'},
  offline: {label: 'Offline', tone: 'danger'},
  removed: {label: 'Removed', tone: 'neutral'},
};

export function DevicesPage() {
  const {devices} = useStore();
  return (
    <>
      <PageHeader
        title="Devices"
        description="The devices here are simulated: one serves the model and one helps, and no model runs. Their speeds are settings of the simulator, not measurements. Add each one, then test the connection between them."
      />
      <AddDeviceCard />
      <Card>
        <CardHeader title="Your devices" description="Each device reports what it can do. The full probe is under Details." />
        {devices.length === 0 && <CardContent><p className="text-sm text-muted-foreground">No devices yet.</p></CardContent>}
        {devices.length > 0 && (
          <CardList>
            {devices.map((device) => <DeviceRow key={device.id} device={device} />)}
          </CardList>
        )}
        {waitingForAnotherDevice(devices) && (
          <div className="flex items-center gap-2.5 border-t px-5 py-3.5 text-sm text-muted-foreground sm:px-6">
            <StatusIcon status="pending" />
            <span>Waiting for another device</span>
          </div>
        )}
      </Card>
      <ConnectionTestsCard />
    </>
  );
}

function AddDeviceCard() {
  const {client, devices, enrollment, dispatchEnrollment} = useStore();
  const [name, setName] = useState('');

  async function request(event: FormEvent) {
    event.preventDefault();
    dispatchEnrollment({type: 'request'});
    try {
      const issued = await client.post<Enrollment>('/enrollment-tokens', {device_name: name});
      dispatchEnrollment({type: 'issued', enrollment: issued});
    } catch (e) {
      dispatchEnrollment({type: 'issue_failed', reason: describeError((e as ApiError).body, devices)});
    }
  }

  return (
    <Card>
      <CardHeader title="Add a device" description="Name the device and create a token for it, then give the token to the simulator." />
      <CardContent className="flex flex-col gap-4">
        {enrollment.status === 'awaiting_token' && (
          <form className="flex flex-col gap-3 sm:flex-row sm:items-end" onSubmit={request}>
            <div className="flex min-w-0 flex-1 flex-col gap-2">
              <Label htmlFor="device-name">Device name</Label>
              <Input id="device-name" required maxLength={80} placeholder="For example, studio" value={name} onChange={(e) => setName(e.target.value)} />
            </div>
            <Button type="submit" size="lg" disabled={enrollment.requesting}>
              {enrollment.requesting ? 'Creating token' : 'Create token'}
            </Button>
          </form>
        )}
        {enrollment.status === 'awaiting_device' && (
          <EnrollmentDetails enrollment={enrollment.enrollment} onStartOver={() => dispatchEnrollment({type: 'restart'})} />
        )}
        {enrollment.status === 'enrolled' && (
          <div className="flex flex-wrap items-center justify-between gap-3 rounded-lg border bg-subtle px-4 py-3">
            <span className="flex min-w-0 items-center gap-2.5">
              <StatusIcon status="done" />
              <span className="min-w-0 text-sm [overflow-wrap:anywhere]">{enrollment.enrollment.device_name} is enrolled.</span>
            </span>
            <Button variant="outline" size="sm" onClick={() => dispatchEnrollment({type: 'restart'})}>
              Add another device
            </Button>
          </div>
        )}
        {enrollment.status === 'failed' && (
          <>
            <Alert variant="destructive"><AlertDescription>{enrollment.reason}</AlertDescription></Alert>
            <Button variant="outline" className="self-start" onClick={() => dispatchEnrollment({type: 'restart'})}>
              Request a new token
            </Button>
          </>
        )}
      </CardContent>
    </Card>
  );
}

function Command({children}: {children: string}) {
  return (
    <code data-testid="enroll-command" className="rounded-lg border bg-subtle px-3 py-2.5 font-mono text-xs leading-relaxed break-all">
      {children}
    </code>
  );
}

function Note({children}: {children: ReactNode}) {
  return <span className="text-[13px] text-muted-foreground">{children}</span>;
}

function Mono({children}: {children: string}) {
  return <span className="font-mono">{children}</span>;
}

function EnrollmentDetails({enrollment, onStartOver}: {enrollment: Enrollment; onStartOver: () => void}) {
  return (
    <div className="flex flex-col gap-4 text-sm">
      <p>One-time token for <strong className="font-medium break-all">{enrollment.device_name}</strong>. It is shown only once and expires in 24 hours.</p>
      <div data-testid="enroll-simulator" className="flex flex-col gap-1.5">
        <Note>In the terminal where the simulator runs (<Mono>{SIMULATOR_COMMAND}</Mono>), type this line with the name of a simulated device in place of <Mono>{'<device>'}</Mono>:</Note>
        <Command>{`enroll <device> ${enrollment.token}`}</Command>
        <Note>The simulator lists the names of its devices when it starts, <Mono>mac</Mono> and <Mono>gpu</Mono> unless you changed them. The token is typed into the simulator, not given on a command line, so it does not show in the process list.</Note>
      </div>
      <div className="flex flex-wrap items-center justify-between gap-3 border-t pt-4">
        <span className="flex items-center gap-2.5">
          <StatusIcon status="running" />
          <span>Waiting for the device to enroll.</span>
        </span>
        <Button variant="outline" size="sm" onClick={onStartOver}>Start over</Button>
      </div>
      <p className="text-[13px] text-muted-foreground">If the name is wrong or the token is lost, start over. This token stays valid until it expires; it cannot be revoked.</p>
    </div>
  );
}

function DeviceFacts({view}: {view: DeviceView}) {
  const facts: [string, string][] = [['System', view.system], ['Memory', view.memory]];
  if (view.gpus) facts.push(['GPU', view.gpus]);
  return (
    <dl className="flex flex-wrap gap-x-6 gap-y-1 text-[13px]">
      {facts.map(([term, value]) => (
        <div key={term} className="flex min-w-0 gap-1.5">
          <dt className="text-muted-foreground">{term}</dt>
          <dd className="min-w-0 [overflow-wrap:anywhere]">{value}</dd>
        </div>
      ))}
    </dl>
  );
}

function ProbeDetails({view}: {view: DeviceView}) {
  const {details} = view;
  const rows: [string, string[]][] = [
    ['System', [details.system]],
    ['Engines', details.engines],
    ['Python', details.interpreters],
    ['Addresses', details.addresses],
    ['Agent', [details.agent]],
    ['Prepared', details.prepared.length ? details.prepared : ['nothing yet']],
  ];
  return (
    <details className="group text-[13px]">
      <summary className="flex w-fit cursor-pointer list-none items-center gap-1 text-muted-foreground select-none hover:text-foreground [&::-webkit-details-marker]:hidden">
        <ChevronRight aria-hidden className="size-3.5 transition-transform group-open:rotate-90" />
        <span>Details</span>
      </summary>
      <dl className="mt-2 grid grid-cols-[auto_minmax(0,1fr)] gap-x-4 gap-y-1.5 rounded-lg border bg-subtle px-3.5 py-3">
        {rows.map(([term, values]) => (
          <div key={term} className="contents">
            <dt className="text-muted-foreground">{term}</dt>
            <dd className="min-w-0">
              <ul className="flex flex-col gap-0.5">
                {values.map((v) => <li key={v} className="font-mono text-xs [overflow-wrap:anywhere]">{v}</li>)}
              </ul>
            </dd>
          </div>
        ))}
      </dl>
    </details>
  );
}

function DeviceRow({device}: {device: DeviceSummary}) {
  const {client, devices, live} = useStore();
  const inventory = live.deviceDetails[device.id]?.inventory;
  const view = inventory ? describeDevice(inventory) : null;
  const action = cleanupAction(device);
  const [confirming, setConfirming] = useState(false);
  const recheck = useAction(() => client.post(`/devices/${device.id}/recheck`, {}));
  const remove = useAction(() => client.post(`/devices/${device.id}/remove`, {confirm_unavailable: true}));
  const actionError = recheck.error ?? remove.error;
  const state = DEVICE_STATE[device.state];
  const Icon = inventory && isMac(inventory) ? Monitor : Server;

  return (
    <ListRow
      testId={`device-${device.id}`}
      icon={<span className="flex size-9 items-center justify-center rounded-lg border bg-subtle"><Icon aria-hidden className="size-4 text-muted-foreground" /></span>}
      title={device.name}
      description={
        !view ? 'Reading device details.'
          : view.roles.length ? view.roles.map((r) => <span key={r} className="block text-foreground">{r}</span>)
          : <span className="text-warning">{view.blocked}</span>
      }
      aside={<Pill tone={state.tone}>{state.label}</Pill>}
    >
      {view && (
        <div className="flex flex-col gap-2 sm:pl-12">
          <DeviceFacts view={view} />
          <ProbeDetails view={view} />
        </div>
      )}
      {device.error && (
        <Alert variant="destructive" className="sm:ml-12 sm:w-auto"><AlertDescription>{describeError(device.error, devices)}</AlertDescription></Alert>
      )}
      {action && (
        <div className="flex flex-wrap gap-2 sm:pl-12">
          {action === 'recheck' && (
            <Button size="sm" variant="outline" disabled={recheck.pending} onClick={() => void recheck.run()}>Recheck</Button>
          )}
          {action === 'remove' && !confirming && (
            <Button size="sm" variant="outline" onClick={() => setConfirming(true)}>Remove device</Button>
          )}
          {action === 'remove' && confirming && (
            <Button size="sm" variant="destructive" className="h-auto min-h-8 whitespace-normal" disabled={remove.pending} onClick={() => void remove.run()}>
              This machine is gone. Remove it
            </Button>
          )}
        </div>
      )}
      {actionError && <p className="text-[13px] break-words text-danger sm:pl-12">{describeError(actionError.body, devices)}</p>}
    </ListRow>
  );
}

function ConnectionTestsCard() {
  const {devices, live, tests} = useStore();
  const rows = directionRows(devices, live.deviceDetails, tests);
  if (rows.length === 0) return null;
  return (
    <Card>
      <CardHeader
        title="Connection tests"
        description="The helper sends its drafts to the server directly. Only the helper → server direction has to pass; the other one is recorded for reference."
      />
      <CardList>
        {rows.map((row) => <DirectionTest key={row.key} row={row} />)}
      </CardList>
    </Card>
  );
}

const TEST_ICON: Record<TestStatus, Status> = {running: 'running', reachable: 'done', unreachable: 'failed', unknown: 'attention'};
const TEST_TONE: Record<TestStatus, Tone> = {running: 'neutral', reachable: 'success', unreachable: 'danger', unknown: 'warning'};

function DirectionTest({row}: {row: DirectionRow}) {
  const {client, devices, dispatchLive, memory} = useStore();
  const start = useAction(async () => {
    const {test} = await client.post<{test: ConnectionTest}>('/connection-tests', row.plan);
    memory.rememberTest(row.sourceId, row.targetId, test.id);
    dispatchLive({type: 'test_loaded', test});
  });
  const test = row.test;
  const status = test ? testStatus(test) : null;
  const result = test ? testResultLabel(test) : null;
  const stale = test !== null && status === 'reachable' && !test.valid;

  let description: string;
  if (!test) description = 'Not tested yet';
  else if (row.running) description = 'Running…';
  else if (status === 'reachable') {
    description = [
      `${test.source_address} → ${test.target_address}:${test.port}`,
      test.rtt_median_ms !== null ? `round trip ${formatRoundTrip(test.rtt_median_ms)}` : null,
      test.transfer_bytes !== null && test.transfer_ms !== null ? formatMbps(test.transfer_bytes, test.transfer_ms) : null,
      'simulated link',
    ].filter(Boolean).join(' · ');
  } else description = `Tested ${test.target_addresses.length === 1 ? 'one address' : `${test.target_addresses.length} addresses`} on port ${test.port}`;

  return (
    <ListRow
      testId={`direction-${row.label}`}
      icon={<StatusIcon status={status ? (stale ? 'attention' : TEST_ICON[status]) : 'pending'} />}
      title={row.label}
      description={description}
      aside={
        <>
          {result && <Pill tone={stale ? 'warning' : TEST_TONE[status!]}>{result}</Pill>}
          <Button size="sm" variant="outline" disabled={start.pending || row.running || row.plan === null} onClick={() => void start.run()}>
            {test && !row.running ? 'Run test again' : 'Run test'}
          </Button>
        </>
      }
    >
      {(test?.error || stale || row.note || row.blocked || start.error) && (
        <div className="flex flex-col gap-1 text-[13px] sm:pl-7">
          {test?.error && <p className="break-words text-danger">{describeError(test.error, devices)}</p>}
          {/* invalid_reason is a backend code (direction_unreachable); say what it means instead. */}
          {stale && (
            <p className="break-words text-muted-foreground">No longer valid: the address, port or device changed since the test. Run the test again.</p>
          )}
          {row.note && <p className="text-muted-foreground">{row.note}</p>}
          {row.blocked && <p className="text-muted-foreground">{row.blocked}</p>}
          {start.error && <p className="break-words text-danger">{testErrorMessage(start.error.body, devices)}</p>}
        </div>
      )}
    </ListRow>
  );
}
