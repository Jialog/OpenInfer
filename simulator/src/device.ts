// Simulated inference devices. A SimulatedDevice connects to the server as a real device does and speaks the device
// protocol of ../../server/src/protocol.ts, whose schemas check every message before it is sent; nothing behind it runs
// a model. Its download and load times, its speeds and the share of tokens a helper writes are settings (devices.json),
// not measurements. A Fleet holds the devices of one simulator process: whether a helper is connected is what the
// serving device reports (peer.status), and with both in one process the serving device knows.
import { createHash, randomBytes, randomUUID } from 'node:crypto';
import { chmod, mkdir, readFile, writeFile } from 'node:fs/promises';
import https from 'node:https';
import { dirname } from 'node:path';
import { WebSocket } from 'ws';
import { z } from 'zod';
import { EMPTY_METRICS, EMPTY_STATS, EMPTY_TIMING, envelope, inventorySchema, messages, parse, parseCommandResult } from '../../server/src/protocol.ts';

type Json = Record<string, any>;

// One device of devices.json. `name` is what the terminal commands call it, `title` the name --seed gives it on the
// website; `inventory` is the protocol's Inventory without its probe number.
const specSchema = z.object({
  name: z.string().regex(/^[a-z0-9][a-z0-9-]*$/),
  title: z.string().min(1).max(80),
  role: z.enum(['service', 'helper']),
  inventory: z.record(z.string(), z.any()),
  download_bytes_per_second: z.number().positive(),
  load_seconds: z.number().nonnegative(),
  // what a connection test from this device measures
  link: z.object({ round_trip_ms: z.number().positive(), megabits_per_second: z.number().positive() }).strict(),
  // a serving device: its speed without a helper, and how long its first token takes
  tokens_per_second_alone: z.number().positive().optional(),
  first_token_seconds: z.number().nonnegative().optional(),
  // a helper: the speed of the serving device while this helper is connected, and the share of the tokens it writes
  tokens_per_second_with_helper: z.number().positive().optional(),
  helper_token_share: z.number().min(0).max(1).optional(),
  // events that happen by themselves, in seconds after the simulator starts
  timeline: z.array(z.object({ at_seconds: z.number().nonnegative(), event: z.enum(['leave', 'join', 'fail']) }).strict()).optional(),
}).strict().refine((s) => s.role === 'service'
  ? s.tokens_per_second_alone !== undefined && s.first_token_seconds !== undefined
  : s.tokens_per_second_with_helper !== undefined && s.helper_token_share !== undefined, 'a serving device names its speed alone and its first-token time; a helper its speed with the helper and its share');
export type Spec = z.infer<typeof specSchema>;
export type Answer = { think: string; answer: string };

export async function readDevices(path: string | URL): Promise<Spec[]> {
  const specs = z.array(specSchema).min(1).parse(JSON.parse(await readFile(path, 'utf8')));
  if (new Set(specs.map((s) => s.name)).size !== specs.length) throw new Error('Two simulated devices have the same name');
  for (const spec of specs) parse(inventorySchema, { ...spec.inventory, sequence: 1 });
  return specs;
}
/** The text every request streams: the thinking before the line `</think>`, the answer after it. */
export async function readAnswer(path: string | URL): Promise<Answer> {
  const [think, answer] = (await readFile(path, 'utf8')).split('\n</think>\n');
  if (answer === undefined) throw new Error('The answer text has no </think> line');
  return { think: think.trim(), answer: answer.trim() };
}
/** The simulator's tokens: each word with the white space after it. */
export const tokens = (text: string): string[] => text.trimStart().match(/\S+\s*/g) ?? [];

const sha256 = (text: string) => createHash('sha256').update(text).digest('hex');
const sleep = (ms: number, signal?: AbortSignal) => new Promise<void>((resolve, reject) => {
  if (signal?.aborted) { reject(signal.reason); return; }
  const timer = setTimeout(() => { signal?.removeEventListener('abort', stop); resolve(); }, ms);
  const stop = () => { clearTimeout(timer); reject(signal!.reason); };
  signal?.addEventListener('abort', stop, { once: true });
});
const failure = (code: string, message: string, device_id: string | null, phase: string | null) => ({ code, message, field: null, device_id, phase, retryable: false });

