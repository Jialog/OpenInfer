// Files: a signed-in user uploads a prompt as a .txt or .md file, a request takes its prompt from the stored file, and both
// the file and the request's result can be downloaded again. The objects go through the object store (in memory here).
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { createHash, randomBytes, randomUUID } from 'node:crypto';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import https from 'node:https';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, before, test } from 'node:test';
import { promisify } from 'node:util';

import { ControlPlane } from '../src/control.ts';
import { createServer } from '../src/server.ts';
import { MemoryObjectStore } from '../src/storage.ts';
import { fixtureCatalog, sendOutput, setupPair, startSession } from './fixtures.ts';
import { createDatabase } from './postgres.ts';

type Reply = { status: number; headers: Record<string, any>; bytes: Buffer; json: any };
const origin = 'https://control.example.test';
// A store whose writes can be made to fail, as a bucket that cannot be reached.
class Store extends MemoryObjectStore {
  down = false;
  override async put(key: string, body: Buffer) { if (this.down) throw new Error('unreachable'); await super.put(key, body); }
  override async get(key: string) { if (this.down) throw new Error('unreachable'); return super.get(key); }
}
let database: Awaited<ReturnType<typeof createDatabase>>;
let directory: string, certificate: Buffer, privateKey: Buffer, plane: ControlPlane, handle: ReturnType<typeof createServer>, port: number;
const store = new Store();

function call(path: string, method = 'GET', body?: Buffer | object, headers: Record<string, string> = {}, at = port): Promise<Reply> {
  const raw = Buffer.isBuffer(body), bytes = body === undefined ? undefined : raw ? body : Buffer.from(JSON.stringify(body));
  return new Promise((resolve, reject) => {
    const request = https.request({ host: '127.0.0.1', port: at, path, method, ca: certificate, servername: 'localhost',
      headers: { ...(bytes ? { 'content-type': raw ? 'text/plain' : 'application/json', 'content-length': String(bytes.length) } : {}), ...headers } }, (response) => {
      const chunks: Buffer[] = [];
      response.on('data', (chunk: Buffer) => chunks.push(chunk));
      response.on('end', () => { const all = Buffer.concat(chunks); let json: any = null; try { json = JSON.parse(all.toString('utf8')); } catch { /* a file */ } resolve({ status: response.statusCode ?? 0, headers: response.headers, bytes: all, json }); });
    });
    request.on('error', reject);
    if (bytes) request.write(bytes);
    request.end();
  });
}
async function register() {
  const reply = await call('/api/v1/auth/register', 'POST', { email: `${randomUUID()}@example.test`, password: randomBytes(18).toString('base64url') }, { origin });
  assert.equal(reply.status, 201, reply.bytes.toString());
  return { user: { user_id: reply.json.user_id, group_id: reply.json.group_id }, browser: { cookie: String(reply.headers['set-cookie'][0]).split(';', 1)[0], origin, 'x-csrf-token': reply.json.csrf_token } };
}
const upload = (browser: Record<string, string>, name: string, bytes: Buffer, headers: Record<string, string> = {}) => call(`/api/v1/files?name=${encodeURIComponent(name)}`, 'POST', bytes, { ...browser, ...headers });

before(async () => {
  directory = await mkdtemp(join(tmpdir(), 'files-test-'));
  await promisify(execFile)('openssl', ['req', '-x509', '-newkey', 'ec', '-pkeyopt', 'ec_paramgen_curve:P-256', '-nodes', '-days', '1',
    '-subj', '/CN=localhost', '-addext', 'subjectAltName=DNS:localhost,IP:127.0.0.1', '-keyout', `${directory}/tls.key`, '-out', `${directory}/tls.crt`]);
  const [key, cert] = await Promise.all([readFile(`${directory}/tls.key`), readFile(`${directory}/tls.crt`)]);
  certificate = cert; privateKey = key;
  database = await createDatabase();
  plane = new ControlPlane(database.pool, store, fixtureCatalog());
  handle = createServer(plane, { key, cert, origin, tickIntervalMs: 25 });
  await new Promise<void>((resolve) => handle.server.listen(0, '127.0.0.1', resolve));
  port = (handle.server.address() as { port: number }).port;
});
after(async () => { handle.server.closeAllConnections(); await handle.close(); await database.close(); await rm(directory, { recursive: true, force: true }); });

