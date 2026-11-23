// Startup as one row of steps per device, read from each device's own instance (docs/API.md).
// Session.phase is whichever device reported last, so it only decides the final warm-up, which runs once for
// both. The steps are the phases a device reports: prepare sends download and
// build, and verify once checking is done; status reports say load while starting or loading, connect once the
// server is connectable, serve once ready. Calibration (server) and connecting (helper) happen inside load and
// are never reported on their own, so they are named in the Load step's small text, not given steps.
import type {ID, Instance, SessionSummary} from '@/api/types';
import type {Segment} from '@/components/segments';

/** A download in progress: bytes so far, the total when known, and the line that says it. */
export type DownloadView = {completed: number; total: number | null; label: string};
export type StartupRow = {key: 'service' | 'helper'; title: string; segments: Segment[]; download: DownloadView | null};
export type StartupInput = {
  session: SessionSummary;
  serviceId: ID | null;
  helperId: ID | null;
  instances: Instance[];
  deviceName: (id: ID) => string;
};

type Step = {key: string; label: string; phases: string[]; doing?: string};

const STEPS: Record<StartupRow['key'], Step[]> = {
  service: [
    {key: 'prepare', label: 'Prepare', phases: ['prepare', 'download', 'build', 'verify']},
    {key: 'load', label: 'Load', phases: ['load'], doing: 'Loading and calibrating'},
  ],
  helper: [
    {key: 'prepare', label: 'Prepare', phases: ['prepare']},
    {key: 'download', label: 'Download', phases: ['download', 'build', 'verify']},
    {key: 'load', label: 'Load', phases: ['load'], doing: 'Loading and connecting'},
  ],
};

// Startup phases in the order they are reported.
const ORDER = ['prepare', 'download', 'build', 'verify', 'load', 'connect', 'warmup', 'serve'];
const LOAD = ORDER.indexOf('load');
const CONNECT = ORDER.indexOf('connect');

const DOING: Record<string, string> = {
  prepare: 'Checking what is needed',
  download: 'Downloading the model',
  build: 'Building the engine',
};

const TITLE = {service: 'Server', helper: 'Helper'};

function newest(instances: Instance[], deviceId: ID | null): Instance | undefined {
  return instances.filter((i) => i.device_id === deviceId).reduce<Instance | undefined>((a, b) => (!a || b.generation > a.generation ? b : a), undefined);
}

// The download speed, measured in the page from the reports it sees (the server keeps only the newest one). It is taken
// over the last RATE_WINDOW_MS of reports by the server's time of each, so the jump of files already in the cache at the
// start falls out of it; it is not shown from reports less than MIN_SPAN_MS apart, or once no new bytes have come for
// STALL_MS by the page's clock.
export type ByteSample = {bytes: number; at: number; seen: number};
const RATE_WINDOW_MS = 30_000;
const MIN_SPAN_MS = 2_000;
const STALL_MS = 15_000;

/** SAMPLES with the report PROGRESS added if its bytes grew; SEEN is the page's clock (ms) when it arrived. */
export function addSample(samples: ByteSample[], progress: NonNullable<Instance['progress']>, seen: number): ByteSample[] {
  const bytes = Number(progress.completed_bytes), at = Date.parse(progress.at);
  if (samples.length && bytes <= samples[samples.length - 1].bytes) return samples;
  const next = [...samples, {bytes, at, seen}];
  // Keep the newest report at or before the window's start, so the measurement spans the whole window.
  let start = 0;
  while (start + 1 < next.length && next[start + 1].at <= at - RATE_WINDOW_MS) start += 1;
  return start > 0 ? next.slice(start) : next;
}

/** Bytes per second, or null when it cannot be told; NOW is the page's clock (ms). */
export function downloadRate(samples: ByteSample[], now: number): number | null {
  if (samples.length < 2) return null;
  const first = samples[0], last = samples[samples.length - 1];
  if (last.at - first.at < MIN_SPAN_MS || now - last.seen > STALL_MS) return null;
  return ((last.bytes - first.bytes) * 1000) / (last.at - first.at);
}

function timeLeft(seconds: number): string {
  if (seconds < 60) return 'less than a minute left';
  const minutes = Math.round(seconds / 60);
  return minutes < 60 ? `about ${minutes} min left` : `about ${Math.floor(minutes / 60)} h ${minutes % 60} min left`;
}

