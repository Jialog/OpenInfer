// The real app on the fake backend, for looking at pages, screenshots and the phone-width check. Not part of
// the build. Query flags: `stress` uses long unbroken names (for the overflow check), `signed-out` starts at
// the sign-in page, `preflight=fail` makes the checks fail, `cleanup` adds two devices awaiting cleanup,
// `reserve=<session id>` makes that session hold the two devices, `stale-test` makes the helper -> Mac test invalid,
// `unverified` reports the service machine as a Mac without the verified chip, `registration=closed` refuses new
// accounts, `certificate=<path>` names the certificate file the control plane loaded.
import {createRoot} from 'react-dom/client';
import {App} from '@/App';
import '@/index.css';
import type {PreflightCheck} from '@/api/types';
import {FakeBackend} from './fakeBackend';
import {BrowserMemory} from '@/lib/memory';
import {makeApiKey, makeDevice, makeError, makeInstance, makeInventory, makeRequest, makeSession, makeTest} from './factories';

const params = new URLSearchParams(window.location.search);
const stress = params.has('stress');
const GiB = 2 ** 30;
const LONG = 'a-very-long-unbroken-name-'.repeat(4);
const fake = new FakeBackend();
fake.install();
fake.registrationClosed = params.get('registration') === 'closed';
if (params.has('certificate')) fake.certificatePath = params.get('certificate');

if (!params.has('signed-out')) {
  fake.loggedIn = {user_id: 'u', email: stress ? 'someone.with.a.long.address@example.com' : 'owner@example.com', group_id: 'g', csrf_token: 'c', expires_at: '2026-11-15T12:00:00Z'};
}

// Shaped like what real devices report: the probe lists more engines than the roles use, and an
// engine's error names an interpreter path.
const missing = (what: string, path: string) => makeError({code: 'engine_missing', message: `not installed in ${path}: ${what}`});
const mac = makeDevice({id: 'mac', kind: 'mac', name: stress ? `studio-${LONG}`.slice(0, 80) : 'service-mac', inventory: makeInventory('mac', {
  memory_available_bytes: String(Math.round(22.5 * GiB)),
  disk_available_bytes: String(Math.round(109.9 * GiB)),
  gpus: [{id: '0', model: 'Apple M2 Pro', vendor: 'Apple', total_bytes: String(32 * GiB), available_bytes: String(Math.round(22.5 * GiB)),
          compute_tflops: null, bandwidth_gbps: null, driver: null}],
  engines: [
    {name: 'sglang', version: null, available: false, build: null, error: missing('sglang', '/opt/openinfer/envs/mlx/bin/python')},
    {name: 'mlx', version: '0.32.3', available: true, build: null, error: null},
    {name: 'llama.cpp', version: null, available: true, build: null, error: null},
    {name: 'ngram', version: null, available: true, build: null, error: null},
  ],
})});
const helper = makeDevice({id: 'helper', kind: 'linux', name: stress ? `gpu-box-${LONG}`.slice(0, 80) : 'helper-gpu', inventory: makeInventory('linux', {
  machine_model: 'Workstation',
  memory_total_bytes: String(Math.round(125.7 * GiB)),
  disk_available_bytes: String(Math.round(864.4 * GiB)),
  gpus: [{id: '0', model: 'RTX A5000', vendor: 'NVIDIA', total_bytes: String(24 * GiB), available_bytes: String(Math.round(19.5 * GiB)),
          compute_tflops: null, bandwidth_gbps: null, driver: '550.120'}],
  engines: [
    {name: 'sglang', version: null, available: true, build: null, error: null},
    {name: 'mlx', version: null, available: false, build: null, error: missing('mlx, mlx_lm', '/opt/openinfer/envs/helper/bin/python')},
    {name: 'llama.cpp', version: null, available: true, build: null, error: null},
    {name: 'ngram', version: null, available: true, build: null, error: null},
  ],
})});
const devices = [mac, helper];
if (stress || params.has('cleanup')) {
  devices.push(makeDevice({id: 'gone', kind: 'linux', name: 'old-box', state: 'offline', cleanup_required: true}));
  devices.push(makeDevice({id: 'stuck', kind: 'linux', name: 'stuck-box', state: 'cleanup_required', cleanup_required: true,
                           error: makeError({code: 'cleanup_required', phase: 'kill', device_id: 'stuck',
                                             message: stress ? `Still running: ${LONG}` : 'Process group 41822 is still running and holds port 40360.'})}));
}
for (const device of devices) fake.devices.set(device.id, device);

