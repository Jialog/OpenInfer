import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { randomBytes, randomUUID } from 'node:crypto';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import https from 'node:https';
import type { IncomingHttpHeaders } from 'node:http';
import { promisify } from 'node:util';
import { after, before, test } from 'node:test';
import { WebSocket, type ClientOptions } from 'ws';

import { ControlPlane } from '../src/control.js';
import { EMPTY_METRICS, EMPTY_STATS, EMPTY_TIMING } from '../src/protocol.js';
import { createServer } from '../src/server.js';
import { MemoryObjectStore } from '../src/storage.js';
import { fixtureCatalog, fixtureProof, inventory } from './fixtures.js';
import { createDatabase } from './postgres.js';

type Json = Record<string, any>;
type Database = Awaited<ReturnType<typeof createDatabase>>;

const run = promisify(execFile);
const origin = 'https://control.example.test';
const timeoutMs = 10_000;

let database: Database;
let temporaryDirectory: string;
let certificate: Buffer;
let privateKey: Buffer;
let serverHandle: ReturnType<typeof createServer>;
let controlPlane: ControlPlane;
let port: number;
let sharedAuth: { cookie: string; headers: Record<string, string> } | undefined;
let sharedPlan: Json | undefined;
let sharedDevices: Partial<Record<'service' | 'helper', { id: string; credential: string; bootId: string }>> = {};

function waitForEvent<T>(target: NodeJS.EventEmitter, event: string): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`timed out waiting for ${event}`)), timeoutMs);
    target.once(event, (value: T) => {
      clearTimeout(timer);
      resolve(value);
    });
    target.once('error', reject);
  });
}

async function request(
  path: string,
  method = 'GET',
  body?: unknown,
  headers: Record<string, string> = {},
): Promise<{ status: number; headers: IncomingHttpHeaders; body: any }> {
  const encoded = body === undefined ? undefined : Buffer.from(JSON.stringify(body));
  return new Promise((resolve, reject) => {
    const req = https.request(
      {
        host: '127.0.0.1',
        port,
        path,
        method,
        ca: certificate,
        servername: 'localhost',
        rejectUnauthorized: true,
        headers: {
          host: `localhost:${port}`,
          ...(encoded ? { 'content-type': 'application/json', 'content-length': String(encoded.length) } : {}),
          ...headers,
        },
      },
      (response) => {
        const chunks: Buffer[] = [];
        response.on('data', (chunk: Buffer) => chunks.push(chunk));
        response.on('end', () => {
          const text = Buffer.concat(chunks).toString('utf8');
          resolve({
            status: response.statusCode ?? 0,
            headers: response.headers,
            body: text === '' ? null : JSON.parse(text),
          });
        });
      },
    );
    req.on('error', reject);
    if (encoded) req.write(encoded);
    req.end();
  });
}

class MessageSocket {
  readonly socket: WebSocket;
  private readonly messages: Json[] = [];
  private readonly waiters: (() => void)[] = [];

  constructor(path: string, protocol: string, options: ClientOptions) {
    const tlsOptions = {
      ca: certificate,
      servername: 'localhost',
      rejectUnauthorized: true,
      ...options,
    } as ClientOptions & { servername: string };
    this.socket = new WebSocket(`wss://127.0.0.1:${port}${path}`, protocol, tlsOptions);
    this.socket.on('message', (bytes) => {
      this.messages.push(JSON.parse(bytes.toString()));
      for (const wake of this.waiters.splice(0)) wake();
    });
  }

  async open(): Promise<void> {
    if (this.socket.readyState === WebSocket.OPEN) return;
    await waitForEvent(this.socket, 'open');
  }

