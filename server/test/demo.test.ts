// `npm run demo` (src/demo.ts): on an empty directory it makes a certificate and a database of its own, starts the server
// with the simulated catalogue, and keeps both for the next start.
import assert from 'node:assert/strict';
import { spawn, type ChildProcess } from 'node:child_process';
import { randomBytes, randomUUID, X509Certificate } from 'node:crypto';
import { mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises';
import https from 'node:https';
import net from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, before, test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { WebSocket } from 'ws';
import { inventory } from './fixtures.ts';

let data: string, web: string, port: number, databasePort: number;
const children: ChildProcess[] = [];

async function freePort(): Promise<number> {
  const listener = net.createServer();
  await new Promise<void>((resolve) => listener.listen(0, '127.0.0.1', resolve));
  const { port } = listener.address() as net.AddressInfo;
  await new Promise<void>((resolve) => listener.close(() => resolve()));
  return port;
}
// Starts the demo as `npm run demo` does, without a bucket or a database of the user's; resolves when it listens.
async function start(): Promise<{ child: ChildProcess; output: () => string; exited: Promise<number | null> }> {
  const env: NodeJS.ProcessEnv = { ...process.env, DEMO_DATA_DIR: data, PORT: String(port), DEMO_DATABASE_PORT: String(databasePort), OPENINFER_WEB_DIR: web };
  for (const name of Object.keys(env)) if (name.startsWith('S3_') || name === 'DATABASE_URL' || name === 'NODE_TEST_CONTEXT') delete env[name];
  const child = spawn(process.execPath, ['--import', 'tsx', fileURLToPath(new URL('../src/demo.ts', import.meta.url))], { cwd: fileURLToPath(new URL('..', import.meta.url)), env, stdio: ['ignore', 'pipe', 'pipe'] });
  children.push(child);
  let output = '';
  const exited = new Promise<number | null>((resolve) => child.on('close', (code) => resolve(code)));
  await new Promise<void>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`the demo did not start listening:\n${output}`)), 90_000);
    const read = (chunk: Buffer) => { output += chunk; if (/is listening/.test(output)) { clearTimeout(timer); resolve(); } };
    child.stdout!.on('data', read); child.stderr!.on('data', read);
    void exited.then((code) => { clearTimeout(timer); reject(new Error(`the demo exited with ${code}:\n${output}`)); });
  });
  return { child, output: () => output, exited };
}
async function call(path: string, method = 'GET', body?: unknown, headers: Record<string, string> = {}) {
  const ca = await readFile(join(data, 'tls.crt')), bytes = body === undefined ? undefined : Buffer.from(JSON.stringify(body));
  return new Promise<{ status: number; headers: Record<string, any>; text: string }>((resolve, reject) => {
    const request = https.request({ host: '127.0.0.1', port, path, method, ca, servername: 'localhost',
      headers: { ...(bytes ? { 'content-type': 'application/json', 'content-length': String(bytes.length) } : {}), ...headers } }, (response) => {
      const chunks: Buffer[] = [];
      response.on('data', (chunk: Buffer) => chunks.push(chunk));
      response.on('end', () => resolve({ status: response.statusCode ?? 0, headers: response.headers, text: Buffer.concat(chunks).toString('utf8') }));
    });
    request.on('error', reject);
    if (bytes) request.write(bytes);
    request.end();
  });
}

before(async () => {
  data = await mkdtemp(join(tmpdir(), 'demo-data-'));
  web = await mkdtemp(join(tmpdir(), 'demo-web-'));
  await writeFile(join(web, 'index.html'), '<!doctype html><title>the built website</title>');
  port = await freePort(); databasePort = await freePort();
});
after(async () => {
  for (const child of children) if (child.exitCode === null) child.kill('SIGKILL');
  await rm(data, { recursive: true, force: true }); await rm(web, { recursive: true, force: true });
});