const reachable = makeTest({source_device_id: 'helper', target_device_id: 'mac', state: 'reachable', valid: true, source_address: '192.0.2.20',
                            target_address: '192.0.2.10', rtt_median_ms: 0.4023140063509345, transfer_bytes: '8000000', transfer_ms: 69.3});
const unreachable = makeTest({source_device_id: 'mac', target_device_id: 'helper', state: 'unreachable', target_addresses: ['192.0.2.20', '198.51.100.7'],
                              error: makeError({code: 'direction_unreachable', phase: 'connect', device_id: 'mac',
                                                message: stress ? `Connection refused on ${LONG}` : '192.0.2.20: No route to host; 198.51.100.7: timed out'})});
// `stale-test`: the helper -> Mac measurement no longer matches the devices (valid/invalid_reason).
if (params.has('stale-test')) Object.assign(reachable, {valid: false, invalid_reason: 'direction_unreachable'});
for (const test of [reachable, unreachable]) fake.tests.set(test.id, test);

if (stress) {
  const starting = makeSession({id: 'starting-session', state: 'starting', phase: 'calibrate',
                                error: makeError({phase: 'load', device_id: 'helper', message: `Could not read ${LONG}`})});
  const ready = makeSession({id: 'ready-session', state: 'degraded', phase: 'serve', uncleared_device_ids: ['stuck']});
  for (const session of [starting, ready]) fake.sessions.set(session.id, session);
  fake.updateDevice('gone', {reservation: {session_id: ready.id, role: 'helper'}});
  const request = makeRequest({session_id: ready.id, state: 'running', contiguous_seq: '0'});
  fake.requests.set(request.id, request);
  fake.sessions.get(ready.id)!.active_request_ids = [request.id];
  fake.emitChunk(request.id, `Thinking with a long unbroken stretch ${LONG}${LONG}`, 32, false, 'think');
  fake.emitChunk(request.id, `Output with a long unbroken stretch ${LONG}${LONG}\n\nand some ordinary words after it. `, 32, false, 'answer');
  Object.assign(window, {previewRequestId: request.id});
  // An older request a program sent through the API, for the recent-requests list.
  const program = makeRequest({session_id: ready.id, state: 'running', source: 'api', api_key_id: 'key-long', received_at: '2026-11-08T11:00:00Z'});
  fake.requests.set(program.id, program);
  fake.emitChunk(program.id, `Thinking ${LONG}${LONG}`, 32, true, 'think');
  fake.emitChunk(program.id, `Answer ${LONG}${LONG}`, 32, true, 'answer');
  Object.assign(program, {state: 'completed', final_seq: program.contiguous_seq, archive_state: 'saved'});
  for (const key of [
    makeApiKey({id: 'key-long', name: `scripts-${LONG}`.slice(0, 80), last_used_at: '2026-11-08T11:00:00Z'}),
    makeApiKey({name: `revoked-${LONG}`.slice(0, 80), revoked_at: '2026-11-08T11:30:00Z'}),
  ]) fake.apiKeys.set(key.id, key);
}