  async next(predicate: (message: Json) => boolean, label: string): Promise<Json> {
    const deadline = Date.now() + timeoutMs;
    while (true) {
      const index = this.messages.findIndex(predicate);
      if (index >= 0) return this.messages.splice(index, 1)[0]!;
      const remaining = deadline - Date.now();
      if (remaining <= 0) {
        throw new Error(`timed out waiting for ${label}; queued=${JSON.stringify(this.messages)}`);
      }
      await new Promise<void>((resolve, reject) => {
        const timer = setTimeout(() => {
          const index = this.waiters.indexOf(wake);
          if (index >= 0) this.waiters.splice(index, 1);
          reject(new Error(`timed out waiting for ${label}; queued=${JSON.stringify(this.messages)}`));
        }, remaining);
        const wake = () => {
          clearTimeout(timer);
          resolve();
        };
        this.waiters.push(wake);
      });
    }
  }

  close(): void {
    this.socket.close();
  }
}

class FakeDevice extends MessageSocket {
  private connectionId = '';
  constructor(
    readonly role: 'service' | 'helper',
    readonly id: string,
    readonly credential: string,
    readonly bootId: string,
  ) {
    super('/api/v1/ws/device', 'openinfer.device.v1', {
      headers: {
        authorization: `Bearer ${credential}`,
        'x-openinfer-device-id': id,
      },
    });
  }

  async reconcile(
    reports: { instances?: Json[]; commands?: Json[]; requests?: Json[] } = {},
  ): Promise<Json> {
    await this.open();
    const hello = await this.next((message) => message.type === 'hello', 'device hello');
    this.connectionId = hello.payload.connection_id;
    await this.send('reconcile', {
      agent_boot_id: this.bootId,
      inventory: inventory(this.role),
      instances: reports.instances ?? [],
      commands: reports.commands ?? [],
      requests: reports.requests ?? [],
    });
    return this.next((message) => message.type === 'reconciled', 'device reconciled');
  }

  async send(type: string, payload: Json): Promise<string> {
    const messageId = randomUUID();
    this.socket.send(
      JSON.stringify({
        v: 1,
        type,
        message_id: messageId,
        connection_id: this.connectionId,
        device_id: this.id,
        sent_at: new Date().toISOString(),
        payload,
      }),
    );
    return messageId;
  }

  async sendRecorded(type: string, payload: Json): Promise<void> {
    const messageId = await this.send(type, payload);
    await this.next(
      (message) => message.type === 'recorded' && message.payload.reply_to === messageId,
      `${this.role} ${type} recorded`,
    );
  }

  async command(kind: string): Promise<Json> {
    const message = await this.next(
      (candidate) => candidate.type === 'command' && candidate.payload.kind === kind,
      `${this.role} ${kind} command`,
    );
    await this.sendRecorded('command.ack', { command_id: message.payload.command_id, state: 'executing' });
    return message.payload;
  }

  async complete(command: Json, result: Json): Promise<void> {
    await this.sendRecorded('command.result', {
      command_id: command.command_id,
      outcome: 'completed',
      result,
      error: null,
    });
  }

  report(command: Json, state: 'connectable' | 'stopped'): Json {
    const reference = command.instance_refs?.find((candidate: Json) => candidate.instance_id === command.instance_id);
    assert.ok(reference, `${command.kind} must carry an instance_refs entry for its top-level instance_id`);
    return {
      instance_id: reference.instance_id,
      session_id: reference.session_id,
      agent_boot_id: this.bootId,
      generation: reference.generation,
      state,
      phase: state === 'stopped' ? 'kill' : 'connect',
      config_sha256: reference.config_sha256,
      processes: [],
      http_healthy: this.role === 'service' && state !== 'stopped',
      push_listening: this.role === 'service' && state !== 'stopped',
      calibrated: true,
      inventory_after: null,
      metrics: EMPTY_METRICS,
      error: null,
    };
  }
}

function authHeaders(cookie: string, csrf: string): Record<string, string> {
  return { cookie, origin, 'x-csrf-token': csrf };
}

async function expectStatus(response: Awaited<ReturnType<typeof request>>, status: number): Promise<Json> {
  assert.equal(response.status, status, JSON.stringify(response.body));
  return response.body;
}