test('the demo starts from nothing, serves the website and the simulated catalogue, and keeps its accounts and certificate for the next start', { timeout: 240_000 }, async () => {
  const origin = `https://localhost:${port}`, account = { email: 'grader@example.test', password: randomBytes(18).toString('base64url') };
  const first = await start();
  // what it made: a certificate for this machine, and a database only this user can read
  const certificate = new X509Certificate(await readFile(join(data, 'tls.crt')));
  assert.match(certificate.subjectAltName ?? '', /DNS:localhost/);
  assert.match(certificate.subjectAltName ?? '', /IP Address:127\.0\.0\.1/);
  for (const file of ['tls.key', 'postgres-password']) assert.equal((await stat(join(data, file))).mode & 0o077, 0, `${file} is readable by its owner only`);
  assert.ok((await stat(join(data, 'postgres', 'PG_VERSION'))).isFile());
  // without a bucket it says where both kinds of object are kept
  assert.match(first.output(), /No bucket is configured \(S3_ENDPOINT\): uploaded prompt files and request results are kept in the memory of this server process and are lost when it stops\./);
  assert.match(first.output(), new RegExp(`Open ${origin}`));
  // the website, and behind a new account the simulated catalogue
  const page = await call('/');
  assert.deepEqual([page.status, page.text.includes('the built website')], [200, true]);
  const registered = await call('/api/v1/auth/register', 'POST', account, { origin });
  assert.equal(registered.status, 201, registered.text);
  const catalog = await call('/api/v1/catalog', 'GET', undefined, { cookie: registered.headers['set-cookie'][0].split(';', 1)[0] });
  assert.deepEqual(JSON.parse(catalog.text).versions.map((v: { id: string }) => v.id), ['demo-serve-4bit', 'demo-help-8bit', 'demo-help-4bit']);
  // Ctrl-C stops the server and its database
  first.child.kill('SIGINT');
  assert.equal(await first.exited, 130, first.output());   // 128 + SIGINT, once the database has stopped
  await assert.rejects(new Promise((resolve, reject) => { const socket = net.connect(databasePort, '127.0.0.1'); socket.on('connect', resolve); socket.on('error', reject); }), 'the database stopped with the demo');

  // the next start finds the same account and certificate
  const second = await start();
  assert.equal(new X509Certificate(await readFile(join(data, 'tls.crt'))).fingerprint256, certificate.fingerprint256);
  const login = await call('/api/v1/auth/login', 'POST', account, { origin });
  assert.equal(login.status, 200);
  // Ctrl-C with devices connected: the server records their disconnection while its database is stopping, and still ends
  // as a stopped demo does, not as a crash
  const browser = { cookie: login.headers['set-cookie'][0].split(';', 1)[0], origin, 'x-csrf-token': JSON.parse(login.text).csrf_token };
  const ca = await readFile(join(data, 'tls.crt'));
  for (const role of ['service', 'helper', 'service', 'helper']) {
    const token = JSON.parse((await call('/api/v1/enrollment-tokens', 'POST', { device_name: role }, browser)).text).token;
    const credential = randomBytes(32).toString('base64url'), boot = randomUUID();
    const enrolled = JSON.parse((await call('/api/v1/device/enroll', 'POST', { enrollment_token: token, credential, agent_boot_id: boot, inventory: inventory(role) })).text);
    const socket = new WebSocket(`wss://127.0.0.1:${port}/api/v1/ws/device`, 'openinfer.device.v1', { ca, servername: 'localhost', headers: { authorization: `Bearer ${credential}`, 'x-openinfer-device-id': enrolled.device_id } } as any);
    socket.on('error', () => {});
    await new Promise<void>((resolve, reject) => {
      socket.on('message', (bytes) => { const message = JSON.parse(bytes.toString());
        if (message.type === 'hello') socket.send(JSON.stringify({ v: 1, type: 'reconcile', message_id: randomUUID(), connection_id: message.payload.connection_id, device_id: enrolled.device_id, sent_at: new Date().toISOString(),
          payload: { agent_boot_id: boot, inventory: inventory(role), instances: [], commands: [], requests: [] } }));
        if (message.type === 'reconciled') resolve(); });
      socket.on('close', () => reject(new Error('the device connection closed before it was reconciled')));
    });
  }
  second.child.kill('SIGINT');
  assert.equal(await second.exited, 130, second.output());
  assert.doesNotMatch(second.output(), /Unhandled 'error' event/);
});