/** One HTTPS call to the server, trusting only its certificate CA. */
export function request(url: string, ca: Buffer, path: string, method: string, body?: unknown, headers: Record<string, string> = {}): Promise<{ status: number; headers: Json; body: any }> {
  const bytes = body === undefined ? undefined : Buffer.from(JSON.stringify(body));
  return new Promise((resolve, reject) => {
    const call = https.request(new URL(path, url), { method, ca, headers: { ...(bytes ? { 'content-type': 'application/json', 'content-length': String(bytes.length) } : {}), ...headers } }, (response) => {
      const chunks: Buffer[] = [];
      response.on('data', (chunk: Buffer) => chunks.push(chunk));
      response.on('end', () => { const text = Buffer.concat(chunks).toString('utf8'); let value: any = null; try { value = text ? JSON.parse(text) : null; } catch { value = text; } resolve({ status: response.statusCode ?? 0, headers: response.headers, body: value }); });
    });
    call.on('error', reject);
    if (bytes) call.write(bytes);
    call.end();
  });
}

type Ref = { instance_id: string; session_id: string; generation: number; config_sha256: string };
type Command = { wire: Json; state: 'executing' | 'completed' | 'failed' | 'cancelled'; result: Json | null; error: Json | null; recorded: boolean };
// A writer as the serving instance's table counts it: the helper instance of that id, its connection and whether the
// server has been told its current state.
type Writer = { generation: number; connection: string; up: boolean; told: boolean };
type Instance = { ref: Ref; role: 'service' | 'helper'; state: 'loading' | 'connectable' | 'ready' | 'failed'; phase: string; error: Json | null;
  hasHelpers: boolean; writers: Map<string, Writer>; peer: string | null; dialed: boolean };
// A request the engine ran, kept whole until the server says its result is saved: what a reconnect replays.
type Running = { instance: Instance; accepted: Json; chunks: Json[]; end: Json | null; abort: AbortController; done: Promise<void> };

export class SimulatedDevice {
  id: string | null = null;
  credential: string | null = null;
  readonly boot = randomUUID();
  /** Reconciled on its current connection: it may send. */
  online = false;
  /** Off the network on purpose (the `leave` command). */
  away = false;
  readonly instances = new Map<string, Instance>();
  private socket: WebSocket | null = null;
  private connectionId = '';
  private heartbeat: ReturnType<typeof setInterval> | undefined;
  private retry: ReturnType<typeof setTimeout> | undefined;
  private waiters: (() => void)[] = [];
  private sequence = 0;
  private closed = false;
  private readonly prepared = new Map<string, Json>();
  // what stops the tasks of an instance (its prepare, its start, its requests), by instance id: 'stop' or 'fail'
  private readonly aborts = new Map<string, AbortController>();
  private readonly commands = new Map<string, Command>();
  private reconciling: Command[] = [];
  private readonly listens = new Map<string, Command>();
  private readonly requests = new Map<string, Running>();

  constructor(readonly spec: Spec, private readonly fleet: Fleet) {}

  private log(line: string) { this.fleet.log(`${this.spec.name}: ${line}`); }
  private signal(instanceId: string): AbortSignal {
    if (!this.aborts.has(instanceId)) this.aborts.set(instanceId, new AbortController());
    return this.aborts.get(instanceId)!.signal;
  }
  private halt(instanceId: string, reason: 'stop' | 'fail') { this.aborts.get(instanceId)?.abort(reason); this.aborts.delete(instanceId); }
  /** A new probe of the hardware: the described inventory, the versions prepared since, the next probe number. */
  inventory(): Json { return { ...this.spec.inventory, prepared_versions: [...this.prepared.values()], sequence: ++this.sequence }; }

  // --- the connection: hello, reconcile, heartbeats; a lost connection is opened again unless the device left