before(async () => {
  temporaryDirectory = await mkdtemp('/tmp/openinfer-https-test-');
  const keyPath = `${temporaryDirectory}/tls.key`;
  const certificatePath = `${temporaryDirectory}/tls.crt`;
  await run('openssl', [
    'req', '-x509', '-newkey', 'rsa:2048', '-nodes', '-days', '1',
    '-subj', '/CN=localhost', '-addext', 'subjectAltName=DNS:localhost',
    '-keyout', keyPath, '-out', certificatePath,
  ]);
  const [key, cert] = await Promise.all([readFile(keyPath), readFile(certificatePath)]);
  privateKey = key;
  certificate = cert;
  database = await createDatabase();
  controlPlane = new ControlPlane(database.pool, new MemoryObjectStore(), fixtureCatalog());
  serverHandle = createServer(controlPlane, { key, cert, origin, tickIntervalMs: 25 });
  serverHandle.server.listen(0, '127.0.0.1');
  await waitForEvent(serverHandle.server, 'listening');
  const address = serverHandle.server.address();
  assert.ok(address && typeof address === 'object');
  port = address.port;
});

after(async () => {
  await serverHandle.close();
  await database.close();
  await rm(temporaryDirectory, { recursive: true, force: true });
});

test('HTTPS and WSS drive two devices through one archived request and a clean stop', async (t) => {
  const registration = await request(
    '/api/v1/auth/register',
    'POST',
    { email: 'network@example.test', password: randomBytes(18).toString('base64url') },
    { origin },
  );
  const identity = await expectStatus(registration, 201);
  const setCookie = registration.headers['set-cookie']?.[0];
  assert.ok(setCookie);
  assert.ok(setCookie.includes('Secure'));
  const cookie = setCookie.split(';', 1)[0]!;
  const authenticated = authHeaders(cookie, identity.csrf_token);
  sharedAuth = { cookie, headers: authenticated };

  const devices: Partial<Record<'service' | 'helper', FakeDevice>> = {};
  for (const role of ['service', 'helper'] as const) {
    const enrollment = await expectStatus(
      await request('/api/v1/enrollment-tokens', 'POST', { device_name: role }, authenticated),
      201,
    );
    const credential = randomBytes(32).toString('base64url');
    const bootId = randomUUID();
    const enrolled = await expectStatus(
      await request('/api/v1/device/enroll', 'POST', {
        enrollment_token: enrollment.token,
        credential,
        agent_boot_id: bootId,
        inventory: inventory(role),
      }),
      201,
    );
    const device = new FakeDevice(role, enrolled.device_id, credential, bootId);
    sharedDevices[role] = { id: enrolled.device_id, credential, bootId };
    devices[role] = device;
    t.after(() => device.close());
    await device.reconcile();
  }
  let service = devices.service!;
  const helper = devices.helper!;

  const connectionTest = (
    await expectStatus(
      await request('/api/v1/connection-tests', 'POST', {
        source_device_id: helper.id,
        target_device_id: service.id,
        target_addresses: ['192.0.2.1'],
        port: 40360,
        listener_python: '/fixture/python',
      }, authenticated),
      202,
    )
  ).test;
  const listen = await service.command('listen_test');
  const originalService = service;
  const resumedService = new FakeDevice('service', service.id, service.credential, service.bootId);
  devices.service = resumedService;
  t.after(() => resumedService.close());
  const reconciliation = await resumedService.reconcile({
    commands: [{ command_id: listen.command_id, state: 'executing', result: null, error: null }],
  });
  service = resumedService;
  originalService.close();
  const reconciledExecutingCommand = reconciliation.payload.commands.some(
    (command: Json) => command.command_id === listen.command_id && command.kind === 'listen_test',
  );
  await service.sendRecorded('test.listening', {
    command_id: listen.command_id,
    test_id: connectionTest.id,
    bound_addresses: ['192.0.2.1'],
    port: 40360,
    python: '/fixture/python',
  });
  const connect = await helper.command('connect_test');
  await helper.sendRecorded('test.result', {
    command_id: connect.command_id,
    test_id: connectionTest.id,
    source_address: '192.0.2.2',
    target_address: '192.0.2.1',
    port: 40360,
    nonce_matched: true,
    rtt_samples_ms: Array(10).fill(1),
    transfer_bytes: '8000000',
    transfer_ms: 10,
    error: null,
  });
  await helper.complete(connect, { test_id: connectionTest.id, listener_closed: false });
  const closeTest = await service.command('close_test');
  await service.complete(closeTest, { test_id: connectionTest.id, listener_closed: true });
  await service.complete(listen, { test_id: connectionTest.id, listener_closed: true });

  const plan = {
    service_device_id: service.id,
    service_version_id: 'service',
    helpers: [{
      device_id: helper.id,
      version_id: 'helper',
      draft_model: 'enabled',
      acknowledge_no_draft_model: false,
      connection_test_id: connectionTest.id,
    }],
  };
  sharedPlan = plan;
  const created = await expectStatus(
    await request('/api/v1/sessions', 'POST', plan, {
      ...authenticated,
      'idempotency-key': randomUUID(),
    }),
    201,
  );
  const session = created.session;

  const servicePrepare = await service.command('prepare');
  const helperPrepare = await helper.command('prepare');
  await service.complete(servicePrepare, {
    manifest_sha256: servicePrepare.payload.version.manifest_sha256,
    prepared_version_id: servicePrepare.payload.version.id,
    build: fixtureProof(servicePrepare.payload.version),
  });
  await helper.complete(helperPrepare, {
    manifest_sha256: helperPrepare.payload.version.manifest_sha256,
    prepared_version_id: helperPrepare.payload.version.id,
    build: fixtureProof(helperPrepare.payload.version),
  });
  const startService = await service.command('start_service');
  await service.complete(startService, { instance: service.report(startService, 'connectable') });
  const startHelper = await helper.command('start_helper');
  await helper.complete(startHelper, { instance: helper.report(startHelper, 'connectable') });
  const pushConnectionId = randomUUID();
  await service.sendRecorded('peer.status', {
    session_id: session.id,
    instance_id: startService.instance_id,
    writer_id: startHelper.payload.entry.command.writer_id,
    connection_generation: 1,
    push_connection_id: pushConnectionId,
    state: 'connected',
    authenticated: true,
    error: null,
  });
  const warmup = await service.command('warmup');
  await service.complete(warmup, {
    resource_sha256: warmup.payload.resource_sha256,
    output_tokens: '256',
    timing: EMPTY_TIMING,
  });

  const snapshotRace = await expectStatus(
    await request(`/api/v1/sessions/${session.id}/requests`, 'POST', { prompt: 'snapshot race' }, {
      ...authenticated,
      'idempotency-key': randomUUID(),
    }),
    201,
  );
  await service.command('run_request');

  const browser = new MessageSocket('/api/v1/ws/browser', 'openinfer.browser.v1', {
    origin,
    headers: { cookie },
  });
  const serverPing = new Promise<void>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('timed out waiting for browser protocol ping')), 15_000);
    browser.socket.once('ping', () => {
      clearTimeout(timer);
      resolve();
    });
  });
  t.after(() => browser.close());
  await browser.open();
  const initial = await browser.next((message) => message.type === 'snapshot', 'browser snapshot');
  assert.equal(initial.seq, '0');
  assert.equal(initial.payload.group_id, identity.group_id);
  assert.equal(initial.payload.devices.length, 2);
  assert.ok(initial.payload.requests.some((candidate: Json) => candidate.id === snapshotRace.request.id));
  await serverPing;
  const enrollmentUpdate = await browser.next(
    (message) => message.type === 'enrollment.updated' && message.payload.device_id === service.id,
    'redacted enrollment update',
  );
  assert.equal(enrollmentUpdate.payload.state, 'consumed');
  assert.equal(enrollmentUpdate.payload.token, null);
  assert.equal('token_hash' in enrollmentUpdate.payload, false);

  const originalQuery = database.pool.query.bind(database.pool) as (...args: any[]) => Promise<any>;
  const originalTick = controlPlane.tick.bind(controlPlane);
  let refreshQueries = 0;
  (controlPlane as any).tick = async () => {};
  (database.pool as any).query = (...args: any[]) => {
    refreshQueries += 1;
    return originalQuery(...args);
  };
  try {
    const change = {
      table: 'devices',
      id: service.id,
      group_id: identity.group_id,
      device_id: service.id,
    };
    for (let index = 0; index < 20; index += 1) controlPlane.emit('changed', [change]);
    await browser.next(
      (message) => message.type === 'device.updated' && message.payload.id === service.id,
      'merged changed-device incremental refresh',
    );
  } finally {
    (database.pool as any).query = originalQuery;
    (controlPlane as any).tick = originalTick;
  }
  assert.ok(refreshQueries <= 11, `a merged change burst exceeded the 11-query refresh bound: ${refreshQueries}`);

  await service.send('request.end', {
    request_id: snapshotRace.request.id,
    instance_id: snapshotRace.request.instance_id,
    final_seq: '0',
    outcome: 'failed',
    reason: 'error',
    released: true,
    prompt_tokens: null,
    output_tokens: '0',
    timing: EMPTY_TIMING,
    statistics: EMPTY_STATS,
    error: {
      code: 'fixture_failure',
      message: 'synthetic fixture failure',
      field: null,
      device_id: null,
      phase: null,
      retryable: false,
    },
  });
  const snapshotRaceTerminal = await browser.next(
    (message) => message.type === 'request.updated' && message.payload.id === snapshotRace.request.id && message.payload.state === 'failed' && message.payload.archive_state === 'saved',
    'request terminal immediately after initial snapshot',
  );
  assert.equal(snapshotRaceTerminal.payload.archive_state, 'saved');

  const submitted = await expectStatus(
    await request(`/api/v1/sessions/${session.id}/requests`, 'POST', { prompt: 'network path' }, {
      ...authenticated,
      'idempotency-key': randomUUID(),
    }),
    201,
  );
  const resultRequest = submitted.request;
  const runRequest = await service.command('run_request');
  const timing = {
    ...EMPTY_TIMING,
    clock_id: resultRequest.instance_id,
    engine_received_ns: '0',
    engine_first_output_ns: '1000000000',
    engine_last_output_ns: '2000000000',
    engine_first_chunk_tokens: 1,
    engine_finished_ns: '2000000000',
  };
  // no maximum output: the serving machine's own budget keeps room for the helper (4096 - 70 - prompt tokens), and the
  // control plane records it without closing the control connection
  const serviceClosed = new Promise<number | null>((resolve) => {
    service.socket.once('close', (code) => resolve(code));
    setTimeout(() => resolve(null), 250);
  });
  const acceptedId = await service.send('request.accepted', {
    request_id: resultRequest.id,
    instance_id: resultRequest.instance_id,
    prompt_tokens: 1,
    effective_max_output: 4096 - 70 - 1,
    committed_position: '1',
    timing: { ...timing, engine_first_output_ns: null, engine_last_output_ns: null, engine_first_chunk_tokens: null, engine_finished_ns: null },
  });
  const acceptedReply = await service.next(
    (message) => (message.type === 'recorded' || message.type === 'error') && message.payload.reply_to === acceptedId,
    'request.accepted reply',
  );
  assert.deepEqual(
    { reply: acceptedReply.type, error: acceptedReply.payload.error?.code ?? null, close: await serviceClosed },
    { reply: 'recorded', error: null, close: null },
  );
  for (const [seq, text] of [['2', 'B'], ['1', 'A']] as const) {
    await service.send('output.chunk', {
      request_id: resultRequest.id,
      instance_id: resultRequest.instance_id,
      seq,
      text,
      token_count: 1,
      segment: 'answer',
      committed_position: String(1 + Number(seq)),
      engine_first_output_ns: '1000000000',
      engine_last_output_ns: seq === '1' ? '1000000000' : '2000000000',
      engine_first_chunk_tokens: 1,
    });
  }
  await service.send('request.end', {
    request_id: resultRequest.id,
    instance_id: resultRequest.instance_id,
    final_seq: '2',
    outcome: 'completed',
    reason: 'length',
    released: true,
    prompt_tokens: 1,
    output_tokens: '2',
    timing,
    statistics: EMPTY_STATS,
    error: null,
  });

  const chunks = new Map<string, string>();
  while (chunks.size < 2) {
    const event = await browser.next(
      (message) => message.type === 'output.chunk' && message.payload.request_id === resultRequest.id,
      'browser output chunk',
    );
    chunks.set(event.payload.seq, event.payload.text);
  }
  assert.deepEqual([...chunks.entries()].sort(), [['1', 'A'], ['2', 'B']]);
  const terminal = await browser.next(
    (message) => message.type === 'request.updated' && message.payload.id === resultRequest.id && message.payload.state === 'completed',
    'terminal request update',
  );
  assert.equal(terminal.payload.archive_state, 'saved');
  const archived = await expectStatus(
    await request(`/api/v1/requests/${resultRequest.id}/result`, 'GET', undefined, { cookie }),
    200,
  );
  assert.equal(archived.text, 'AB');
  assert.equal(archived.outcome, 'completed');

  const originalReadLock = controlPlane.withReadLock.bind(controlPlane);
  let releaseBlockedRefresh!: () => void;
  let markRefreshEntered!: () => void;
  const blockedRefresh = new Promise<void>((resolve) => {
    releaseBlockedRefresh = resolve;
  });
  const refreshEntered = new Promise<void>((resolve) => {
    markRefreshEntered = resolve;
  });
  let blockFirstRefresh = true;
  (controlPlane as any).withReadLock = async <T>(fn: () => Promise<T>): Promise<T> => {
    if (blockFirstRefresh) {
      blockFirstRefresh = false;
      markRefreshEntered();
      await blockedRefresh;
    }
    return originalReadLock(fn);
  };
  const changedDevice = (deviceId: string) => ({
    table: 'devices',
    id: deviceId,
    group_id: identity.group_id,
    device_id: deviceId,
  });
  controlPlane.emit('changed', [changedDevice(service.id)]);
  await refreshEntered;
  controlPlane.emit('changed', [changedDevice(helper.id)]);
  const browserClosed = new Promise<void>((resolve) => browser.socket.once('close', () => resolve()));
  browser.close();
  await browserClosed;
  releaseBlockedRefresh();
  await new Promise<void>((resolve) => setImmediate(resolve));
  (controlPlane as any).withReadLock = originalReadLock;

  const reconnected = new MessageSocket('/api/v1/ws/browser', 'openinfer.browser.v1', {
    origin,
    headers: { cookie },
  });
  t.after(() => reconnected.close());
  await reconnected.open();
  const reconnectSnapshot = await reconnected.next((message) => message.type === 'snapshot', 'reconnect snapshot');
  assert.equal(reconnectSnapshot.payload.requests.length, 0);
  assert.ok(reconnectSnapshot.payload.sessions.some((candidate: Json) => candidate.id === session.id));

  await expectStatus(
    await request(`/api/v1/sessions/${session.id}/stop`, 'POST', {}, authenticated),
    202,
  );
  const serviceStop = await service.command('stop');
  const helperStop = await helper.command('stop');
  await service.complete(serviceStop, { instances: [service.report(startService, 'stopped')], ports_free: true });
  await helper.complete(helperStop, { instances: [helper.report(startHelper, 'stopped')], ports_free: true });
  const stopped = await reconnected.next(
    (message) => message.type === 'session.updated' && message.payload.id === session.id && message.payload.state === 'ended',
    'ended session update',
  );
  assert.equal(stopped.payload.uncleared_device_ids.length, 0);

  const malformedClose = new Promise<number>((resolve) => helper.socket.once('close', (code) => resolve(code)));
  helper.socket.send('{');
  assert.equal(await malformedClose, 4400);

  const forbiddenClose = new Promise<number>((resolve) => service.socket.once('close', (code) => resolve(code)));
  service.socket.send(JSON.stringify({
    v: 1,
    type: 'heartbeat',
    message_id: randomUUID(),
    connection_id: randomUUID(),
    device_id: service.id,
    sent_at: new Date().toISOString(),
    payload: {},
  }));
  assert.equal(await forbiddenClose, 4403);

  const rejectedOptions = {
    ca: certificate,
    servername: 'localhost',
    rejectUnauthorized: true,
    origin: `${origin}/wrong`,
    headers: { cookie },
  } as ClientOptions & { servername: string };
  const rejectedOrigin = new WebSocket(`wss://127.0.0.1:${port}/api/v1/ws/browser`, 'openinfer.browser.v1', rejectedOptions);
  const rejectedStatus = await new Promise<number>((resolve, reject) => {
    rejectedOrigin.once('unexpected-response', (_request, response) => resolve(response.statusCode ?? 0));
    rejectedOrigin.once('error', reject);
  });
  assert.equal(rejectedStatus, 403);
  assert.ok(reconciledExecutingCommand, 'reconciled.commands must include the still-executing command with its complete public fields');
});