if (!stress) {
  // One session per state the session page shows, all on the same two devices.
  const versions = fake.catalog.versions.filter((v) => v.id === 'service-v1' || v.id === 'helper-v1');
  const minutesAgo = (m: number) => new Date(Date.now() - m * 60_000).toISOString();
  const session = (id: string, minutes: number, patch: Parameters<typeof makeSession>[0]) => {
    const s = makeSession({id, created_at: minutesAgo(minutes), effective_config: {versions}, ...patch});
    fake.sessions.set(id, s);
    return s;
  };
  const instances = (id: string, mac: Parameters<typeof makeInstance>[0], helper: Parameters<typeof makeInstance>[0]) => [
    makeInstance({session_id: id, device_id: 'mac', ...mac}),
    makeInstance({session_id: id, device_id: 'helper', ...helper}),
  ];
  session('starting', 1, {state: 'starting', phase: 'download',
    instances: instances('starting', {phase: 'load', state: 'loading'}, {phase: 'build'})});
  // A first start: the helper downloads UD-Q4_K_XL and its draft, 18,702,184,960 bytes.
  session('downloading', 2, {state: 'starting', phase: 'download',
    instances: instances('downloading', {phase: 'load', state: 'loading'}, {phase: 'download',
      progress: {completed_bytes: '6120000000', total_bytes: '18702184960', at: new Date(Date.now() - 10_000).toISOString()}})});
  // The phases devices report. `waiting`: the server loads, the helper has verified its files and waits for it.
  session('waiting', 3, {state: 'starting', phase: 'load',
    instances: instances('waiting', {phase: 'load', state: 'loading'}, {phase: 'verify'})});
  session('connecting', 4, {state: 'starting', phase: 'load',
    instances: instances('connecting', {phase: 'connect', state: 'connectable'}, {phase: 'load', state: 'loading'})});
  session('warming', 2, {state: 'starting', phase: 'warmup',
    instances: instances('warming', {phase: 'connect', state: 'connectable'}, {phase: 'serve', state: 'ready', push_connection_id: 'push-1'})});
  session('start-failed', 30, {state: 'failed', phase: 'kill', stop_cause: 'startup_failure', ended_at: minutesAgo(29),
    error: makeError({code: 'startup_failure', phase: 'load', device_id: 'helper', message: 'The helper ran out of GPU memory while loading the draft model.'})});
  session('stopping', 5, {state: 'stopping', phase: 'term', stop_deadline_at: new Date(Date.now() + 40_000).toISOString()});
  session('ended', 90, {state: 'ended', phase: 'kill', ended_at: minutesAgo(80), uncleared_device_ids: ['helper']});
  const ready = session('ready', 12, {state: 'ready', phase: 'serve'});
  const degraded = session('degraded', 20, {state: 'degraded', phase: 'serve'});

  // A finished request on the ready session: an answer of 188 tokens at 29.3 tok/s
  // end to end and 38.7 tok/s decode, 146 of them written by the helper.
  const answer = "We need to answer the user's request: a Python function returning the nth Fibonacci number with an iterative loop, then the time complexity in one sentence. State time O(n), space O(1).\n\n\n```python\ndef fibonacci(n: int) -> int:\n    if n < 0:\n        raise ValueError(\"n must be non-negative\")\n\n    a, b = 0, 1\n    for _ in range(n):\n        a, b = b, a + b\n    return a\n```\n\nThe function runs in O(n) time because it performs one constant-time update for each value from 0 to n-1.";
  const done = makeRequest({id: 'done-request', session_id: ready.id, state: 'running', input: {prompt: 'Write fib(n) in Python.'}, received_at: minutesAgo(11.5)});
  fake.requests.set(done.id, done);
  const pieces = answer.match(/[\s\S]{1,120}/g)!;
  pieces.forEach((piece, i) => fake.emitChunk(done.id, piece, i === pieces.length - 1 ? 188 - 32 * (pieces.length - 1) : 32, true));
  Object.assign(done, {state: 'completed', final_seq: done.contiguous_seq, archive_state: 'saved', ended_at: minutesAgo(11),
    timing: {...done.timing, engine_received_ns: '0', engine_first_output_ns: '1662000000', engine_last_output_ns: '6416000000', engine_first_chunk_tokens: 4},
    statistics: {...done.statistics, accepted_external_tokens: '146'}});

  // A request a program sent through the API: the same answer, with the thinking (up to the first blank lines) apart.
  const [thought, ...rest] = answer.split('\n\n\n');
  const program = makeRequest({id: 'api-request', session_id: ready.id, state: 'running', source: 'api', api_key_id: 'key-editor',
    input: {}, received_at: minutesAgo(6)});
  fake.requests.set(program.id, program);
  fake.emitChunk(program.id, thought, 38, true, 'think');
  fake.emitChunk(program.id, rest.join('\n\n\n'), 150, true, 'answer');
  Object.assign(program, {state: 'completed', final_seq: program.contiguous_seq, archive_state: 'saved', ended_at: minutesAgo(5)});
  for (const key of [
    makeApiKey({id: 'key-editor', name: 'editor plugin', hint: 'oi_Q7xk', created_at: minutesAgo(60 * 24), last_used_at: minutesAgo(6)}),
    makeApiKey({name: 'evaluation scripts', hint: 'oi_m2Pa', created_at: minutesAgo(60 * 3)}),
    makeApiKey({name: 'old laptop', hint: 'oi_9fZc', created_at: minutesAgo(60 * 24 * 9), last_used_at: minutesAgo(60 * 24 * 8), revoked_at: minutesAgo(60 * 24 * 2)}),
  ]) fake.apiKeys.set(key.id, key);

  // A request still streaming on the degraded session, stopped inside a code block.
  const running = makeRequest({id: 'running-request', session_id: degraded.id, state: 'running'});
  fake.requests.set(running.id, running);
  fake.emitChunk(running.id, 'Sure. Here is a quick sort in Python:\n\n```python\ndef quicksort(items):\n    if len(items) <= 1:\n', 32, true);
  fake.emitChunk(running.id, '        return items\n    pivot = items[0]\n', 18, true);
  degraded.active_request_ids = [running.id];

  // A request that failed on the session that ended.
  const failed = makeRequest({id: 'failed-request', session_id: 'ended', state: 'failed', ended_at: minutesAgo(85),
    error: makeError({code: 'http_error', phase: 'serve', device_id: 'mac', message: 'The engine on the server exited during the request; the session was stopped.'})});
  fake.requests.set(failed.id, failed);
  fake.emitChunk(failed.id, 'The answer starts like this and then', 9, true);
  Object.assign(failed, {state: 'failed', final_seq: null});

  const memory = new BrowserMemory('u');
  memory.rememberRequest(ready.id, done.id);
  memory.rememberRequest('ended', failed.id);
  const holder = params.get('reserve');
  if (holder) {
    fake.updateDevice('mac', {state: 'occupied', reservation: {session_id: holder, role: 'service'}});
    fake.updateDevice('helper', {state: 'occupied', reservation: {session_id: holder, role: 'helper'}});
  }
}