test('an uploaded prompt file is stored in the bucket, recorded for its user, and downloads as it was', async () => {
  const { user, browser } = await register();
  const bytes = Buffer.from('# Question\n\nWhy is the sky blue? ☁️\n');
  const reply = await upload(browser, 'my question.md', bytes);
  assert.equal(reply.status, 201, reply.bytes.toString());
  const file = reply.json.file;
  assert.deepEqual(Object.keys(file).sort(), ['content_type', 'created_at', 'id', 'name', 'sha256', 'size_bytes']);
  assert.deepEqual([file.name, file.content_type, file.size_bytes, file.sha256], ['my question.md', 'text/markdown', bytes.length, createHash('sha256').update(bytes).digest('hex')]);
  // the object is in the store under files/{id}; the row names its user, its group and that object
  assert.deepEqual(await store.get(`files/${file.id}`), bytes);
  const row = (await database.pool.query('SELECT * FROM files WHERE id=$1', [file.id])).rows[0];
  assert.deepEqual([row.user_id, row.group_id, row.object_key, row.size_bytes], [user.user_id, user.group_id, `files/${file.id}`, bytes.length]);
  // the download: the same bytes, as an attachment under its name
  const download = await call(`/api/v1/files/${file.id}/content`, 'GET', undefined, { cookie: browser.cookie });
  assert.equal(download.status, 200);
  assert.deepEqual(download.bytes, bytes);
  assert.equal(download.headers['content-type'], 'text/markdown; charset=utf-8');
  assert.equal(download.headers['content-disposition'], 'attachment; filename="my question.md"');
  assert.equal(download.headers['x-content-type-options'], 'nosniff');
  // a .txt file is plain text
  const text = await upload(browser, 'notes.TXT', Buffer.from('plain'));
  assert.deepEqual([text.status, text.json.file.content_type], [201, 'text/plain']);
});

test('only a signed-in user uploads, and only a small text file with a .txt or .md name', async () => {
  const { browser } = await register();
  const fine = Buffer.from('hello');
  const refused = async (reply: Promise<Reply>, status: number, code: string, field: string | null = null) => {
    const r = await reply;
    assert.deepEqual([r.status, r.json?.error?.code, r.json?.error?.field ?? null], [status, code, field], r.bytes.toString().slice(0, 300));
    return r.json.error;
  };
  await refused(call('/api/v1/files?name=a.txt', 'POST', fine, { origin }), 401, 'unauthenticated');
  await refused(call('/api/v1/files?name=a.txt', 'POST', fine, { cookie: browser.cookie, origin }), 403, 'forbidden');   // no CSRF token
  assert.match((await refused(upload(browser, 'slides.pdf', fine), 400, 'invalid_input', 'name')).message, /\.txt or \.md/);
  await refused(upload(browser, '.md', fine), 400, 'invalid_input', 'name');
  await refused(upload(browser, '../up.txt', fine), 400, 'invalid_input', 'name');
  await refused(call('/api/v1/files', 'POST', fine, browser), 400, 'invalid_input', 'name');
  await refused(upload(browser, `${'n'.repeat(252)}.txt`, fine), 400, 'invalid_input', 'name');
  assert.match((await refused(upload(browser, 'empty.txt', Buffer.alloc(0)), 400, 'invalid_input', 'file')).message, /empty/);
  assert.match((await refused(upload(browser, 'blank.txt', Buffer.from(' \n\t')), 400, 'invalid_input', 'file')).message, /empty/);
  assert.match((await refused(upload(browser, 'binary.txt', Buffer.from([0xff, 0xfe, 0x00, 0x41])), 400, 'invalid_input', 'file')).message, /UTF-8/);
  // 65536 bytes is the largest prompt; one more byte is too large
  assert.equal((await upload(browser, 'largest.txt', Buffer.alloc(65536, 'a'))).status, 201);
  await refused(upload(browser, 'large.txt', Buffer.alloc(65537, 'a')), 413, 'invalid_input');
  // JSON is not a file upload
  await refused(call('/api/v1/files?name=a.txt', 'POST', { text: 'hello' }, browser), 400, 'invalid_input', 'file');
  // nothing refused left a record
  assert.deepEqual((await database.pool.query('SELECT name FROM files WHERE user_id=(SELECT user_id FROM files WHERE name=$1)', ['largest.txt'])).rows.map((r) => r.name), ['largest.txt']);
});

