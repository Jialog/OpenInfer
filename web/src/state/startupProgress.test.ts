import {describe, expect, it} from 'vitest';
import type {Instance} from '@/api/types';
import {makeInstance, makeSession} from '@/test/factories';
import {addSample, downloadRate, startupProgress, type ByteSample} from './startupProgress';

// Phases as a device reports them: prepare sends download, build, then
// verify once checking is done (:765-772); status reports map starting/loading to load, connectable to
// connect, ready to serve and failed to load (_phase_of, :921). A helper is ready only with a push
// connection (:1366). The backend writes load when it sends start and connect when start succeeds
// (control.ts:171, :384), and starts the helper only after the server is connectable.
function instance(device_id: string, phase: string, patch: Partial<Instance> = {}): Instance {
  return makeInstance({instance_id: `${device_id}-1`, session_id: 's', device_id, phase, ...patch});
}

const session = makeSession({id: 's', state: 'starting', phase: 'load'});
const names: Record<string, string> = {mac: 'service-mac', helper: 'helper-gpu'};
const input = (instances: Instance[], patch = {}) => ({
  session: {...session, ...patch}, serviceId: 'mac', helperId: 'helper', instances, deviceName: (id: string) => names[id] ?? id,
});
const statuses = (row: {segments: {key: string; status: string}[]}) => Object.fromEntries(row.segments.map((s) => [s.key, s.status]));
const failure = (message: string) => ({code: 'x', message, field: null, device_id: null, phase: null, retryable: false});

