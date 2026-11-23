// A browser-side stand-in for the server, written from its API (docs/API.md): REST through fetch,
// WebSocket through a fake class, plus driver methods that play the part of the devices.
import type {
  ApiErrorBody,
  ApiKey,
  Catalog,
  Chunk,
  ConnectionTest,
  Device,
  Enrollment,
  ID,
  Identity,
  Instance,
  Preflight,
  Request,
  Session,
  SessionPlan,
  Snapshot,
  TestPlan,
  WsMessage,
} from '@/api/types';
import {emptyTiming, makeCatalog, makeDevice, makeEnrollment, makeInstance, makeRequest, makeSession, makeTest, uuid} from './factories';

type Call = {method: string; path: string; query: string; headers: Record<string, string>; body: unknown};
type Held = {release: () => void};

const TERMINAL_SESSION = new Set(['ended', 'failed']);
const TERMINAL_REQUEST = new Set(['completed', 'failed', 'cancelled']);
const ACTIVE_TEST = new Set(['listening', 'testing']);

function err(code: string, message: string, patch: Partial<ApiErrorBody> = {}): ApiErrorBody {
  return {code, message, field: null, device_id: null, phase: null, retryable: false, ...patch};
}
class HttpError extends Error {
  constructor(public status: number, public body: ApiErrorBody) {
    super(body.message);
  }
}
function assertKeys(body: unknown, required: string[], optional: string[] = []) {
  const obj = (body ?? {}) as Record<string, unknown>;
  for (const key of Object.keys(obj)) {
    if (!required.includes(key) && !optional.includes(key)) throw new HttpError(400, err('invalid_input', `Unknown field ${key}.`, {field: key}));
  }
  for (const key of required) {
    if (!(key in obj)) throw new HttpError(400, err('invalid_input', `Missing field ${key}.`, {field: key}));
  }
}

export class FakeSocket {
  static CONNECTING = 0;
  static OPEN = 1;
  static CLOSING = 2;
  static CLOSED = 3;
  readyState = FakeSocket.CONNECTING;
  onopen: ((e: unknown) => void) | null = null;
  onmessage: ((e: {data: string}) => void) | null = null;
  onclose: ((e: {code: number}) => void) | null = null;
  onerror: ((e: unknown) => void) | null = null;
  connectionId = uuid();
  seq = 0;

  constructor(public backend: FakeBackend, public url: string, public protocol: string | string[] | undefined) {
    backend.sockets.push(this);
    if (!backend.withholdSnapshot) queueMicrotask(() => backend.accept(this));
  }
  send(): void {
    throw new Error('The browser never sends business messages (docs/API.md).');
  }
  close(code = 1000): void {
    this.drop(code);
  }
  drop(code: number): void {
    if (this.readyState === FakeSocket.CLOSED) return;
    this.readyState = FakeSocket.CLOSED;
    this.onclose?.({code});
  }
  deliver(type: string, payload: unknown): void {
    if (this.readyState !== FakeSocket.OPEN) return;
    const message = {v: 1, type, connection_id: this.connectionId, seq: String(this.seq++), at: new Date().toISOString(), payload};
    this.onmessage?.({data: JSON.stringify(message)});
  }
}

export class FakeBackend {
  accounts = new Map<string, {password: string; identity: Identity}>();
  loggedIn: Identity | null = null;
  devices = new Map<ID, Device>();
  enrollments = new Map<ID, Enrollment>();
  tests = new Map<ID, ConnectionTest>();
  sessions = new Map<ID, Session>();
  requests = new Map<ID, Request>();
  /** Where the server says it keeps files and results. */
  storage: 'bucket' | 'memory' = 'bucket';
  /** Uploaded prompt files, with their text. */
  files = new Map<ID, {id: ID; name: string; content_type: string; size_bytes: number; sha256: string; created_at: string; text: string}>();
  chunks = new Map<ID, Chunk[]>();
  apiKeys = new Map<ID, ApiKey>();
  /** The plaintext of the last key generated; the real server keeps only its hash. */
  lastSecret: string | null = null;
  sockets: FakeSocket[] = [];
  calls: Call[] = [];
  withholdSnapshot = false;
  /** The certificate file the control plane loaded, as GET /api-keys names it. */
  certificatePath: string | null = '~/openinfer/tls.crt';
  /** The control plane runs with OPENINFER_REGISTRATION=closed. */
  registrationClosed = false;
  catalog: Catalog = makeCatalog();
  /** The helper version the fake's Placement chooses when a preflight leaves it to Placement (null: none fits). */
  placementChoice: string | null = 'helper-v1';
  acceptance: {enabled: boolean; prompts: {id: string; label: string; resource_sha256: string; max_output_tokens: number}[]} = {enabled: false, prompts: []};
  preflightResult: ((plan: Session['plan']) => Partial<Preflight>) | null = null;
  private overrides: {route: string; respond: () => Response | never}[] = [];
  private holds: {route: string; wait: Promise<void>}[] = [];
  private responseHolds: {route: string; wait: Promise<void>}[] = [];