test('a file belongs to its group: another user cannot download it or use it, and an unknown file is not found', async () => {
  const owner = await register(), other = await register();
  const file = (await upload(owner.browser, 'mine.txt', Buffer.from('private prompt'))).json.file;
  assert.equal((await call(`/api/v1/files/${file.id}/content`, 'GET', undefined, { cookie: other.browser.cookie })).status, 403);
  assert.equal((await call(`/api/v1/files/${file.id}/content`, 'GET', undefined, {})).status, 401);
  assert.equal((await call(`/api/v1/files/${randomUUID()}/content`, 'GET', undefined, { cookie: owner.browser.cookie })).status, 404);
  const pair = await setupPair(plane, database.pool, other.user);
  const session = await startSession(plane, pair);
  const stolen = await call(`/api/v1/sessions/${session.id}/requests`, 'POST', { prompt_file_id: file.id }, { ...other.browser, 'idempotency-key': randomUUID() });
  assert.deepEqual([stolen.status, stolen.json.error.code], [403, 'forbidden']);
  const missing = await call(`/api/v1/sessions/${session.id}/requests`, 'POST', { prompt_file_id: randomUUID() }, { ...other.browser, 'idempotency-key': randomUUID() });
  assert.deepEqual([missing.status, missing.json.error.code], [404, 'not_found']);
  assert.equal((await database.pool.query('SELECT count(*)::int AS n FROM requests WHERE session_id=$1', [session.id])).rows[0].n, 0);
});

test('a request takes its prompt from an uploaded file, keeps a link to it, and its result downloads as a file', async () => {
  const { user, browser } = await register();
  const pair = await setupPair(plane, database.pool, user);
  const session = await startSession(plane, pair);
  const text = 'Summarise this file in one line.\nSecond line.';
  const file = (await upload(browser, 'task.txt', Buffer.from(text))).json.file;
  const submit = (body: object) => call(`/api/v1/sessions/${session.id}/requests`, 'POST', body, { ...browser, 'idempotency-key': randomUUID() });
  // a request names one source of its prompt
  assert.equal((await submit({ prompt: 'typed', prompt_file_id: file.id })).status, 400);
  const created = await submit({ prompt_file_id: file.id, max_output_tokens: 2 });
  assert.equal(created.status, 201, created.bytes.toString());
  const request = created.json.request;
  // the serving device is sent the file's text, read back from the store
  const command = pair.commands.find((c: any) => c.kind === 'run_request' && c.request_id === request.id);
  assert.deepEqual(command.payload.input, { kind: 'text', prompt: text });
  // the request row points at the file, and the request as the website reads it names it
  assert.equal((await database.pool.query('SELECT prompt_file_id FROM requests WHERE id=$1', [request.id])).rows[0].prompt_file_id, file.id);
  assert.deepEqual(request.prompt_file, { id: file.id, name: 'task.txt', size_bytes: Buffer.byteLength(text) });
  assert.equal(request.input.prompt, text);
  const listed = await call(`/api/v1/sessions/${session.id}/requests`, 'GET', undefined, { cookie: browser.cookie });
  assert.deepEqual(listed.json.requests[0].prompt_file, { id: file.id, name: 'task.txt', size_bytes: Buffer.byteLength(text) });
  // a typed request has no file
  await sendOutput(plane, pair, request);
  const typed = (await submit({ prompt: 'typed' })).json.request;
  assert.equal(typed.prompt_file, null);

  // the finished request's result is the object the server saved, and downloads as a JSON file named after the request
  const saved = await call(`/api/v1/requests/${request.id}`, 'GET', undefined, { cookie: browser.cookie });
  assert.deepEqual([saved.json.state, saved.json.archive_state], ['completed', 'saved']);
  const result = await call(`/api/v1/requests/${request.id}/result?download=1`, 'GET', undefined, { cookie: browser.cookie });
  assert.equal(result.status, 200);
  assert.equal(result.headers['content-disposition'], `attachment; filename=request-${request.id}.json`);
  assert.deepEqual(result.bytes, await store.get(`requests/${request.id}.json`));
  assert.deepEqual([result.json.text, result.json.input.prompt, result.json.prompt_file_id], ['AB', text, file.id]);
  // without ?download the route answers as before
  const plain = await call(`/api/v1/requests/${request.id}/result`, 'GET', undefined, { cookie: browser.cookie });
  assert.equal(plain.headers['content-disposition'], undefined);
  assert.equal(plain.json.text, 'AB');
});

test('the website is told where the objects are kept: the memory of this process, or a bucket', async () => {
  const { user } = await register();
  assert.equal((await plane.snapshot(user)).storage, 'memory');
  // any other store is a bucket
  const bucket = new ControlPlane(database.pool, { put: (key, body) => store.put(key, body), get: (key) => store.get(key) }, fixtureCatalog());
  assert.equal((await bucket.snapshot(user)).storage, 'bucket');
});