test('device errors preserve a valid reply_to and internal failures are not protocol errors', async (t) => {
  const info = sharedDevices.service;
  assert.ok(info);

  const malformed = new FakeDevice('service', info.id, info.credential, info.bootId);
  t.after(() => malformed.close());
  await malformed.reconcile();
  const malformedClosed = new Promise<number>((resolve, reject) => {
    const timer = setTimeout(
      () => reject(new Error(`timed out waiting for malformed device close; readyState=${malformed.socket.readyState}`)),
      timeoutMs,
    );
    malformed.socket.once('close', (code) => {
      clearTimeout(timer);
      resolve(code);
    });
  });
  const malformedId = await malformed.send('command.ack', {});
  const protocolError = await malformed.next((message) => message.type === 'error', 'schema error');
  const protocolCode = await malformedClosed;

  const internal = new FakeDevice('service', info.id, info.credential, info.bootId);
  t.after(() => internal.close());
  await internal.reconcile();
  const originalHandle = controlPlane.handleDevice.bind(controlPlane);
  (controlPlane as any).handleDevice = async () => {
    throw new Error('synthetic database failure');
  };
  const internalClosed = new Promise<number | null>((resolve) => {
    internal.socket.once('close', (code) => resolve(code));
    setTimeout(() => resolve(null), 250);
  });
  try {
    const internalId = await internal.send('heartbeat', {
      agent_boot_id: info.bootId,
      inventory: inventory('service'),
      instances: [],
    });
    const internalError = await internal.next((message) => message.type === 'error', 'internal error');
    const internalCode = await internalClosed;
    assert.deepEqual(
      {
        protocolReplyTo: protocolError.payload.reply_to,
        protocolError: protocolError.payload.error.code,
        protocolCode,
        internalReplyTo: internalError.payload.reply_to,
        internalError: internalError.payload.error.code,
        internalRetryable: internalError.payload.error.retryable,
        internalIsProtocolClose: internalCode === 4400,
      },
      {
        protocolReplyTo: malformedId,
        protocolError: 'invalid_input',
        protocolCode: 4400,
        internalReplyTo: internalId,
        internalError: 'internal_error',
        internalRetryable: true,
        internalIsProtocolClose: false,
      },
    );
  } finally {
    (controlPlane as any).handleDevice = originalHandle;
  }
});