  /** Resolves once the server has reconciled this device on a new connection. */
  connect(): Promise<void> {
    if (this.online) return Promise.resolve();
    const ready = new Promise<void>((resolve) => this.waiters.push(resolve));
    this.open();
    return ready;
  }
  private open() {
    if (this.closed || this.away || !this.id || this.socket) return;
    const socket = new WebSocket(`${this.fleet.options.url.replace(/^http/, 'ws')}/api/v1/ws/device`, 'openinfer.device.v1',
      { ca: this.fleet.options.ca, headers: { authorization: `Bearer ${this.credential}`, 'x-openinfer-device-id': this.id } });
    this.socket = socket;
    socket.on('message', (bytes) => { try { this.receive(JSON.parse(bytes.toString())); } catch (error) { this.log(`could not handle a message: ${(error as Error).message}`); } });
    socket.on('unexpected-response', (_request, response) => {
      if (response.statusCode === 401) { this.log('the server no longer knows this device; enrol it again'); this.fleet.forget(this); }
      socket.terminate();
    });
    socket.on('error', () => {});
    socket.on('close', () => {
      if (this.socket !== socket) return;
      if (this.online) this.log('lost its connection to the server; trying again');
      this.socket = null; this.online = false; clearInterval(this.heartbeat);
      if (!this.closed && !this.away && this.id) this.retry = setTimeout(() => this.open(), 1000);
    });
  }
  private receive(message: Json) {
    const payload = message.payload ?? {};
    if (message.type === 'hello') {
      this.connectionId = payload.connection_id;
      this.reconciling = [...this.commands.values()].filter((c) => !c.recorded && c.state !== 'executing');
      this.transmit('reconcile', { agent_boot_id: this.boot, inventory: this.inventory(), instances: this.reports(),
        commands: [...this.commands.values()].filter((c) => !c.recorded).map((c) => ({ command_id: c.wire.command_id, state: c.state, result: c.state === 'completed' ? c.result : null, error: c.error })),
        requests: [...this.requests.entries()].map(([request_id, r]) => ({ request_id, instance_id: r.instance.ref.instance_id, http_stream_alive: !r.end,
          local_contiguous_seq: String(r.chunks.length), local_final_seq: r.end ? r.end.final_seq : null, complete_buffer: true, end: r.end })) });
    } else if (message.type === 'reconciled') {
      this.online = true;
      this.log('connected');
      clearInterval(this.heartbeat);
      this.heartbeat = setInterval(() => this.send('heartbeat', { agent_boot_id: this.boot, inventory: this.inventory(), instances: this.reports() }), this.fleet.options.heartbeatMs ?? 10_000);
      // the reconcile carried the results the server had not confirmed, and the server has applied them
      for (const reported of this.reconciling.splice(0)) reported.recorded = true;
      for (const kept of payload.requests ?? []) if (kept.terminal && !kept.retain_local) this.requests.delete(kept.request_id);
      for (const wire of payload.commands ?? []) this.command(wire);
      this.fleet.sync();
      for (const resolve of this.waiters.splice(0)) resolve();
    } else if (message.type === 'command') this.command(payload);
    else if (message.type === 'recorded') { if (payload.kind === 'command.result') { const known = this.commands.get(payload.resource_id); if (known && known.state !== 'executing') known.recorded = true; } }
    else if (message.type === 'output.replay') this.replay(payload.request_id, BigInt(payload.after_seq));
    else if (message.type === 'request.recorded' || message.type === 'request.retained') this.requests.delete(payload.request_id);
    else if (message.type === 'error') this.log(`the server refused a message: ${payload.error?.code} ${payload.error?.message ?? ''}`);
  }
  /** Sends one protocol message if the device is reconciled; what it could not send, the next reconcile reports. */
  send(type: string, payload: Json): boolean { return this.online && this.transmit(type, payload); }
  private transmit(type: string, payload: Json): boolean {
    try { parse(messages[type], payload); } catch (error) { throw new Error(`The simulator built a ${type} message the protocol refuses, at ${(error as Json).field ?? 'its top level'}`); }
    if (!this.socket || this.socket.readyState !== WebSocket.OPEN) return false;
    this.socket.send(JSON.stringify(parse(envelope, { v: 1, type, message_id: randomUUID(), connection_id: this.connectionId, device_id: this.id, sent_at: new Date().toISOString(), payload })));
    return true;
  }

  // --- the terminal's events

  /** The device drops off the network: its control connection and its connections to its peers close; its engines keep running. */
  leave() {
    this.away = true; this.online = false;
    clearTimeout(this.retry); clearInterval(this.heartbeat);
    this.socket?.terminate(); this.socket = null;
    this.fleet.hangUp(this);
    this.log('left the network');
  }
  join(): Promise<void> { this.away = false; return this.connect(); }
  /** The engine process of the device's newest instance exits. */
  fail() {
    const instance = [...this.instances.values()].filter((i) => i.state !== 'failed').at(-1);
    if (!instance) { this.log('has no running instance to fail'); return; }
    instance.error = failure('process_exit', 'The simulated engine process exited.', this.id, instance.phase);
    instance.state = 'failed'; instance.dialed = false;
    this.halt(instance.ref.instance_id, 'fail');
    this.log('its engine process exited');
    this.send('instance.status', this.report(instance));
    this.fleet.sync();
  }
  close() { this.closed = true; clearTimeout(this.retry); clearInterval(this.heartbeat); for (const id of [...this.aborts.keys()]) this.halt(id, 'fail'); this.socket?.terminate(); }

  // --- instances