describe('startup progress', () => {
  it('has only the steps a device really reports: server prepare and load, helper prepare, download and load', () => {
    const view = startupProgress(input([instance('mac', 'prepare'), instance('helper', 'prepare')]));
    expect(view.rows.map((r) => r.title)).toEqual(['Server · service-mac', 'Helper · helper-gpu']);
    expect(view.rows[0].segments.map((s) => s.label)).toEqual(['Prepare', 'Load']);
    expect(view.rows[1].segments.map((s) => s.label)).toEqual(['Prepare', 'Download', 'Load']);
    expect(view.warmup.label).toBe('Warm up');
  });

  it('shows each device at its own phase, so nothing jumps between them', () => {
    // The session phase is whichever device reported last; it is not read for the device rows.
    const a = startupProgress(input([instance('mac', 'load'), instance('helper', 'download')], {phase: 'download'}));
    const b = startupProgress(input([instance('mac', 'load'), instance('helper', 'download')], {phase: 'load'}));
    expect(a).toEqual(b);
    expect(statuses(a.rows[0])).toEqual({prepare: 'done', load: 'current'});
    expect(statuses(a.rows[1])).toEqual({prepare: 'done', download: 'current', load: 'pending'});
  });

  it('names the work inside a step: downloading, building', () => {
    const view = startupProgress(input([instance('mac', 'download'), instance('helper', 'build')]));
    expect(view.rows[0].segments[0]).toMatchObject({key: 'prepare', status: 'current', detail: 'Downloading the model'});
    expect(view.rows[1].segments[1]).toMatchObject({key: 'download', status: 'current', detail: 'Building the engine'});
  });

  it('reads verify as preparation finished', () => {
    const view = startupProgress(input([instance('mac', 'verify'), instance('helper', 'download')]));
    expect(view.rows[0].segments[0]).toMatchObject({status: 'done', detail: 'Files verified'});
    expect(view.rows[0].segments[1].status).toBe('pending');
  });

  it('the server is loading and the helper waits for it, not stuck verifying', () => {
    // session phase load, service-mac load, helper-gpu verify.
    const view = startupProgress(input([instance('mac', 'load'), instance('helper', 'verify')], {phase: 'load'}));
    expect(view.rows[0].segments[1]).toMatchObject({key: 'load', status: 'current', detail: 'Loading and calibrating'});
    expect(view.rows[1].segments[1]).toMatchObject({key: 'download', status: 'done', detail: 'Files verified'});
    expect(view.rows[1].segments[2]).toMatchObject({key: 'load', status: 'waiting', detail: 'Waiting for the server'});
  });

  it('follows the real sequence to the warm-up', () => {
    // The server becomes connectable; the backend starts the helper, which loads and connects.
    const connecting = startupProgress(input([instance('mac', 'connect', {state: 'connectable'}), instance('helper', 'load', {state: 'loading'})]));
    expect(statuses(connecting.rows[0])).toEqual({prepare: 'done', load: 'done'});
    expect(connecting.rows[0].segments[1].detail).toBe('Waiting for the helper');
    expect(connecting.rows[1].segments[2]).toMatchObject({key: 'load', status: 'current', detail: 'Loading and connecting'});
    // The helper is ready once it holds a push connection; its start then completes and the warm-up runs.
    const ready = startupProgress(input([instance('mac', 'connect', {state: 'connectable'}),
                                         instance('helper', 'serve', {state: 'ready', push_connection_id: 'p'})]));
    expect(statuses(ready.rows[1])).toEqual({prepare: 'done', download: 'done', load: 'done'});
    expect(ready.rows[1].segments[2].detail).toBe('Connected');
    const warming = startupProgress(input([instance('mac', 'connect'), instance('helper', 'connect', {push_connection_id: 'p'})], {phase: 'warmup'}));
    expect(warming.rows.every((r) => r.segments.every((s) => s.status === 'done'))).toBe(true);
    expect(warming.warmup.status).toBe('current');
    expect(startupProgress(input([instance('mac', 'load'), instance('helper', 'verify')])).warmup.status).toBe('pending');
  });

  it('does not show waiting once the server is connectable, before the helper is started', () => {
    const view = startupProgress(input([instance('mac', 'connect', {state: 'connectable'}), instance('helper', 'verify')]));
    expect(view.rows[1].segments[2].status).toBe('pending');
  });

  it('shows a failed instance on the step it was in, with its reason', () => {
    const view = startupProgress(input([instance('mac', 'load'), instance('helper', 'load', {state: 'failed', error: failure('Out of memory.')})]));
    expect(view.rows[1].segments[2]).toMatchObject({key: 'load', status: 'failed', detail: 'Out of memory.'});
    const download = startupProgress(input([instance('mac', 'load'), instance('helper', 'download', {state: 'failed', error: failure('Hash mismatch.')})]));
    expect(statuses(download.rows[1])).toEqual({prepare: 'done', download: 'failed', load: 'pending'});
  });

  it('puts a failure at a phase it does not know on the last step', () => {
    // A leftover instance is cleanup_required with phase kill (device.py _phase_of default).
    const view = startupProgress(input([instance('mac', 'kill', {state: 'cleanup_required', error: failure('Port 40360 is still held.')}),
                                        instance('helper', 'verify')]));
    expect(view.rows[0].segments[1]).toMatchObject({key: 'load', status: 'failed', detail: 'Port 40360 is still held.'});
  });

  it('reads the newest generation of a device and waits when there is no instance yet', () => {
    const old = instance('helper', 'kill', {generation: 1, state: 'stopped'});
    const fresh = instance('helper', 'download', {instance_id: 'h2', generation: 2});
    const view = startupProgress(input([instance('mac', 'load'), old, fresh]));
    expect(statuses(view.rows[1]).download).toBe('current');
    const none = startupProgress(input([]));
    expect(none.rows[0].segments.every((s) => s.status === 'pending')).toBe(true);
  });
});

