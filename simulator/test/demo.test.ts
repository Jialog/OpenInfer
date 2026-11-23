// The simulated devices against the real server, over HTTPS and WSS, with a real PostgreSQL: what a person does on the
// website (the same REST calls), and what the simulator's terminal commands do (the same Fleet methods).
import assert from 'node:assert/strict';
import { execFile, spawn } from 'node:child_process';
import { randomBytes, randomUUID } from 'node:crypto';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import https from 'node:https';
import net from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, before, test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';

import { localOrigin, parseDeployment } from '../../server/src/config.ts';
import { ControlPlane } from '../../server/src/control.ts';
import { createServer } from '../../server/src/server.ts';
import { MemoryObjectStore } from '../../server/src/storage.ts';
import { createDatabase } from '../../server/test/postgres.ts';
import { Fleet, readAnswer, readDevices, tokens } from '../src/device.ts';

type Json = Record<string, any>;
const here = (path: string) => new URL(path, import.meta.url);

let database: Awaited<ReturnType<typeof createDatabase>>;
let directory: string, certificate: Buffer, handle: ReturnType<typeof createServer>, port: number, origin: string;
let fleet: Fleet;
let auth: Record<string, string>;
const deployment = async () => parseDeployment(JSON.parse(await readFile(here('../catalog.json'), 'utf8')));

// The shipped device descriptions, with the waits shortened so the test takes seconds.
async function fastDevices() {
  const specs = await readDevices(here('../devices.json'));
  for (const spec of specs) {
    spec.download_bytes_per_second = 10_000_000_000;
    spec.load_seconds = 0.2;
    if (spec.role === 'service') { spec.tokens_per_second_alone = 400; spec.first_token_seconds = 0.05; }
    else spec.tokens_per_second_with_helper = 1600;
  }
  return specs;
}