  private previousFetch = globalThis.fetch;
  private previousSocket = globalThis.WebSocket;

  install(): void {
    globalThis.fetch = this.fetch as typeof fetch;
    const backend = this;
    globalThis.WebSocket = class extends FakeSocket {
      constructor(url: string, protocol?: string | string[]) {
        super(backend, url, protocol);
      }
    } as unknown as typeof WebSocket;
  }
  uninstall(): void {
    globalThis.fetch = this.previousFetch;
    globalThis.WebSocket = this.previousSocket;
  }

  // --- Scripting -------------------------------------------------------------------------------

  /** Answer the next matching call with an HTTP error. Route is "METHOD /path/regex". */
  failNext(route: string, status: number, body: ApiErrorBody): void {
    this.overrides.push({route, respond: () => new Response(JSON.stringify({error: body}), {status, headers: {'content-type': 'application/json'}})});
  }
  /** Make the next matching call fail with no HTTP response. */
  dropNext(route: string): void {
    this.overrides.push({route, respond: () => {throw new TypeError('Failed to fetch');}});
  }
  /** Hold matching calls until released. */
  hold(route: string): Held {
    let release!: () => void;
    const wait = new Promise<void>((resolve) => (release = resolve));
    const entry = {route, wait};
    this.holds.push(entry);
    return {release: () => {this.holds.splice(this.holds.indexOf(entry), 1); release();}};
  }
  /** Answer matching calls from the state at call time, but deliver the answer only when released. */
  holdResponse(route: string): Held {
    let release!: () => void;
    const wait = new Promise<void>((resolve) => (release = resolve));
    const entry = {route, wait};
    this.responseHolds.push(entry);
    return {release: () => {this.responseHolds.splice(this.responseHolds.indexOf(entry), 1); release();}};
  }
  callsTo(method: string, path: RegExp): Call[] {
    return this.calls.filter((c) => c.method === method && path.test(c.path));
  }

  accept(socket: FakeSocket): void {
    if (socket.readyState === FakeSocket.CLOSED) return;
    if (!this.loggedIn) {
      // Refused before the upgrade: HTTP 401, which a browser sees only as a close with no frame (docs/API.md).
      socket.drop(1006);
      return;
    }
    socket.readyState = FakeSocket.OPEN;
    socket.onopen?.({});
    socket.deliver('snapshot', this.snapshot());
  }
  releaseHandshake(): void {
    this.withholdSnapshot = false;
    for (const s of this.sockets) if (s.readyState === FakeSocket.CONNECTING) this.accept(s);
  }
  get openSocket(): FakeSocket | undefined {
    return this.sockets.filter((s) => s.readyState === FakeSocket.OPEN).at(-1);
  }
  broadcast(type: WsMessage['type'], payload: unknown): void {
    for (const s of this.sockets) s.deliver(type, payload);
  }
  dropSockets(code = 1006): void {
    for (const s of [...this.sockets]) s.drop(code);
  }

  snapshot(): Snapshot {
    const sessions = [...this.sessions.values()];
    const terminal = sessions.filter((s) => TERMINAL_SESSION.has(s.state)).slice(-20);
    const live = sessions.filter((s) => !TERMINAL_SESSION.has(s.state));
    const requests = [...this.requests.values()].filter((r) => !TERMINAL_REQUEST.has(r.state));
    return {
      at: new Date().toISOString(),
      group_id: this.loggedIn?.group_id ?? 'group-1',
      storage: this.storage,
      devices: [...this.devices.values()].filter((d) => d.state !== 'removed').map(({inventory: _i, instances: _n, ...d}) => d),
      connection_tests: [...this.tests.values()].filter((t) => ACTIVE_TEST.has(t.state) || t.listener_closed_at === null),
      sessions: [...live, ...terminal].map(({effective_config: _e, instances: _n, plan: _p, ...s}) => s),
      requests: requests.map(({input: _i, seed: _s, sampling: _a, engine_end: _e, statistics: _t, ...r}) => r),
      output_watermarks: requests.map((r) => ({request_id: r.id, contiguous_seq: r.contiguous_seq})),
    };
  }