// A helper's first download can be many gigabytes and take many minutes: the page shows more than "Downloading the model".
describe('download progress', () => {
  const GB = 1e9;
  const at = (seconds: number) => new Date(Date.parse('2026-11-14T19:05:40Z') + seconds * 1000).toISOString();
  const progress = (done: number, total: number | null, seconds: number) =>
    ({completed_bytes: String(done), total_bytes: total === null ? null : String(total), at: at(seconds)});
  const downloading = (p: Instance['progress']) => instance('helper', 'download', {progress: p});

  it('shows downloaded and total in GB with one decimal and the share done; no speed from one report', () => {
    const view = startupProgress(input([instance('mac', 'load'), downloading(progress(3.24 * GB, 18_702_184_960, 0))]));
    expect(view.rows[1].download).toEqual({completed: 3.24 * GB, total: 18_702_184_960, label: '3.2 of 18.7 GB · 17%'});
    expect(view.rows[1].segments[1]).toMatchObject({key: 'download', status: 'current', detail: 'Downloading the model'});
    expect(view.rows[0].download).toBeNull();
  });

  it('adds the speed and about how long is left once two reports some seconds apart are seen', () => {
    let samples = addSample([], progress(1 * GB, 18.7 * GB, 0), 0);
    samples = addSample(samples, progress(1.143 * GB, 18.7 * GB, 10), 10_000);
    const rate = downloadRate(samples, 10_000);
    expect(rate).toBeCloseTo(14.3e6, -3);
    const view = startupProgress(input([downloading(progress(1.143 * GB, 18.7 * GB, 10))], {}), {[`helper-1`]: rate});
    // 17.557 GB left at 14.3 MB/s is 1228 s: about 20 min.
    expect(view.rows[1].download!.label).toBe('1.1 of 18.7 GB · 6% · 14.3 MB/s · about 20 min left');
  });

  it('measures the speed over the last 30 s of reports, by the server time of each report', () => {
    let samples: ByteSample[] = [];
    // A jump of cached files at the start, then 10 MB/s for 60 s.
    samples = addSample(samples, progress(0, 100 * GB, 0), 0);
    samples = addSample(samples, progress(5 * GB, 100 * GB, 1), 1000);
    for (let s = 2; s <= 61; s += 1) samples = addSample(samples, progress(5 * GB + (s - 1) * 10e6, 100 * GB, s), s * 1000);
    expect(downloadRate(samples, 61_000)).toBeCloseTo(10e6, -2);
    expect(samples[0].at).toBeGreaterThanOrEqual(Date.parse(at(61)) - 31_000);
  });

  it('shows no speed when it cannot tell: one report, reports under 2 s apart, or no new bytes for 15 s', () => {
    expect(downloadRate(addSample([], progress(1 * GB, 2 * GB, 0), 0), 0)).toBeNull();
    const close = addSample(addSample([], progress(1 * GB, 2 * GB, 0), 0), progress(1.1 * GB, 2 * GB, 1), 1000);
    expect(downloadRate(close, 1000)).toBeNull();
    const apart = addSample(addSample([], progress(1 * GB, 2 * GB, 0), 0), progress(1.1 * GB, 2 * GB, 10), 10_000);
    expect(downloadRate(apart, 24_000)).not.toBeNull();
    expect(downloadRate(apart, 26_000)).toBeNull();
  });

  it('keeps a report only when the bytes grew', () => {
    const one = addSample([], progress(1 * GB, 2 * GB, 0), 0);
    expect(addSample(one, progress(1 * GB, 2 * GB, 0), 500)).toBe(one);
  });

  it('formats what is left: under a minute, minutes, hours and minutes', () => {
    const left = (rate: number) => startupProgress(input([downloading(progress(10 * GB, 20 * GB, 0))]), {'helper-1': rate}).rows[1].download!.label;
    expect(left(1e9)).toBe('10.0 of 20.0 GB · 50% · 1000.0 MB/s · less than a minute left');
    expect(left(10e6)).toBe('10.0 of 20.0 GB · 50% · 10.0 MB/s · about 17 min left');
    expect(left(2e6)).toBe('10.0 of 20.0 GB · 50% · 2.0 MB/s · about 1 h 23 min left');
  });

  it('shows only the downloaded amount when the total is not known', () => {
    const view = startupProgress(input([downloading(progress(2.5 * GB, null, 0))]), {'helper-1': 5e6});
    expect(view.rows[1].download).toEqual({completed: 2.5 * GB, total: null, label: '2.5 GB downloaded · 5.0 MB/s'});
  });

  it('shows the server download in its Prepare step, and nothing once the download is over', () => {
    const mac = instance('mac', 'download', {progress: progress(8 * GB, 16 * GB, 0)});
    expect(startupProgress(input([mac])).rows[0].download!.label).toBe('8.0 of 16.0 GB · 50%');
    expect(startupProgress(input([instance('mac', 'build', {progress: progress(8 * GB, 16 * GB, 0)})])).rows[0].download).toBeNull();
  });
});