function downloadView(progress: Instance['progress'], rate: number | null): DownloadView | null {
  if (!progress) return null;
  const completed = Number(progress.completed_bytes), total = progress.total_bytes === null ? null : Number(progress.total_bytes);
  const gb = (bytes: number) => (bytes / 1e9).toFixed(1);
  const parts = total ? [`${gb(completed)} of ${gb(total)} GB`, `${Math.floor((completed / total) * 100)}%`] : [`${gb(completed)} GB downloaded`];
  if (rate !== null && rate > 0) {
    parts.push(`${(rate / 1e6).toFixed(1)} MB/s`);
    if (total) parts.push(timeLeft((total - completed) / rate));
  }
  return {completed, total, label: parts.join(' · ')};
}

function deviceRow(role: StartupRow['key'], deviceId: ID, input: StartupInput, rates: Record<ID, number | null>): StartupRow {
  const row = deviceSteps(role, deviceId, input);
  const instance = newest(input.instances, deviceId);
  const download = instance?.phase === 'download' && instance.state !== 'failed' && instance.state !== 'cleanup_required'
    ? downloadView(instance.progress, rates[instance.instance_id] ?? null) : null;
  return {...row, download};
}

function deviceSteps(role: StartupRow['key'], deviceId: ID, input: StartupInput): Omit<StartupRow, 'download'> {
  const steps = STEPS[role];
  const instance = newest(input.instances, deviceId);
  const title = `${TITLE[role]} · ${input.deviceName(deviceId)}`;
  const at = (status: Segment['status'], index: number, detail?: string | null): Segment[] => steps.map((step, i) => ({
    key: step.key,
    label: step.label,
    status: i < index ? 'done' : i > index ? 'pending' : status,
    ...(i === index && detail ? {detail} : {}),
  }));
  if (!instance) return {key: role, title, segments: at('pending', -1)};

  const phaseAt = ORDER.indexOf(instance.phase);
  const stepOf = steps.findIndex((s) => s.phases.includes(instance.phase));
  const last = steps.length - 1;

  if (instance.state === 'failed' || instance.state === 'cleanup_required') {
    // A phase outside the steps (beyond load, or one not listed such as kill) puts the failure on the last step.
    const index = stepOf === -1 ? last : stepOf;
    return {key: role, title, segments: at('failed', index, instance.error?.message ?? DOING[instance.phase] ?? null)};
  }
  const warming = input.session.phase === 'warmup';
  if (warming || phaseAt > LOAD) {
    const segments = at('done', steps.length);
    const end = role === 'helper' ? 'Connected' : warming ? null : 'Waiting for the helper';
    if (end) segments[last].detail = end;
    return {key: role, title, segments};
  }
  if (stepOf === -1) return {key: role, title, segments: at('pending', -1)};
  if (instance.phase === 'verify') {
    const segments = at('pending', stepOf + 1);
    segments[stepOf].detail = 'Files verified';
    // The backend starts the helper only once the server is connectable.
    const server = newest(input.instances, input.serviceId);
    if (role === 'helper' && (!server || ORDER.indexOf(server.phase) < CONNECT)) {
      segments[stepOf + 1] = {...segments[stepOf + 1], status: 'waiting', detail: 'Waiting for the server'};
    }
    return {key: role, title, segments};
  }
  return {key: role, title, segments: at('current', stepOf, steps[stepOf].doing ?? DOING[instance.phase])};
}

/** RATES: each downloading instance's speed in bytes per second (downloadRate), by instance ID. */
export function startupProgress(input: StartupInput, rates: Record<ID, number | null> = {}): {rows: StartupRow[]; warmup: Segment} {
  const rows: StartupRow[] = [];
  if (input.serviceId) rows.push(deviceRow('service', input.serviceId, input, rates));
  if (input.helperId) rows.push(deviceRow('helper', input.helperId, input, rates));
  const {session} = input;
  const warmup: Segment = session.phase === 'warmup'
    ? {key: 'warmup', label: 'Warm up', status: 'current', detail: 'Running one short request on both devices'}
    : session.state === 'ready' || session.state === 'degraded'
      ? {key: 'warmup', label: 'Warm up', status: 'done'}
      : {key: 'warmup', label: 'Warm up', status: 'pending', detail: 'Once both devices are connected'};
  return {rows, warmup};
}