  // --- Device simulation ------------------------------------------------------------------------

  enroll(enrollmentId: ID, kind: 'mac' | 'linux', patch: Partial<Device> = {}): Device {
    const enrollment = this.enrollments.get(enrollmentId)!;
    const device = makeDevice({kind, name: enrollment.device_name, created_at: new Date().toISOString(), ...patch});
    this.devices.set(device.id, device);
    enrollment.state = 'consumed';
    enrollment.device_id = device.id;
    this.broadcast('enrollment.updated', {...enrollment, token: null});
    this.broadcast('device.updated', device);
    return device;
  }
  expireEnrollment(enrollmentId: ID): void {
    const enrollment = this.enrollments.get(enrollmentId)!;
    enrollment.state = 'expired';
    this.broadcast('enrollment.updated', {...enrollment, token: null});
  }
  updateDevice(id: ID, patch: Partial<Device>): void {
    const device = {...this.devices.get(id)!, ...patch};
    this.devices.set(id, device);
    this.broadcast('device.updated', device);
  }
  finishTest(id: ID, reachable: boolean): void {
    const test = this.tests.get(id)!;
    const finished: Partial<ConnectionTest> = reachable
      ? {state: 'reachable', source_address: '192.0.2.20', target_address: test.target_addresses[0], rtt_median_ms: 1.5, transfer_bytes: '8000000', transfer_ms: 64, valid: true, valid_until: new Date(Date.now() + 7 * 24 * 3600 * 1000).toISOString(), finished_at: new Date().toISOString(), listener_closed_at: new Date().toISOString()}
      : {state: 'unreachable', error: err('direction_unreachable', 'Connection refused on every address.'), finished_at: new Date().toISOString(), listener_closed_at: new Date().toISOString()};
    Object.assign(test, finished);
    this.broadcast('connection_test.updated', test);
  }
  updateSession(id: ID, patch: Partial<Session>): void {
    const session = {...this.sessions.get(id)!, ...patch};
    this.sessions.set(id, session);
    this.broadcast('session.updated', session);
  }
  /** Change one device's instance in a session, as an instance report would, and tell browsers. */
  updateInstance(sessionId: ID, deviceId: ID, patch: Partial<Instance>): void {
    const session = this.sessions.get(sessionId)!;
    const instances = session.instances.map((i) => (i.device_id === deviceId ? {...i, ...patch} : i));
    this.updateSession(sessionId, {instances});
  }
  /** A request sent through the OpenAI-compatible API: it runs on the session like a website request. */
  apiRequest(sessionId: ID, patch: Partial<Request> = {}): Request {
    const session = this.sessions.get(sessionId)!;
    const request = makeRequest({session_id: sessionId, state: 'running', source: 'api', api_key_id: 'key-1', input: {},
                                 received_at: new Date().toISOString(), timing: {...emptyTiming}, ...patch});
    this.requests.set(request.id, request);
    session.active_request_ids = [request.id];
    this.broadcast('session.updated', session);
    this.broadcast('request.updated', request);
    return request;
  }
  /** Record one committed chunk and tell browsers (or, if `silent`, keep it for the REST backfill only). */
  emitChunk(requestId: ID, text: string, tokens: number, silent = false, segment: Chunk['segment'] = null): void {
    const request = this.requests.get(requestId)!;
    const list = this.chunks.get(requestId) ?? [];
    const seq = list.length + 1;
    const chunk: Chunk = {request_id: requestId, seq: String(seq), text, token_count: tokens, committed_position: '0', segment,
                          engine_first_output_ns: null, engine_last_output_ns: null, engine_first_chunk_tokens: null, received_at: new Date().toISOString()};
    list.push(chunk);
    this.chunks.set(requestId, list);
    const total = BigInt(request.output_tokens) + BigInt(tokens);
    const firstOutput = request.timing.engine_first_output_ns ?? '1000000000';
    const last = String(1_000_000_000 + (seq - 1) * 500_000_000);
    const timing = {...request.timing, engine_received_ns: request.timing.engine_received_ns ?? '0', engine_first_output_ns: firstOutput,
                    engine_last_output_ns: last, engine_first_chunk_tokens: request.timing.engine_first_chunk_tokens ?? tokens};
    Object.assign(request, {state: 'running', contiguous_seq: String(seq), output_tokens: String(total), timing});
    if (silent) return;
    this.broadcast('output.chunk', chunk);
    this.broadcast('request.updated', request);
  }
  finishRequest(id: ID, patch: Partial<Request> = {}): void {
    const request = this.requests.get(id)!;
    Object.assign(request, {state: 'completed', final_seq: request.contiguous_seq, archive_state: 'saved', ended_at: new Date().toISOString()}, patch);
    const session = this.sessions.get(request.session_id)!;
    session.active_request_ids = [];
    this.broadcast('request.updated', request);
    this.broadcast('session.updated', session);
  }