test('graceful shutdown and a restart after thirty seconds preserve the recovery window', async (t) => {
  const info = sharedDevices.helper;
  const serviceInfo = sharedDevices.service;
  assert.ok(info && serviceInfo && sharedAuth && sharedPlan);
  const beforeShutdown = new FakeDevice('helper', info.id, info.credential, info.bootId);
  const serviceBeforeShutdown = new FakeDevice(
    'service',
    serviceInfo.id,
    serviceInfo.credential,
    serviceInfo.bootId,
  );
  await Promise.all([beforeShutdown.reconcile(), serviceBeforeShutdown.reconcile()]);
  const starting = (
    await expectStatus(
      await request('/api/v1/sessions', 'POST', sharedPlan, {
        ...sharedAuth.headers,
        'idempotency-key': randomUUID(),
      }),
      201,
    )
  ).session;
  assert.equal(starting.state, 'starting');
  await Promise.all([
    serviceBeforeShutdown.command('prepare'),
    beforeShutdown.command('prepare'),
  ]);
  const originalPhaseDeadline = starting.phase_deadline_at;
  const gracefulClose = new Promise<{ code: number; reason: string }>((resolve) =>
    beforeShutdown.socket.once('close', (code, reason) => resolve({ code, reason: reason.toString() })),
  );
  const serviceGracefulClose = new Promise<void>((resolve) =>
    serviceBeforeShutdown.socket.once('close', () => resolve()),
  );

  await serverHandle.close();
  const graceful = await gracefulClose;
  await serviceGracefulClose;
  await new Promise((resolve) => setTimeout(resolve, 50));
  const afterClose = (await database.pool.query(
    'SELECT state,reconciled_at FROM devices WHERE id=$1',
    [info.id],
  )).rows[0];

  let restartedNow = Date.now() + 31_000;
  const restartedPlane = new ControlPlane(database.pool, new MemoryObjectStore(), {
    ...fixtureCatalog(),
    now: () => new Date(restartedNow),
  });
  await restartedPlane.recover();
  const afterRecover = (await database.pool.query(
    'SELECT state,reconciled_at,heartbeat_deadline_at FROM devices WHERE id=$1',
    [info.id],
  )).rows[0];
  const recoveredSession = (await database.pool.query(
    'SELECT state,phase_deadline_at FROM sessions WHERE id=$1',
    [starting.id],
  )).rows[0];

  serverHandle = createServer(restartedPlane, {
    key: privateKey,
    cert: certificate,
    origin,
    tickIntervalMs: 60_000,
  });
  serverHandle.server.listen(0, '127.0.0.1');
  await waitForEvent(serverHandle.server, 'listening');
  const address = serverHandle.server.address();
  assert.ok(address && typeof address === 'object');
  port = address.port;
  controlPlane = restartedPlane;

  const afterRestart = new FakeDevice('helper', info.id, info.credential, info.bootId);
  t.after(() => afterRestart.close());
  await afterRestart.reconcile();
  restartedNow += 31_000;
  const heartbeatClose = new Promise<{ code: number; reason: string } | null>((resolve) => {
    afterRestart.socket.once('close', (code, reason) => resolve({ code, reason: reason.toString() }));
    setTimeout(() => resolve(null), 500);
  });
  await restartedPlane.tick();
  const timedOut = await heartbeatClose;

  const replacement = new FakeDevice('helper', info.id, info.credential, info.bootId);
  t.after(() => replacement.close());
  const reconciled = await replacement.reconcile();

  assert.deepEqual(
    {
      graceful,
      shutdownMarkedOffline: afterClose.state === 'offline',
      recoverMarkedOffline: afterRecover.state === 'offline',
      recoverReconciledAt: afterRecover.reconciled_at,
      recoverWindowIsFresh:
        new Date(afterRecover.heartbeat_deadline_at).getTime() >= restartedNow - 31_000 + 29_000,
      recoveredSessionState: recoveredSession.state,
      recoveredPhaseDeadline: new Date(recoveredSession.phase_deadline_at).toISOString(),
      timedOut,
      replacementReplyLength: reconciled.payload.reply_to.length,
    },
    {
      graceful: { code: 1001, reason: 'server_shutdown' },
      shutdownMarkedOffline: false,
      recoverMarkedOffline: false,
      recoverReconciledAt: null,
      recoverWindowIsFresh: true,
      recoveredSessionState: 'starting',
      recoveredPhaseDeadline: new Date(originalPhaseDeadline).toISOString(),
      timedOut: { code: 4408, reason: 'heartbeat_timeout' },
      replacementReplyLength: 36,
    },
  );
});