test('after a restart without a bucket the records remain and the objects are gone: a download says so, and is not a server fault', async () => {
  const { user, browser } = await register();
  const pair = await setupPair(plane, database.pool, user);
  const session = await startSession(plane, pair);
  const file = (await upload(browser, 'kept-in-memory.txt', Buffer.from('a prompt'))).json.file;
  const key = randomUUID();
  const request = (await call(`/api/v1/sessions/${session.id}/requests`, 'POST', { prompt_file_id: file.id }, { ...browser, 'idempotency-key': key })).json.request;
  await sendOutput(plane, pair, request);
  assert.equal((await call(`/api/v1/requests/${request.id}/result`, 'GET', undefined, { cookie: browser.cookie })).status, 200);
  // the restart: the same database, a new process with nothing in its memory
  const restarted = createServer(new ControlPlane(database.pool, new MemoryObjectStore(), fixtureCatalog()), { key: privateKey, cert: certificate, origin, tickIntervalMs: 3_600_000 });
  await new Promise<void>((resolve) => restarted.server.listen(0, '127.0.0.1', resolve));
  try {
    const at = (restarted.server.address() as { port: number }).port;
    for (const [path, what] of [[`/api/v1/files/${file.id}/content`, 'file'], [`/api/v1/requests/${request.id}/result?download=1`, 'result'], [`/api/v1/requests/${request.id}/result`, 'result']]) {
      const reply = await call(path, 'GET', undefined, { cookie: browser.cookie }, at);
      assert.deepEqual([reply.status, reply.json.error.code, reply.json.error.retryable], [410, 'not_stored', false], path);
      assert.equal(reply.json.error.message, `This ${what} is no longer stored. No bucket is configured, so it was kept in the memory of the server process and was lost when the server restarted.`);
      assert.equal(reply.headers['content-disposition'], undefined);
    }
    // the first call repeated, with its body and its key, still answers with the request it made: nothing is read again
    const repeated = await call(`/api/v1/sessions/${session.id}/requests`, 'POST', { prompt_file_id: file.id }, { ...browser, 'idempotency-key': key }, at);
    assert.deepEqual([repeated.status, repeated.json.request?.id, repeated.json.request?.state], [201, request.id, 'completed'], repeated.bytes.toString().slice(0, 300));
    // a new request cannot take its prompt from a file that is gone
    const again = await call(`/api/v1/sessions/${session.id}/requests`, 'POST', { prompt_file_id: file.id }, { ...browser, 'idempotency-key': randomUUID() }, at);
    assert.deepEqual([again.status, again.json.error.code], [410, 'not_stored']);
  } finally { restarted.server.closeAllConnections(); await restarted.close(); }
});

test('an object a bucket no longer has is not stored either, said without the part about memory', async () => {
  const { user, browser } = await register();
  const file = (await upload(browser, 'in-a-bucket.txt', Buffer.from('a prompt'))).json.file;
  // a store that is not this process's memory and has lost the object, as S3 reports a missing key
  const emptied = new ControlPlane(database.pool, { put: async () => {}, get: async (key) => { throw Object.assign(new Error(`The specified key does not exist: ${key}`), { name: 'NoSuchKey' }); } }, fixtureCatalog());
  await assert.rejects(emptied.getFile(user, file.id), (error: any) => error.status === 410 && error.code === 'not_stored' && error.body().message === 'This file is no longer stored.');
});

test('an upload the bucket does not take is refused and leaves no record', async () => {
  const { browser } = await register();
  store.down = true;
  try {
    const reply = await upload(browser, 'lost.txt', Buffer.from('never stored'));
    assert.deepEqual([reply.status, reply.json.error.code, reply.json.error.retryable], [502, 'file_store_failed', true]);
    assert.match(reply.json.error.message, /could not be saved/);
  } finally { store.down = false; }
  assert.equal((await database.pool.query("SELECT count(*)::int AS n FROM files WHERE name='lost.txt'")).rows[0].n, 0);
  // a stored file the bucket does not give back: the download says so and can be tried again
  const kept = (await upload(browser, 'kept.txt', Buffer.from('stored'))).json.file;
  store.down = true;
  try {
    const reply = await call(`/api/v1/files/${kept.id}/content`, 'GET', undefined, { cookie: browser.cookie });
    assert.deepEqual([reply.status, reply.json.error.code, reply.json.error.retryable], [502, 'file_store_failed', true]);
  } finally { store.down = false; }
});