  // --- REST ------------------------------------------------------------------------------------

  fetch = async (input: string | URL | globalThis.Request, init: RequestInit = {}): Promise<Response> => {
    const url = new URL(String(input), 'https://control.test');
    if (!url.pathname.startsWith('/api/v1/')) throw new Error(`Unexpected URL ${url}`);
    const path = url.pathname.slice('/api/v1'.length);
    const method = (init.method ?? 'GET').toUpperCase();
    const headers = Object.fromEntries(new Headers(init.headers).entries());
    // a file upload sends the file itself; every other body is JSON
    const body = init.body instanceof Blob ? await init.body.text() : init.body ? JSON.parse(String(init.body)) : undefined;
    this.calls.push({method, path, query: url.search, headers, body});

    const routeKey = `${method} ${path}`;
    for (const hold of [...this.holds]) if (new RegExp(hold.route).test(routeKey)) await hold.wait;
    const override = this.overrides.find((o) => new RegExp(o.route).test(routeKey));
    if (override) {
      this.overrides.splice(this.overrides.indexOf(override), 1);
      return override.respond();
    }
    // a file download answers with the file's own bytes
    const content = method === 'GET' && path.match(/^\/files\/([^/]+)\/content$/);
    if (content && this.files.has(content[1])) return new Response(this.files.get(content[1])!.text, {status: 200, headers: {'content-type': this.files.get(content[1])!.content_type}});
    try {
      const [status, payload] = this.route(method, path, url.searchParams, headers, body);
      for (const hold of [...this.responseHolds]) if (new RegExp(hold.route).test(routeKey)) await hold.wait;
      return new Response(status === 204 ? null : JSON.stringify(payload), {status, headers: {'content-type': 'application/json'}});
    } catch (e) {
      if (e instanceof HttpError) return new Response(JSON.stringify({error: e.body}), {status: e.status});
      throw e;
    }
  };