// The 21 checks of a plan (control.ts check()), with the messages the backend sent for passed checks.
function check(code: string, passed: boolean, device_id: string | null = null, bytes?: [number, number], message?: string): PreflightCheck {
  return {code, passed, device_id, message: message ?? `Check ${code.replaceAll('_', ' ')} passed.`,
          required_bytes: bytes ? String(Math.round(bytes[0] * GiB)) : null, available_bytes: bytes ? String(Math.round(bytes[1] * GiB)) : null};
}
const failing = params.get('preflight') === 'fail';
const t11Checks: PreflightCheck[] = [
  check('distinct_devices', true),
  ...(['mac', 'helper'] as const).flatMap((d) => [
    check('control_online', true, d),
    check('unsupported_platform', true, d),
    check('hardware_unvalidated', true, d),
    check('version_setup_missing', true, d),
    check('role', true, d),
    check('build_preparation_required', true, d),
    d === 'mac'
      ? check('capacity_insufficient', true, d, [15, 22.5])
      : check('capacity_insufficient', !failing, d, [18.5, failing ? 12.1 : 19.5]),
    d === 'mac' ? check('disk_insufficient', true, d, [15, 109.9]) : check('disk_insufficient', true, d, [13.3, 864.4]),
  ]),
  check('version_compatibility', true),
  check('version_setup_missing', true),
  failing
    ? check('direction_unreachable', false, null, undefined, 'The tested helper-to-service address, port, interpreter, or measurement is no longer valid.')
    : check('direction_unreachable', true),
  check('port_busy', true),
];
fake.preflightResult = () => (stress
  ? {allowed: false, checks: [
      {code: 'platform', passed: true, device_id: null, message: 'Both platforms are supported.', required_bytes: null, available_bytes: null},
      {code: 'room_check', passed: false, device_id: 'helper', message: `Not enough room for ${LONG}`, required_bytes: null, available_bytes: null},
      {code: 'capacity_insufficient', passed: false, device_id: 'helper', message: 'Too small.', required_bytes: '30000000000', available_bytes: '1000000000'},
    ]}
  : {allowed: !failing, checks: params.has('unverified')
      ? [...t11Checks.filter((c) => !(c.code === 'hardware_unvalidated' && c.device_id === 'mac')),
         check('hardware_unverified', true, 'mac', undefined,
               'Apple M3 Pro has not been verified as a serving machine (the verified chip is the Apple M2 Pro); it may serve, and its memory is checked as for any Mac.')]
      : t11Checks});
fake.acceptance = {enabled: true, prompts: [{id: 'p1', label: 'A fixed prompt with a fairly long label for narrow screens', resource_sha256: 'a'.repeat(64), max_output_tokens: 256}]};

Object.assign(window, {fake});
createRoot(document.getElementById('root') as HTMLElement).render(<App />);
