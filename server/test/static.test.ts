import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import https from 'node:https';
import { promisify } from 'node:util';
import { after, before, test } from 'node:test';

import { ControlPlane } from '../src/control.js';
import { createServer } from '../src/server.js';
import { MemoryObjectStore } from '../src/storage.js';
import { fixtureCatalog } from './fixtures.js';
import { createDatabase } from './postgres.js';

// The browser's static files come from the same Express HTTPS server.
const run = promisify(execFile);
const origin = 'https://control.example.test';
const page = '<!doctype html><title>OpenInfer</title><div id="root"></div>';
let directory: string;
let certificate: Buffer;
let database: Awaited<ReturnType<typeof createDatabase>>;
let handle: ReturnType<typeof createServer>;
let port: number;

function get(path: string): Promise<{ status: number; type: string; body: string }> {
  return new Promise((resolve, reject) => {
    https.get({ host: '127.0.0.1', port, path, ca: certificate, servername: 'localhost', headers: { host: `localhost:${port}` } }, (response) => {
      const chunks: Buffer[] = [];
      response.on('data', (chunk: Buffer) => chunks.push(chunk));
      response.on('end', () => resolve({ status: response.statusCode ?? 0, type: String(response.headers['content-type'] ?? ''), body: Buffer.concat(chunks).toString('utf8') }));
    }).on('error', reject);
  });
}

before(async () => {
  directory = await mkdtemp('/tmp/openinfer-static-test-');
  await run('openssl', ['req', '-x509', '-newkey', 'rsa:2048', '-nodes', '-days', '1', '-subj', '/CN=localhost', '-addext', 'subjectAltName=DNS:localhost',
    '-keyout', `${directory}/tls.key`, '-out', `${directory}/tls.crt`]);
  certificate = await readFile(`${directory}/tls.crt`);
  const web = `${directory}/web`;
  await mkdir(`${web}/assets`, { recursive: true });
  await writeFile(`${web}/index.html`, page);
  await writeFile(`${web}/assets/app.js`, 'console.log(1);');
  database = await createDatabase();
  const plane = new ControlPlane(database.pool, new MemoryObjectStore(), fixtureCatalog());
  handle = createServer(plane, { key: await readFile(`${directory}/tls.key`), cert: certificate, origin, webRoot: web });
  handle.server.listen(0, '127.0.0.1');
  await new Promise((resolve) => handle.server.once('listening', resolve));
  const address = handle.server.address();
  assert.ok(address && typeof address === 'object');
  port = address.port;
});

after(async () => {
  await handle.close();
  await database.close();
  await rm(directory, { recursive: true, force: true });
});

test('the HTTPS server serves the web build and keeps the API behind authentication', async () => {
  const index = await get('/');
  assert.equal(index.status, 200);
  assert.match(index.type, /text\/html/);
  assert.equal(index.body, page);
  const script = await get('/assets/app.js');
  assert.equal(script.status, 200);
  assert.match(script.type, /javascript/);
  const api = await get('/api/v1/catalog');
  assert.equal(api.status, 401);
  assert.equal(JSON.parse(api.body).error.code, 'unauthenticated');
  const missing = await get('/assets/none.js');
  assert.equal(missing.status, 404);
  assert.equal(JSON.parse(missing.body).error.code, 'not_found');
});

test('createServer passes registration: closed to the register route', async () => {
  const plane = new ControlPlane(database.pool, new MemoryObjectStore(), fixtureCatalog());
  const closed = createServer(plane, { key: await readFile(`${directory}/tls.key`), cert: certificate, origin, registration: 'closed' });
  closed.server.listen(0, '127.0.0.1');
  await new Promise((resolve) => closed.server.once('listening', resolve));
  const address = closed.server.address();
  assert.ok(address && typeof address === 'object');
  try {
    const body = JSON.stringify({ email: 'closed@example.test', password: randomBytes(18).toString('base64url') });
    const reply = await new Promise<{ status: number; body: string }>((resolve, reject) => {
      const req = https.request({ host: '127.0.0.1', port: address.port, path: '/api/v1/auth/register', method: 'POST', ca: certificate, servername: 'localhost',
        headers: { host: `localhost:${address.port}`, origin, 'content-type': 'application/json', 'content-length': Buffer.byteLength(body) } }, (response) => {
        const chunks: Buffer[] = [];
        response.on('data', (chunk: Buffer) => chunks.push(chunk));
        response.on('end', () => resolve({ status: response.statusCode ?? 0, body: Buffer.concat(chunks).toString('utf8') }));
      }).on('error', reject);
      req.end(body);
    });
    assert.equal(reply.status, 403);
    assert.equal(JSON.parse(reply.body).error.code, 'registration_closed');
    const users = await database.pool.query('SELECT count(*)::int AS n FROM users WHERE email = $1', ['closed@example.test']);
    assert.equal(users.rows[0].n, 0);
  } finally {
    await closed.close();
  }
});