  private route(method: string, path: string, params: URLSearchParams, headers: Record<string, string>, body: any): [number, unknown] {
    // Only these two POSTs take the header.
    if (headers['idempotency-key'] && !(method === 'POST' && /^\/sessions(\/[^/]+\/requests)?$/.test(path))) {
      throw new HttpError(400, err('invalid_input', 'Idempotency-Key is not accepted here.'));
    }
    if (method === 'GET' && path === '/auth/registration') return [200, {registration: this.registrationClosed ? 'closed' : 'open'}];
    if (method === 'POST' && path === '/auth/register') {
      if (this.registrationClosed) throw new HttpError(403, err('registration_closed', 'Registration is closed on this control plane. Ask its administrator for an account.'));
      assertKeys(body, ['email', 'password']);
      const email = body.email.trim().toLowerCase();
      if (this.accounts.has(email)) throw new HttpError(409, err('invalid_input', 'That email is already registered.', {field: 'email'}));
      if (body.password.length < 12 || body.password.length > 128) throw new HttpError(400, err('invalid_input', 'Use a password of 12 to 128 characters.', {field: 'password'}));
      const identity: Identity = {user_id: uuid(), email, group_id: uuid(), csrf_token: `csrf-${uuid()}`, expires_at: new Date(Date.now() + 7 * 24 * 3600 * 1000).toISOString()};
      this.accounts.set(email, {password: body.password, identity});
      this.loggedIn = identity;
      return [201, identity];
    }
    if (method === 'POST' && path === '/auth/login') {
      assertKeys(body, ['email', 'password']);
      const account = this.accounts.get(body.email.trim().toLowerCase());
      if (!account || account.password !== body.password) throw new HttpError(401, err('unauthenticated', 'Wrong email or password.'));
      this.loggedIn = account.identity;
      return [200, account.identity];
    }
    if (!this.loggedIn) throw new HttpError(401, err('unauthenticated', 'Sign in first.'));
    if (method === 'POST' && headers['x-csrf-token'] !== this.loggedIn.csrf_token) throw new HttpError(403, err('forbidden', 'Bad CSRF token.'));

    if (method === 'GET' && path === '/auth/me') return [200, this.loggedIn];
    if (method === 'POST' && path === '/auth/logout') {
      assertKeys(body, []);
      this.loggedIn = null;
      this.dropSockets(4401);
      return [204, null];
    }
    if (method === 'POST' && path === '/enrollment-tokens') {
      assertKeys(body, ['device_name']);
      const enrollment = makeEnrollment({device_name: body.device_name, created_at: new Date().toISOString()});
      this.enrollments.set(enrollment.id, enrollment);
      return [201, enrollment];
    }
    if (method === 'GET' && path === '/catalog') return [200, this.catalog];
    if (method === 'GET' && path === '/acceptance-prompts') return [200, this.acceptance];
    if (method === 'POST' && path === '/connection-tests') {
      assertKeys(body, ['source_device_id', 'target_device_id', 'target_addresses', 'port', 'listener_python']);
      const plan = body as TestPlan;
      const busy = [...this.devices.values()].find((d) => d.id === plan.target_device_id && d.state === 'occupied');
      if (busy) throw new HttpError(409, err('port_busy', 'The port is held by a running session.', {device_id: busy.id}));
      const test = makeTest({...plan, state: 'listening', started_at: new Date().toISOString()});
      this.tests.set(test.id, test);
      this.broadcast('connection_test.updated', test);
      return [202, {test}];
    }
    if (method === 'POST' && path === '/sessions/preflight') {
      assertKeys(body, ['service_device_id', 'service_version_id', 'helpers']);
      for (const id of [body.service_device_id, ...body.helpers.map((h: {device_id: ID}) => h.device_id)]) {
        if (!this.devices.has(id)) throw new HttpError(404, err('not_found', 'That device no longer exists. Choose another device.', {device_id: id}));
      }
      // A preflight without a helper version returns the plan with the one Placement chose.
      const plan = {...body, helpers: body.helpers.map((h: SessionPlan['helpers'][number]) => ({...h, version_id: h.version_id ?? this.placementChoice}))};
      const preflight: Preflight = {
        checked_at: new Date().toISOString(), allowed: plan.helpers.every((h: SessionPlan['helpers'][number]) => h.version_id !== null), plan, config_sha256: 'f'.repeat(64),
        checks: [{code: 'platform', passed: true, device_id: null, message: 'Both platforms are supported.', required_bytes: null, available_bytes: null}],
        ...this.preflightResult?.(body),
      };
      return [200, preflight];
    }
    if (method === 'POST' && path === '/sessions') {
      assertKeys(body, ['service_device_id', 'service_version_id', 'helpers']);
      const key = headers['idempotency-key'];
      if (!key) throw new HttpError(400, err('invalid_input', 'Idempotency-Key is required.'));
      if (body.helpers[0].version_id === null) throw new HttpError(400, err('invalid_input', 'Name the helper version.', {field: 'helpers.0.version_id'}));
      const existing = [...this.sessions.values()].find((s) => s.idempotency_key === key);
      if (existing) return [201, {session: existing}];
      const versions = this.catalog.versions.filter((v) => v.id === body.service_version_id || v.id === body.helpers[0].version_id);
      const session = makeSession({idempotency_key: key, plan: body, state: 'starting', phase: 'prepare', created_at: new Date().toISOString(),
                                   effective_config: {versions}});
      // The backend creates one instance per device with the session, at phase prepare (control.ts).
      session.instances = [body.service_device_id, body.helpers[0].device_id].map((deviceId: ID) => makeInstance({session_id: session.id, device_id: deviceId}));
      this.sessions.set(session.id, session);
      this.reserve(body.service_device_id, session.id, 'service');
      this.reserve(body.helpers[0].device_id, session.id, 'helper');
      this.broadcast('session.updated', session);
      return [201, {session}];
    }
    let m: RegExpMatchArray | null;
    if ((m = path.match(/^\/devices\/([^/]+)$/)) && method === 'GET') return [200, this.need(this.devices, m[1])];
    if ((m = path.match(/^\/devices\/([^/]+)\/recheck$/)) && method === 'POST') {
      assertKeys(body, []);
      const device = this.need(this.devices, m[1]);
      if (device.state !== 'cleanup_required') throw new HttpError(409, err('device_busy', 'The device is not awaiting cleanup.'));
      return [202, {command_id: uuid(), device_id: device.id}];
    }
    if ((m = path.match(/^\/devices\/([^/]+)\/remove$/)) && method === 'POST') {
      assertKeys(body, ['confirm_unavailable']);
      if (body.confirm_unavailable !== true) throw new HttpError(400, err('invalid_input', 'Confirmation is required.'));
      const device = this.need(this.devices, m[1]);
      if (device.state !== 'offline' || !device.cleanup_required) throw new HttpError(409, err('device_busy', 'Only offline devices awaiting cleanup can be removed.'));
      device.state = 'removed';
      device.removed_at = new Date().toISOString();
      this.broadcast('device.updated', device);
      return [200, device];
    }
    if ((m = path.match(/^\/connection-tests\/([^/]+)$/)) && method === 'GET') return [200, this.need(this.tests, m[1])];
    if ((m = path.match(/^\/sessions\/([^/]+)$/)) && method === 'GET') return [200, this.need(this.sessions, m[1])];
    if ((m = path.match(/^\/sessions\/([^/]+)\/stop$/)) && method === 'POST') {
      assertKeys(body, []);
      const session = this.need(this.sessions, m[1]);
      if (!TERMINAL_SESSION.has(session.state) && session.state !== 'stopping') {
        session.state = 'stopping';
        session.phase = 'drain';
        this.broadcast('session.updated', session);
      }
      return [202, {session}];
    }
    if ((m = path.match(/^\/sessions\/([^/]+)\/helpers\/([^/]+)\/reconnect$/)) && method === 'POST') {
      assertKeys(body, []);
      const session = this.need(this.sessions, m[1]);
      if (session.state !== 'degraded') throw new HttpError(409, err('session_not_ready', 'Only a degraded session can reconnect a helper.'));
      if (this.need(this.devices, m[2]).state === 'offline') throw new HttpError(409, err('device_busy', 'The helper is offline. Wait for it to come back.', {device_id: m[2]}));
      return [202, {session}];
    }
    if (method === 'POST' && path === '/files') {
      const name = params.get('name') ?? '';
      if (!/\.(txt|md)$/i.test(name) || typeof body !== 'string') throw new HttpError(400, err('invalid_input', 'Name the file in the query: a .txt or .md file name.'));
      const file = {id: uuid(), name, content_type: /\.md$/i.test(name) ? 'text/markdown' : 'text/plain', size_bytes: new TextEncoder().encode(body).length,
                    sha256: 'f'.repeat(64), created_at: new Date().toISOString(), text: body};
      this.files.set(file.id, file);
      const {text, ...view} = file;
      return [201, {file: view}];
    }
    if ((m = path.match(/^\/sessions\/([^/]+)\/requests$/)) && method === 'POST') {
      assertKeys(body, [], ['prompt', 'prompt_file_id', 'acceptance_prompt_id', 'max_output_tokens']);
      const key = headers['idempotency-key'];
      if (!key) throw new HttpError(400, err('invalid_input', 'Idempotency-Key is required.'));
      if (['prompt', 'prompt_file_id', 'acceptance_prompt_id'].filter((k) => k in body).length !== 1) throw new HttpError(400, err('invalid_input', 'Send exactly one of prompt, prompt_file_id or acceptance_prompt_id.'));
      const file = 'prompt_file_id' in body ? this.need(this.files, body.prompt_file_id) : null;
      const existing = [...this.requests.values()].find((r) => r.submission_id === key);
      if (existing) return [201, {request: existing}];
      const session = this.need(this.sessions, m[1]);
      if (session.state !== 'ready' && session.state !== 'degraded') throw new HttpError(409, err('session_not_ready', 'The session is not ready.'));
      if (session.active_request_ids.length > 0) throw new HttpError(409, err('request_busy', 'A request is already running.'));
      const request = makeRequest({session_id: session.id, submission_id: key, state: 'pending',
                                   input: file ? {prompt: file.text} : body, prompt_file: file && {id: file.id, name: file.name, size_bytes: file.size_bytes},
                                   requested_max_output: body.max_output_tokens ?? null, received_at: new Date().toISOString(), timing: {...emptyTiming}});
      this.requests.set(request.id, request);
      session.active_request_ids = [request.id];
      this.broadcast('session.updated', session);
      this.broadcast('request.updated', request);
      return [201, {request}];
    }
    if ((m = path.match(/^\/sessions\/([^/]+)\/requests$/)) && method === 'GET') {
      // The session's latest requests, newest first, shaped as in a snapshot.
      const session = this.need(this.sessions, m[1]);
      const limit = Number(params.get('limit') ?? '20');
      if (!Number.isInteger(limit) || limit < 1 || limit > 100) throw new HttpError(400, err('invalid_input', 'Bad limit.', {field: 'limit'}));
      const rows = [...this.requests.values()].filter((r) => r.session_id === session.id)
        .sort((a, b) => b.received_at.localeCompare(a.received_at) || b.id.localeCompare(a.id)).slice(0, limit);
      return [200, {requests: rows.map(({input: _i, seed: _s, sampling: _a, engine_end: _e, statistics: _t, ...r}) => r)}];
    }
    if (method === 'GET' && path === '/api-keys') {
      const keys = [...this.apiKeys.values()].sort((a, b) => b.created_at.localeCompare(a.created_at) || b.id.localeCompare(a.id));
      return [200, {api_keys: keys, certificate_path: this.certificatePath}];
    }
    if (method === 'POST' && path === '/api-keys') {
      assertKeys(body, ['name']);
      if (typeof body.name !== 'string' || body.name.length < 1 || body.name.length > 80) {
        throw new HttpError(400, err('invalid_input', 'Use a name of 1 to 80 characters.', {field: 'name'}));
      }
      const secret = `oi_${uuid().replace(/-/g, '').padEnd(43, 'x').slice(0, 43)}`;
      const key: ApiKey = {id: uuid(), name: body.name, hint: `oi_${secret.slice(-4)}`, created_at: new Date().toISOString(), last_used_at: null, revoked_at: null};
      this.apiKeys.set(key.id, key);
      this.lastSecret = secret;
      return [201, {api_key: key, secret}];
    }
    if ((m = path.match(/^\/api-keys\/([^/]+)\/revoke$/)) && method === 'POST') {
      assertKeys(body, []);
      const key = this.need(this.apiKeys, m[1]);
      key.revoked_at ??= new Date().toISOString();
      return [200, {api_key: key}];
    }
    if ((m = path.match(/^\/requests\/([^/]+)$/)) && method === 'GET') return [200, this.need(this.requests, m[1])];
    if ((m = path.match(/^\/requests\/([^/]+)\/result$/)) && method === 'GET') {
      const request = this.need(this.requests, m[1]);
      if (request.archive_state !== 'saved') throw new HttpError(409, err('result_pending', 'The result is not saved yet.'));
      return [200, {schema_version: 1, request_id: request.id, outcome: request.state, input: request.input, prompt_file_id: request.prompt_file?.id ?? null}];
    }
    if ((m = path.match(/^\/requests\/([^/]+)\/chunks$/)) && method === 'GET') {
      const request = this.need(this.requests, m[1]);
      const after = Number(params.get('after') ?? '0');
      const limit = Math.min(Number(params.get('limit') ?? '100'), 1000);
      const available = (this.chunks.get(request.id) ?? []).filter((c) => Number(c.seq) > after && Number(c.seq) <= Number(request.contiguous_seq));
      const page = available.slice(0, limit);
      return [200, {request_id: request.id, chunks: page, contiguous_seq: request.contiguous_seq,
                    next: available.length > page.length ? page.at(-1)!.seq : null}];
    }
    throw new HttpError(404, err('not_found', `No route for ${method} ${path}.`));
  }

  private reserve(deviceId: ID, sessionId: ID, role: 'service' | 'helper') {
    this.updateDevice(deviceId, {state: 'occupied', reservation: {session_id: sessionId, role}});
  }
  private need<T>(map: Map<ID, T>, id: ID): T {
    const value = map.get(id);
    if (!value) throw new HttpError(404, err('not_found', 'Not found.'));
    return value;
  }
}