  private report(instance: Instance): Json {
    const up = instance.state === 'connectable' || instance.state === 'ready', serving = up && instance.role === 'service';
    return { ...instance.ref, agent_boot_id: this.boot, state: instance.state, phase: instance.phase, processes: [], http_healthy: serving, push_listening: serving, calibrated: up,
      inventory_after: null, metrics: { ...EMPTY_METRICS, load_seconds: up ? this.spec.load_seconds : null }, error: instance.error };
  }
  private reports(): Json[] { return [...this.instances.values()].map((i) => this.report(i)); }
  /** The report of an instance that no longer runs here; the inventory probed after its end has the number PROBE. */
  private stopped(ref: Ref, probe: number): Json {
    return { ...ref, agent_boot_id: this.boot, state: 'stopped', phase: 'kill', processes: [], http_healthy: false, push_listening: false, calibrated: false,
      inventory_after: probe, metrics: EMPTY_METRICS, error: null };
  }
  /** The speed of a serving instance now, and the share of its tokens a helper writes: a connected helper's, else its own. */
  private pace(instance: Instance): { rate: number; share: number } {
    const helper = [...instance.writers].filter(([, writer]) => writer.up).map(([id]) => this.fleet.holder(id)?.spec).find((spec) => spec);
    return helper ? { rate: helper.tokens_per_second_with_helper!, share: helper.helper_token_share! } : { rate: this.spec.tokens_per_second_alone ?? 1, share: 0 };
  }

  // --- commands: acknowledged, run, answered once; a command sent again is acknowledged again

  private command(wire: Json) {
    const known = this.commands.get(wire.command_id);
    if (known) { this.send('command.ack', { command_id: wire.command_id, state: known.state }); if (known.state !== 'executing' && !known.recorded) this.result(known); return; }
    const command: Command = { wire, state: 'executing', result: null, error: null, recorded: false };
    this.commands.set(wire.command_id, command);
    this.send('command.ack', { command_id: wire.command_id, state: 'executing' });
    this.log(wire.kind);
    void this.run(command).then((result) => { if (result) this.finish(command, 'completed', result); this.fleet.sync(); }, (error) => {
      // a task stopped because its instance was stopped or failed has no answer: the stop or the failure is the report
      if (error === 'stop' || error === 'fail') { command.state = 'cancelled'; command.recorded = true; return; }
      this.finish(command, 'failed', {}, failure('simulator_error', String((error as Error)?.message ?? error).slice(0, 500), this.id, wire.phase ?? null));
    });
  }
  private finish(command: Command, state: 'completed' | 'failed', result: Json, error: Json | null = null) {
    if (command.state !== 'executing') return;
    parseCommandResult(command.wire.kind, state, result);
    command.state = state; command.result = result; command.error = error;
    this.result(command);
  }
  private result(command: Command) { this.send('command.result', { command_id: command.wire.command_id, outcome: command.state, result: command.result ?? {}, error: command.error }); }
  private progress(command: Command, phase: string, completed: bigint | null, total: bigint | null, message: string) {
    this.send('command.progress', { command_id: command.wire.command_id, phase, completed_bytes: completed?.toString() ?? null, total_bytes: total?.toString() ?? null, message });
  }
  /** Runs one command to its result; null when the result is sent later (a test listener answers when it is closed). */
  private async run(command: Command): Promise<Json | null> {
    const wire = command.wire, payload = wire.payload;
    switch (wire.kind) {
      case 'listen_test':
        this.listens.set(wire.connection_test_id, command);
        this.send('test.listening', { command_id: wire.command_id, test_id: wire.connection_test_id, bound_addresses: payload.target_addresses, port: payload.port, python: payload.python });
        return null;
      case 'connect_test': {
        const { round_trip_ms, megabits_per_second } = this.spec.link;
        this.send('test.result', { command_id: wire.command_id, test_id: wire.connection_test_id, source_address: this.spec.inventory.addresses[0].address, target_address: payload.target_addresses[0],
          port: payload.port, nonce_matched: true, rtt_samples_ms: Array.from({ length: 10 }, (_, i) => Number((round_trip_ms * (0.9 + 0.02 * i)).toFixed(3))),
          transfer_bytes: String(payload.transfer_bytes), transfer_ms: Number((payload.transfer_bytes * 8 / (megabits_per_second * 1000)).toFixed(1)), error: null });
        return { test_id: wire.connection_test_id, listener_closed: false };
      }
      case 'close_test': {
        const listening = this.listens.get(wire.connection_test_id);
        this.listens.delete(wire.connection_test_id);
        this.finish(command, 'completed', { test_id: wire.connection_test_id, listener_closed: true });
        if (listening) this.finish(listening, 'completed', { test_id: wire.connection_test_id, listener_closed: true });
        return null;
      }
      case 'prepare': return this.prepare(command);
      case 'start_service': case 'start_helper': return this.start(command);
      case 'warmup': {
        const instance = this.live(wire.instance_id);
        this.progress(command, 'warmup', null, null, 'Running the warm-up request (simulated)');
        await sleep(256 / this.pace(instance).rate * 1000, this.signal(wire.instance_id));
        instance.state = 'ready'; instance.phase = 'serve';
        return { resource_sha256: payload.resource_sha256, output_tokens: '256', timing: EMPTY_TIMING };
      }
      case 'run_request': return this.serve(command);
      case 'cancel_request': {
        const running = this.requests.get(wire.request_id);
        if (running && !running.end) { running.abort.abort('cancel'); await running.done; }
        return { request_id: wire.request_id, released: true };
      }
      case 'stop': case 'recheck': {
        const refs: Ref[] = wire.instance_refs, probe = this.sequence + 1, reports: Json[] = [];
        for (const ref of refs) {
          const instance = this.instances.get(ref.instance_id);
          if (instance && wire.kind === 'recheck') { reports.push(this.report(instance)); continue; }
          // a request still running on a stopped instance ends as cancelled, before the stop is answered
          this.halt(ref.instance_id, 'stop');
          if (instance) await Promise.all([...this.requests.values()].filter((r) => r.instance === instance).map((r) => r.done));
          this.instances.delete(ref.instance_id);
          reports.push(this.stopped(ref, probe));
        }
        return { instances: reports, ports_free: true, inventory: this.inventory() };
      }
      default: throw new Error(`The simulator does not know the command ${wire.kind}`);
    }
  }
  private live(instanceId: string): Instance {
    const instance = this.instances.get(instanceId);
    if (!instance || instance.state === 'failed') throw new Error('This instance is not running on the simulated device');
    return instance;
  }