function call(path: string, method = 'GET', body?: unknown, headers: Record<string, string> = {}): Promise<{ status: number; headers: Json; body: any }> {
  const bytes = body === undefined ? undefined : Buffer.from(JSON.stringify(body));
  return new Promise((resolve, reject) => {
    const request = https.request({ host: '127.0.0.1', port, path, method, ca: certificate, servername: 'localhost',
      headers: { ...(bytes ? { 'content-type': 'application/json', 'content-length': String(bytes.length) } : {}), ...headers } }, (response) => {
      const chunks: Buffer[] = [];
      response.on('data', (chunk: Buffer) => chunks.push(chunk));
      response.on('end', () => { const text = Buffer.concat(chunks).toString('utf8'); resolve({ status: response.statusCode ?? 0, headers: response.headers, body: text ? JSON.parse(text) : null }); });
    });
    request.on('error', reject);
    if (bytes) request.write(bytes);
    request.end();
  });
}
async function ok(status: number, path: string, method = 'GET', body?: unknown, extra: Record<string, string> = {}) {
  const reply = await call(path, method, body, { ...auth, ...extra });
  assert.equal(reply.status, status, `${method} ${path}: ${JSON.stringify(reply.body)}`);
  return reply.body;
}
// Read PATH until DONE says the value is the one waited for; every value read goes to SEEN.
async function until(path: string, done: (value: Json) => boolean, label: string, seen: (value: Json) => void = () => {}, ms = 20_000): Promise<Json> {
  const deadline = Date.now() + ms;
  let last: Json = {};
  while (Date.now() < deadline) {
    last = await ok(200, path);
    seen(last);
    if (done(last)) return last;
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
  throw new Error(`timed out waiting for ${label}; last: ${JSON.stringify(last).slice(0, 1500)}`);
}
// One request from the website's form, read to its end: the request row, its chunks and the saved result.
async function ask(sessionId: string, prompt: string) {
  const { request } = await ok(201, `/api/v1/sessions/${sessionId}/requests`, 'POST', { prompt }, { 'idempotency-key': randomUUID() });
  const done = await until(`/api/v1/requests/${request.id}`, (r) => r.state === 'completed', `request ${prompt}`);
  const { chunks } = await ok(200, `/api/v1/requests/${request.id}/chunks?limit=1000`);
  const result = await ok(200, `/api/v1/requests/${request.id}/result`);
  // tokens after the first chunk, per second of the engine's own clock: the website's "Decode" speed
  const decode = (Number(done.output_tokens) - done.timing.engine_first_chunk_tokens) / (Number(BigInt(done.timing.engine_last_output_ns) - BigInt(done.timing.engine_first_output_ns)) / 1e9);
  return { request: done, chunks: chunks as Json[], result, decode };
}

before(async () => {
  directory = await mkdtemp(join(tmpdir(), 'simulator-test-'));
  await promisify(execFile)('openssl', ['req', '-x509', '-newkey', 'ec', '-pkeyopt', 'ec_paramgen_curve:P-256', '-nodes', '-days', '1',
    '-subj', '/CN=localhost', '-addext', 'subjectAltName=DNS:localhost,IP:127.0.0.1', '-keyout', `${directory}/tls.key`, '-out', `${directory}/tls.crt`]);
  const [key, cert] = await Promise.all([readFile(`${directory}/tls.key`), readFile(`${directory}/tls.crt`)]);
  certificate = cert;
  database = await createDatabase();
  // the address is the origin the server checks, so a free port is chosen before the server is made
  const probe = net.createServer();
  await new Promise<void>((resolve) => probe.listen(0, '127.0.0.1', resolve));
  port = (probe.address() as net.AddressInfo).port;
  await new Promise<void>((resolve) => probe.close(() => resolve()));
  origin = `https://127.0.0.1:${port}`;
  const plane = new ControlPlane(database.pool, new MemoryObjectStore(), { ...(await deployment()), controlUrls: { local: origin, lan: origin }, certificateSha256: 'a'.repeat(64) });
  handle = createServer(plane, { key, cert, origin, tickIntervalMs: 25 });
  await new Promise<void>((resolve) => handle.server.listen(port, '127.0.0.1', resolve));
});
after(async () => {
  fleet?.close();
  handle.server.closeAllConnections();
  await handle.close();
  await database.close();
  await rm(directory, { recursive: true, force: true });
});

test('the simulated catalogue is one the server accepts, and the described devices can run it', async () => {
  const { catalog, requirements } = await deployment();
  assert.deepEqual(catalog.versions.map((v: Json) => [v.id, v.role]), [['demo-serve-4bit', 'service'], ['demo-help-8bit', 'helper'], ['demo-help-4bit', 'helper']]);
  assert.ok(catalog.versions.every((v: Json) => v.validation.complete && /simulated/i.test(v.label) && requirements[v.id]));
  const specs = await readDevices(here('../devices.json'));
  assert.deepEqual(specs.map((s) => [s.name, s.role]), [['mac', 'service'], ['gpu', 'helper']]);
  for (const spec of specs) assert.match(spec.title + spec.inventory.machine_model + spec.inventory.agent_version, /simulat/i, 'a simulated device says so wherever it is shown');
});

test('enrol, test the connection, start a session, stream a request with a helper, lose the helper and get it back, stop', { timeout: 120_000 }, async () => {
  // a person registers on the website
  const registered = await call('/api/v1/auth/register', 'POST', { email: 'student@example.test', password: randomBytes(18).toString('base64url') }, { origin });
  assert.equal(registered.status, 201, JSON.stringify(registered.body));
  auth = { cookie: registered.headers['set-cookie'][0].split(';', 1)[0], origin, 'x-csrf-token': registered.body.csrf_token };

  // "Add a device" twice: each token is pasted into the simulator, and the device appears with its hardware
  fleet = new Fleet(await fastDevices(), { url: origin, ca: certificate, answer: await readAnswer(here('../answer.txt')) });
  const ids: Record<string, string> = {};
  for (const name of ['mac', 'gpu']) {
    const enrollment = await ok(201, '/api/v1/enrollment-tokens', 'POST', { device_name: `my ${name}` });
    assert.equal(await fleet.command(`enroll ${name} ${enrollment.token}`), `${name} is enrolled and connected.`);
    ids[name] = fleet.device(name).id!;
    const device = await until(`/api/v1/devices/${ids[name]}`, (d) => d.state === 'idle' && d.reconciled_at !== null, `${name} online`);
    assert.equal(device.name, `my ${name}`);
    assert.equal(device.inventory.agent_version, 'simulator');
  }
  const mac = await ok(200, `/api/v1/devices/${ids.mac}`), gpu = await ok(200, `/api/v1/devices/${ids.gpu}`);
  assert.deepEqual([mac.inventory.os, mac.inventory.cpu_model, mac.inventory.memory_total_bytes], ['darwin', 'Apple M3 Max', '51539607552']);
  assert.deepEqual([gpu.inventory.os, gpu.inventory.gpus[0].vendor, gpu.inventory.gpus[0].total_bytes], ['linux', 'NVIDIA', '25757220864']);

  // the connection test of the Devices page, helper -> serving machine, with the plan the website builds
  const { test: started } = await ok(202, '/api/v1/connection-tests', 'POST', { source_device_id: ids.gpu, target_device_id: ids.mac,
    target_addresses: mac.inventory.addresses.map((a: Json) => a.address), port: 40360, listener_python: mac.inventory.python_executables[0].path });
  const reachable = await until(`/api/v1/connection-tests/${started.id}`, (t) => t.state !== 'listening' && t.state !== 'testing' && t.listener_closed_at !== null, 'connection test');
  assert.deepEqual([reachable.state, reachable.valid, reachable.source_address, reachable.target_address, reachable.transfer_bytes], ['reachable', true, '192.0.2.20', '192.0.2.10', '8000000']);
  assert.ok(reachable.rtt_median_ms > 0 && reachable.transfer_ms > 0);

  // New session: the checks pass, and Placement chooses the most precise helper version that fits the simulated card
  const asked = { service_device_id: ids.mac, service_version_id: 'demo-serve-4bit',
    helpers: [{ device_id: ids.gpu, version_id: null, draft_model: 'enabled', acknowledge_no_draft_model: false, connection_test_id: started.id }] };
  const preflight = await ok(200, '/api/v1/sessions/preflight', 'POST', asked);
  assert.equal(preflight.allowed, true, JSON.stringify(preflight.checks.filter((c: Json) => !c.passed)));
  assert.equal(preflight.plan.helpers[0].version_id, 'demo-help-8bit');

  // the session starts: a download with progress, files verified, load, connection, warm-up, ready
  const { session } = await ok(201, '/api/v1/sessions', 'POST', preflight.plan, { 'idempotency-key': randomUUID() });
  const phases: Record<string, Set<string>> = { [ids.mac]: new Set(), [ids.gpu]: new Set() };
  const downloads: Record<string, Json> = {};
  const ready = await until(`/api/v1/sessions/${session.id}`, (s) => s.state === 'ready', 'session ready', (s) => {
    for (const instance of s.instances) { phases[instance.device_id].add(instance.phase); if (instance.progress) downloads[instance.device_id] = instance.progress; }
    assert.ok(!['stopping', 'failed', 'ended'].includes(s.state), `the session is ${s.state}: ${JSON.stringify(s.error)}`);
  });
  for (const name of ['mac', 'gpu']) {
    assert.ok(phases[ids[name]].has('download') && phases[ids[name]].has('load'), `${name} phases seen: ${[...phases[ids[name]]]}`);
    assert.ok(BigInt(downloads[ids[name]].completed_bytes) > 0n);
  }
  assert.equal(downloads[ids.mac].total_bytes, '6412000000');          // the serving version's files
  assert.equal(downloads[ids.gpu].total_bytes, '10500000000');         // the helper version's files and its draft model's
  assert.equal(ready.instances.length, 2);
  assert.ok(ready.instances.every((i: Json) => ['connectable', 'ready'].includes(i.state)));
  assert.ok(ready.instances.find((i: Json) => i.device_id === ids.gpu).push_connection_id, 'the serving device reported the helper connected');

  // a request streams: thinking then answer, the simulated text, with the helper's share and the engine's timing
  const answer = await readAnswer(here('../answer.txt'));
  const first = await ask(session.id, 'What is a helper device for?\nSecond line.');
  const promptTokens = tokens('What is a helper device for?\nSecond line.').length;
  const fill = (text: string) => text.replaceAll('{prompt_tokens}', String(promptTokens)).replaceAll('{prompt_start}', 'What is a helper device for?');
  assert.equal(first.request.prompt_tokens, promptTokens);
  const text = (segment: string) => first.chunks.filter((c) => c.segment === segment).map((c) => c.text).join('');
  assert.equal(text('think'), fill(answer.think));
  assert.equal(text('answer'), fill(answer.answer));
  assert.match(text('answer'), /^This is simulated output\. No model ran/);
  assert.ok(first.chunks.length > 3 && first.chunks.every((c) => c.token_count >= 1 && c.token_count <= 32), 'the output comes in several chunks of at most 32 tokens');
  const total = tokens(fill(answer.think)).length + tokens(fill(answer.answer)).length;
  assert.equal(first.request.output_tokens, String(total));
  assert.equal(first.request.engine_end.reason, 'eos');
  assert.equal(first.request.statistics.think_end_position, String(promptTokens + tokens(fill(answer.think)).length));
  // the helper wrote its configured share of the tokens (0.55 in devices.json)
  assert.equal(first.request.statistics.accepted_external_tokens, String(Math.round(total * 0.55)));
  assert.equal(first.request.archive_state, 'saved');
  assert.equal(first.result.text, fill(answer.think) + fill(answer.answer));
  assert.ok(first.decode > 800, `with the helper the request decodes near 1600 tokens/s, got ${first.decode}`);

  // a requested budget is kept exactly, and ends the output for its length
  const { request: capped } = await ok(201, `/api/v1/sessions/${session.id}/requests`, 'POST', { prompt: 'short', max_output_tokens: 20 }, { 'idempotency-key': randomUUID() });
  const short = await until(`/api/v1/requests/${capped.id}`, (r) => r.state === 'completed', 'capped request');
  assert.deepEqual([short.effective_max_output, short.output_tokens, short.engine_end.reason], [20, '20', 'length']);

  // `leave gpu`: the serving device reports the helper gone, the session is degraded, and a request runs at the speed alone
  await fleet.command('leave gpu');
  await until(`/api/v1/sessions/${session.id}`, (s) => s.state === 'degraded', 'degraded after the helper left');
  const alone = await ask(session.id, 'Again, without the helper.');
  assert.equal(alone.request.statistics.accepted_external_tokens, '0');
  assert.ok(alone.decode < 600, `alone the request decodes near 400 tokens/s, got ${alone.decode}`);

  // `join gpu`, then "Reconnect helper": the old helper instance is stopped, a new one starts, the session is ready again
  await fleet.command('join gpu');
  await until(`/api/v1/devices/${ids.gpu}`, (d) => d.reconciled_at !== null && d.state === 'occupied', 'gpu back');
  await ok(202, `/api/v1/sessions/${session.id}/helpers/${ids.gpu}/reconnect`, 'POST', {});
  const recovered = await until(`/api/v1/sessions/${session.id}`, (s) => s.state === 'ready', 'ready after the helper returned');
  assert.equal(Math.max(...recovered.instances.filter((i: Json) => i.device_id === ids.gpu).map((i: Json) => i.generation)), 2);
  const again = await ask(session.id, 'And with the helper again.');
  assert.ok(Number(again.request.statistics.accepted_external_tokens) > 0);
  assert.ok(again.decode > 800, `with the helper back the request decodes near 1600 tokens/s, got ${again.decode}`);

  // Stop session: both devices stop their instances and are free again
  await ok(202, `/api/v1/sessions/${session.id}/stop`, 'POST', {});
  const ended = await until(`/api/v1/sessions/${session.id}`, (s) => s.state === 'ended' || s.state === 'failed', 'session ended');
  assert.equal(ended.state, 'ended');
  for (const name of ['mac', 'gpu']) await until(`/api/v1/devices/${ids[name]}`, (d) => d.state === 'idle' && d.reservation === null, `${name} idle`);
});

test('--seed makes a demo account, enrols every described device into it, and shows the password once', async () => {
  const options = { url: origin, ca: certificate, answer: await readAnswer(here('../answer.txt')) };
  const seeded = new Fleet(await fastDevices(), options);
  try {
    const said = await seeded.seed('demo@example.test');
    const password = /^Demo account \(its password is shown only now\): demo@example\.test  password: (\S{16,})$/m.exec(said)?.[1];
    assert.ok(password, said);
    // a person signs in with it and finds the devices, named as devices.json titles them
    const login = await call('/api/v1/auth/login', 'POST', { email: 'demo@example.test', password }, { origin });
    assert.equal(login.status, 200, JSON.stringify(login.body));
    const snapshot = await call('/api/v1/snapshot', 'GET', undefined, { cookie: login.headers['set-cookie'][0].split(';', 1)[0] });
    assert.deepEqual(snapshot.body.devices.map((d: Json) => [d.name, d.state]).sort(), [['GPU helper (simulated)', 'idle'], ['Mac (simulated)', 'idle']]);
    // seeding again has nothing to do; a simulator that lost its devices cannot take the account over
    assert.equal(await seeded.seed('demo@example.test'), '');
    const other = new Fleet(await fastDevices(), options);
    assert.match(await other.seed('demo@example.test'), /^The account demo@example\.test exists already/);
    other.close();
  } finally { seeded.close(); }
});

// `npm run demo` serves at localOrigin, and `npm run devices` looks for the server there: the same rule for both.
test('the simulator looks for the server where the demo serves: the port of PORT, unless an address is given', async () => {
  assert.equal(localOrigin({}), 'https://localhost:8443');
  assert.equal(localOrigin({ PORT: '18443' }), 'https://localhost:18443');
  assert.equal(localOrigin({ PORT: '18443', OPENINFER_ORIGIN: 'https://demo.example.test' }), 'https://demo.example.test');
  // the program itself: with PORT alone it names that port; --url wins over both
  const program = (args: string[], env: Record<string, string>) => new Promise<string>((resolve, reject) => {
    const child = spawn(process.execPath, ['--import', 'tsx', fileURLToPath(here('../src/main.ts')), '--cert', `${directory}/tls.crt`, '--state', `${directory}/none.json`, ...args],
      { cwd: fileURLToPath(here('..')), env: { PATH: process.env.PATH ?? '', ...env }, stdio: ['ignore', 'pipe', 'pipe'] });
    let output = '';
    const read = (chunk: Buffer) => { output += chunk; const line = /^Simulated devices for (\S+)\./m.exec(output); if (line) { child.kill(); resolve(line[1]); } };
    child.stdout.on('data', read); child.stderr.on('data', read);
    child.on('close', () => reject(new Error(`the simulator ended without naming its server:\n${output}`)));
  });
  assert.equal(await program([], { PORT: '18443' }), 'https://localhost:18443');
  assert.equal(await program([], {}), 'https://localhost:8443');
  assert.equal(await program(['--url', 'https://127.0.0.1:9'], { PORT: '18443', OPENINFER_ORIGIN: 'https://demo.example.test' }), 'https://127.0.0.1:9');
});

test('the terminal says what it does not understand, and lists the devices', async () => {
  assert.match(await fleet.command('leave printer'), /No simulated device is called printer; there are mac, gpu/);
  assert.match(await fleet.command('enroll mac'), /^Usage: enroll <device> <token>/);
  assert.match(await fleet.command('dance'), /^Unknown command "dance"/);
  assert.match(await fleet.command('help'), /enroll <device> <token>.*\n.*leave <device>.*\n.*join <device>.*\n.*fail <device>/);
  assert.match(await fleet.command('list'), /^mac +serving device +enrolled, connected +no instance\ngpu +helper +enrolled, connected +no instance$/);
});

test('the serving device drops off mid-request and returns: the output it kept is replayed and the request completes', { timeout: 120_000 }, async () => {
  const devices = (await ok(200, '/api/v1/snapshot')).devices as Json[];
  const mac = devices.find((d) => d.name === 'my mac')!;
  const preflight = await ok(200, '/api/v1/sessions/preflight', 'POST', { service_device_id: mac.id, service_version_id: 'demo-serve-4bit', helpers: [] });
  assert.equal(preflight.allowed, true, JSON.stringify(preflight.checks.filter((c: Json) => !c.passed)));
  const { session } = await ok(201, '/api/v1/sessions', 'POST', preflight.plan, { 'idempotency-key': randomUUID() });
  await until(`/api/v1/sessions/${session.id}`, (s) => s.state === 'ready', 'session of the Mac alone');
  const { request } = await ok(201, `/api/v1/sessions/${session.id}/requests`, 'POST', { prompt: 'keep going' }, { 'idempotency-key': randomUUID() });
  await until(`/api/v1/requests/${request.id}`, (r) => Number(r.output_tokens) > 20, 'some output');
  await fleet.command('leave mac');
  await new Promise((resolve) => setTimeout(resolve, 300));
  const during = await ok(200, `/api/v1/requests/${request.id}`);
  assert.equal(during.state, 'running');
  await fleet.command('join mac');
  const done = await until(`/api/v1/requests/${request.id}`, (r) => r.state === 'completed', 'request completed after the return');
  const answer = await readAnswer(here('../answer.txt'));
  assert.equal(done.output_tokens, String(tokens(answer.think).length + tokens(answer.answer.replaceAll('{prompt_start}', 'keep going')).length));
  assert.equal((await until(`/api/v1/sessions/${session.id}`, (s) => !s.submissions_blocked, 'session resumed')).state, 'ready');

  // `fail mac`: the engine of the serving device dies; the session fails and the device is cleaned up and free again
  await fleet.command('fail mac');
  const failed = await until(`/api/v1/sessions/${session.id}`, (s) => s.state === 'failed' || s.state === 'ended', 'session failed');
  assert.deepEqual([failed.state, failed.stop_cause], ['failed', 'service_failure']);
  await until(`/api/v1/devices/${mac.id}`, (d) => d.state === 'idle' && d.reservation === null, 'the Mac cleaned up and idle');
});