  /** prepare: the simulated download of the version's files (skipped when this device has them), then verified. */
  private async prepare(command: Command): Promise<Json> {
    const version = command.wire.payload.version, signal = this.signal(command.wire.instance_id);
    const files: Json[] = [...version.files, ...(version.draft_model?.files ?? []), ...(version.tokenizer?.files ?? [])];
    const total = files.reduce((sum, file) => sum + BigInt(file.size_bytes), 0n);
    if (!this.prepared.has(version.id)) {
      const started = Date.now();
      this.progress(command, 'download', 0n, total, `Downloading ${version.repo} (simulated)`);
      for (let done = 0n; done < total;) {
        await sleep(200, signal);
        const reached = BigInt(Math.floor((Date.now() - started) / 1000 * this.spec.download_bytes_per_second));
        done = reached < total ? reached : total;
        this.progress(command, 'download', done, total, `Downloading ${version.repo} (simulated)`);
      }
      this.prepared.set(version.id, { version_id: version.id, manifest_sha256: version.manifest_sha256, verified_at: new Date().toISOString() });
    }
    this.progress(command, 'verify', null, null, 'Files verified (simulated)');
    const want = version.build_requirements;
    return { manifest_sha256: version.manifest_sha256, prepared_version_id: version.id,
      build: { source_revision: want.source_revision, bridge_revision: want.bridge_revision, compiler: 'simulated', cuda: null, options: { ...want.options }, binary_sha256: sha256('simulated engine'), libraries: [] } };
  }

  /** start_service, start_helper: the instance loads for load_seconds; a helper then dials the serving instance it was given. */
  private async start(command: Command): Promise<Json> {
    const wire = command.wire, role = wire.kind === 'start_service' ? 'service' as const : 'helper' as const;
    const ref: Ref = wire.instance_refs.find((r: Ref) => r.instance_id === wire.instance_id);
    const instance: Instance = { ref, role, state: 'loading', phase: 'load', error: null, hasHelpers: role === 'service' && wire.payload.peer.device_id !== null,
      writers: new Map(), peer: role === 'helper' ? wire.payload.peer.instance_id : null, dialed: false };
    this.instances.set(ref.instance_id, instance);
    this.progress(command, 'load', null, null, 'Loading the model (simulated)');
    await sleep(this.spec.load_seconds * 1000, this.signal(ref.instance_id));
    instance.state = 'connectable'; instance.phase = 'connect'; instance.dialed = role === 'helper';
    return { instance: this.report(instance) };
  }

  /** run_request: the fixed text, in chunks at the instance's speed, each kept until the server has saved the result. */
  private async serve(command: Command): Promise<Json> {
    const wire = command.wire, payload = wire.payload, instance = this.live(wire.instance_id), ids = { request_id: wire.request_id, instance_id: wire.instance_id };
    const prompt: string = payload.input.kind === 'text' ? payload.input.prompt : payload.input.kind === 'chat' ? payload.input.messages.at(-1).content : '';
    const promptTokens = payload.input.kind === 'acceptance' ? payload.input.token_ids.length : Math.max(1, tokens(prompt).length);
    const room = payload.context_length - promptTokens, asked: number | null = payload.max_output_tokens;
    const budget = asked === null ? room : payload.cap_max_output ? Math.min(asked, room) : asked;
    const clock = () => process.hrtime.bigint().toString(), startedAt = new Date().toISOString();
    const timing: Json = { ...EMPTY_TIMING, clock_id: wire.instance_id, engine_received_ns: clock(), engine_started_at: startedAt };
    if (budget < 1 || budget > room) {
      this.send('request.end', { ...ids, final_seq: '0', outcome: 'failed', reason: 'error', released: true, prompt_tokens: null, output_tokens: '0', timing: EMPTY_TIMING, statistics: EMPTY_STATS,
        error: failure('context_budget_exceeded', `prompt has ${promptTokens} tokens; output must fit remaining ${Math.max(room, 0)} of ${payload.context_length}`, null, 'serve') });
      return { request_id: wire.request_id, final_seq: '0' };
    }
    const fill = (text: string) => text.replaceAll('{prompt_tokens}', String(promptTokens)).replaceAll('{prompt_start}', prompt.trim().split('\n')[0].slice(0, 80));
    const think = tokens(fill(this.fleet.options.answer.think)), answer = tokens(fill(this.fleet.options.answer.answer));
    const all = [...think.map((text) => ({ text, segment: 'think' })), ...answer.map((text) => ({ text, segment: 'answer' }))].slice(0, budget);
    const accepted = { ...ids, prompt_tokens: promptTokens, effective_max_output: budget, committed_position: String(promptTokens), timing };
    // the request stops with its instance ('stop', 'fail') or by itself ('cancel')
    const abort = new AbortController(), instanceSignal = this.signal(wire.instance_id), withInstance = () => abort.abort(instanceSignal.reason);
    instanceSignal.addEventListener('abort', withInstance, { once: true });
    const running: Running = { instance, accepted, chunks: [], end: null, abort, done: Promise.resolve() };
    this.requests.set(wire.request_id, running);
    this.send('request.accepted', accepted);
    let emitted = 0, helped = 0, firstNs: string | null = null, firstTokens: number | null = null, lastNs: string | null = null;
    const stream = async () => {
      await sleep(this.spec.first_token_seconds! * 1000, abort.signal);
      // `due` is how many tokens the speed allows by now; a chunk holds at most 32 tokens of one segment
      for (let due = 1, last = performance.now(); emitted < all.length;) {
        while (due >= 1 && emitted < all.length) {
          const segment = all[emitted].segment;
          let count = 0;
          while (count < Math.min(Math.floor(due), 32) && emitted + count < all.length && all[emitted + count].segment === segment) count += 1;
          const text = all.slice(emitted, emitted + count).map((t) => t.text).join('');
          emitted += count; due -= count; lastNs = clock(); firstNs ??= lastNs; firstTokens ??= count;
          helped += count * this.pace(instance).share;
          const chunk = { ...ids, seq: String(running.chunks.length + 1), text, token_count: count, committed_position: String(promptTokens + emitted), segment,
            engine_first_output_ns: firstNs, engine_last_output_ns: lastNs, engine_first_chunk_tokens: firstTokens };
          running.chunks.push(chunk);
          this.send('output.chunk', chunk);
        }
        if (emitted < all.length) { await sleep(50, abort.signal); const now = performance.now(); due += this.pace(instance).rate * (now - last) / 1000; last = now; }
      }
    };
    running.done = (async () => {
      let outcome: 'completed' | 'cancelled' = 'completed';
      try { await stream(); } catch (reason) {
        // an engine that died says nothing more; a stopped or cancelled request ends as cancelled
        if (reason === 'fail') { this.requests.delete(wire.request_id); return; }
        if (reason !== 'stop' && reason !== 'cancel') throw reason;
        outcome = 'cancelled';
      } finally { instanceSignal.removeEventListener('abort', withInstance); }
      running.end = { ...ids, final_seq: String(running.chunks.length), outcome, reason: outcome === 'cancelled' ? 'cancelled' : all.length < think.length + answer.length ? 'length' : 'eos',
        released: true, prompt_tokens: promptTokens, output_tokens: String(emitted),
        timing: { ...timing, engine_first_output_ns: firstNs, engine_last_output_ns: lastNs, engine_first_chunk_tokens: firstTokens, engine_finished_ns: clock(), engine_finished_at: new Date().toISOString() },
        statistics: { ...EMPTY_STATS, accepted_external_tokens: instance.hasHelpers ? String(Math.round(helped)) : null, think_end_position: emitted >= think.length ? String(promptTokens + think.length) : null }, error: null };
      this.send('request.end', running.end);
    })();
    await running.done;
    if (!running.end) throw 'fail';
    return { request_id: wire.request_id, final_seq: running.end.final_seq };
  }
  /** output.replay: the chunks after AFTER again, as the server asks when it missed some (a reconnect). */
  private replay(requestId: string, after: bigint) {
    const running = this.requests.get(requestId);
    if (!running) return;
    this.send('request.accepted', running.accepted);
    for (const chunk of running.chunks) if (BigInt(chunk.seq) > after) this.send('output.chunk', chunk);
  }
}

export const HELP = [
  'enroll <device> <token>   enrol a device with a token from "Add a device" on the website',
  'leave <device>            the device drops off the network',
  'join <device>             the device comes back',
  'fail <device>             the engine process on the device exits',
  'list                      the devices and what they run',
  'quit                      stop the simulator',
].join('\n');

export type FleetOptions = { url: string; ca: Buffer; answer: Answer; statePath?: string; heartbeatMs?: number; log?: (line: string) => void };

export class Fleet {
  readonly devices = new Map<string, SimulatedDevice>();
  constructor(specs: Spec[], readonly options: FleetOptions) { for (const spec of specs) this.devices.set(spec.name, new SimulatedDevice(spec, this)); }
  log(line: string) { this.options.log?.(line); }
  device(name: string): SimulatedDevice { const device = this.devices.get(name); if (!device) throw new Error(`No simulated device is called ${name}; there ${this.devices.size === 1 ? 'is' : 'are'} ${[...this.devices.keys()].join(', ')}`); return device; }

  /** Connects the devices enrolled in an earlier run (the saved device ids and credentials). */
  async start() {
    if (!this.options.statePath) return;
    const saved: Json = await readFile(this.options.statePath, 'utf8').then(JSON.parse, () => ({}));
    for (const [name, identity] of Object.entries<Json>(saved.devices ?? {})) { const device = this.devices.get(name); if (device) { device.id = identity.id; device.credential = identity.credential; void device.connect(); } }
  }
  private async save() {
    if (!this.options.statePath) return;
    const devices = Object.fromEntries([...this.devices].filter(([, d]) => d.id).map(([name, d]) => [name, { id: d.id, credential: d.credential }]));
    await mkdir(dirname(this.options.statePath), { recursive: true });
    await writeFile(this.options.statePath, JSON.stringify({ devices }, null, 2) + '\n', { mode: 0o600 });
    await chmod(this.options.statePath, 0o600);
  }
  forget(device: SimulatedDevice) { device.id = null; device.credential = null; void this.save(); }

  /** Enrols the device NAME with a token of the website's "Add a device" and connects it; returns its device id. */
  async enroll(name: string, token: string): Promise<string> {
    const device = this.device(name);
    if (device.id) throw new Error(`${name} is already enrolled`);
    const credential = randomBytes(32).toString('base64url');
    const reply = await request(this.options.url, this.options.ca, '/api/v1/device/enroll', 'POST', { enrollment_token: token.trim(), credential, agent_boot_id: device.boot, inventory: device.inventory() });
    if (reply.status !== 201) throw new Error(`The server refused the enrollment of ${name}: ${reply.body?.error?.message ?? reply.status}`);
    device.id = reply.body.device_id; device.credential = credential;
    await this.save();
    await device.connect();
    return reply.body.device_id;
  }
  /** --seed: a new account EMAIL with a password made here, and every device not yet enrolled added to it under its
   *  title. Returns what to print: the account and its password, which is kept nowhere. */
  async seed(email: string): Promise<string> {
    const missing = [...this.devices.values()].filter((d) => !d.id);
    if (!missing.length) return '';
    const { url, ca } = this.options, origin = new URL(url).origin, password = randomBytes(15).toString('base64url');
    const account = await request(url, ca, '/api/v1/auth/register', 'POST', { email, password }, { origin });
    if (account.status === 409) return `The account ${email} exists already, and this simulator has no saved devices for it. Sign in on the website and add each device with a token (enroll <device> <token>), or delete the data directory to start again.`;
    if (account.status !== 201) throw new Error(`The server refused the demo account: ${account.body?.error?.message ?? account.status}`);
    const signedIn = { origin, cookie: String(account.headers['set-cookie'][0]).split(';', 1)[0], 'x-csrf-token': account.body.csrf_token };
    for (const device of missing) {
      const enrollment = await request(url, ca, '/api/v1/enrollment-tokens', 'POST', { device_name: device.spec.title }, signedIn);
      if (enrollment.status !== 201) throw new Error(`The server gave no token for ${device.spec.name}: ${enrollment.body?.error?.message ?? enrollment.status}`);
      await this.enroll(device.spec.name, enrollment.body.token);
    }
    return `Demo account (its password is shown only now): ${email}  password: ${password}`;
  }
  /** One line typed in the simulator's terminal; returns what to print. */
  async command(line: string): Promise<string> {
    const [verb, name, token] = line.trim().split(/\s+/);
    try {
      switch (verb) {
        case 'enroll': if (!name || !token) return 'Usage: enroll <device> <token>'; await this.enroll(name, token); return `${name} is enrolled and connected.`;
        case 'leave': this.device(name).leave(); return '';
        case 'join': await this.device(name).join(); return '';
        case 'fail': this.device(name).fail(); return '';
        case 'list': return this.list();
        case 'help': case '': return HELP;
        default: return `Unknown command "${verb}".\n${HELP}`;
      }
    } catch (error) { return (error as Error).message; }
  }
  /** The devices, one a line: name, role, whether enrolled and connected, what it runs. */
  list(): string {
    return [...this.devices.values()].map((d) => [d.spec.name.padEnd(8), (d.spec.role === 'service' ? 'serving device' : 'helper').padEnd(15),
      (!d.id ? 'not enrolled' : d.away ? 'enrolled, left the network' : d.online ? 'enrolled, connected' : 'enrolled, connecting').padEnd(27),
      [...d.instances.values()].map((i) => `${i.role === 'service' ? 'serving' : 'helping'} (${i.state})`).join(', ') || 'no instance'].join(' ')).join('\n');
  }
  close() { for (const device of this.devices.values()) device.close(); }

  /** The device that runs the instance of this id. */
  holder(instanceId: string): SimulatedDevice | undefined { return [...this.devices.values()].find((d) => d.instances.has(instanceId)); }
  /** A device that left closes its connections to its peers: its helpers', and those of the helpers of its serving instances. A simulated helper does not dial again; the website's "Reconnect helper" replaces it. */
  hangUp(device: SimulatedDevice) {
    for (const other of this.devices.values()) for (const instance of other.instances.values())
      if (instance.role === 'helper' && (other === device || device.instances.has(instance.peer!))) instance.dialed = false;
    this.sync();
  }
  /** Brings what each serving instance reports about its writers in line with the helpers that are connected to it now. */
  sync() {
    for (const device of this.devices.values()) for (const service of device.instances.values()) {
      if (service.role !== 'service') continue;
      if (service.state === 'failed') { service.writers.clear(); continue; }
      const dialing = [...this.devices.values()].flatMap((d) => [...d.instances.values()]).filter((i) => i.role === 'helper' && i.peer === service.ref.instance_id);
      for (const id of new Set([...service.writers.keys(), ...dialing.map((i) => i.ref.instance_id)])) {
        const helper = dialing.find((i) => i.ref.instance_id === id), holder = this.holder(id);
        const want = !!helper && helper.dialed && (helper.state === 'connectable' || helper.state === 'ready') && !holder!.away && !device.away && service.state !== 'loading';
        const writer = service.writers.get(id) ?? { generation: 0, connection: randomUUID(), up: false, told: true };
        if (want !== writer.up) { if (want) { writer.generation += 1; writer.connection = randomUUID(); helper!.state = 'ready'; helper!.phase = 'serve'; } writer.up = want; writer.told = false; }
        if (!writer.told) writer.told = device.send('peer.status', { session_id: service.ref.session_id, instance_id: service.ref.instance_id, writer_id: id, connection_generation: writer.generation,
          push_connection_id: writer.connection, state: writer.up ? 'connected' : 'disconnected', authenticated: true,
          error: writer.up ? null : failure('peer_disconnected', 'The helper closed its connection.', device.id, 'connect') });
        service.writers.set(id, writer);
      }
    }
  }
}
