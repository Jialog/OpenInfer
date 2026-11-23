// API keys, the OpenAI-compatible /v1 routes, the answer and thinking segments of output chunks,
// cancellation when an API client goes away, the capped output budget of API requests, and the recent requests of a
// session. The devices are driven in process (fixtures.ts); every client call goes over HTTPS.
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { randomBytes, randomUUID } from 'node:crypto';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import https from 'node:https';
import { promisify } from 'node:util';
import { after, before, test as nodeTest } from 'node:test';
import { ControlPlane } from '../src/control.ts';
import { EMPTY_STATS, EMPTY_TIMING } from '../src/protocol.ts';
import express from 'express';
import { createOpenAiRouter, openAiErrors } from '../src/openai.ts';
import { createServer } from '../src/server.ts';
import { transition } from '../src/state.ts';
import { MemoryObjectStore } from '../src/storage.ts';
import { fixtureCatalog, setupPair, startSession } from './fixtures.ts';
import { createDatabase } from './postgres.ts';

type Json = Record<string, any>;
type Reply = { status: number; headers: Record<string, any>; text: string; json: any };
const origin = 'https://control.example.test';
const MODEL = 'Qwen3.8-27B';
let database: Awaited<ReturnType<typeof createDatabase>>;
let directory: string, certificate: Buffer, plane: ControlPlane, handle: ReturnType<typeof createServer>, port: number;

before(async () => {
  directory = await mkdtemp('/tmp/openinfer-user-api-');
  // A certificate as a user makes one: self-signed, for the addresses of the machine (clients verify it strictly).
  await promisify(execFile)('openssl', ['req', '-x509', '-newkey', 'ec', '-pkeyopt', 'ec_paramgen_curve:P-256', '-nodes', '-days', '825',
    '-subj', '/CN=openinfer-server', '-addext', 'subjectAltName=IP:192.0.2.10,IP:127.0.0.1',
    '-keyout', `${directory}/tls.key`, '-out', `${directory}/tls.crt`]);
  const [key, cert] = await Promise.all([readFile(`${directory}/tls.key`), readFile(`${directory}/tls.crt`)]);
  certificate = cert;
  database = await createDatabase();
  plane = new ControlPlane(database.pool, new MemoryObjectStore(), { ...fixtureCatalog(), certificatePath: `${directory}/tls.crt` });
  handle = createServer(plane, { key, cert, origin, tickIntervalMs: 25 });
  await new Promise<void>(resolve => handle.server.listen(0, '127.0.0.1', resolve));
  port = (handle.server.address() as { port: number }).port;
});
// A failed test may leave a response open; close the connections so the server can stop.
after(async () => { handle.server.closeAllConnections(); await handle.close(); await database.close(); await rm(directory, { recursive: true, force: true }); });
// A test that waits for output that never comes fails instead of hanging.
const test = (name: string, fn: () => Promise<void> | void) => nodeTest(name, { timeout: 30_000 }, fn);

function open(path: string, method: string, body: unknown, headers: Record<string, string>, at = port) {
  const bytes = body === undefined ? undefined : Buffer.from(typeof body === 'string' ? body : JSON.stringify(body));
  return https.request({ host: '127.0.0.1', port: at, path, method, ca: certificate,
    headers: { host: `127.0.0.1:${at}`, ...(bytes ? { 'content-type': 'application/json', 'content-length': String(bytes.length) } : {}), ...headers } },
  ).end(bytes);
}
function call(path: string, method = 'GET', body?: unknown, headers: Record<string, string> = {}): Promise<Reply> {
  return new Promise((resolve, reject) => {
    const req = open(path, method, body, headers);
    req.on('error', reject);
    req.on('response', res => { let text = ''; res.setEncoding('utf8'); res.on('data', x => { text += x; });
      res.on('end', () => resolve({ status: res.statusCode!, headers: res.headers, text, json: text ? JSON.parse(text) : null })); });
  });
}
/** A streamed call: the server-sent events as they arrive, a wait for one of them, and a way to hang up. */
/** call() that gives up after MS: a request that must be refused at once is not left waiting for a device. */
function callWithin(ms: number, path: string, method: string, body: unknown, headers: Record<string, string>, at = port): Promise<Reply | 'timeout'> {
  return new Promise((resolve, reject) => {
    const req = open(path, method, body, headers, at);
    const timer = setTimeout(() => { req.destroy(); resolve('timeout'); }, ms);
    req.on('error', reject);
    req.on('response', res => { let text = ''; res.setEncoding('utf8'); res.on('data', x => { text += x; });
      res.on('end', () => { clearTimeout(timer); resolve({ status: res.statusCode!, headers: res.headers, text, json: text ? JSON.parse(text) : null }); }); });
  });
}
function stream(body: Json, headers: Record<string, string>) {
  const state = { status: 0, headers: {} as Json, raw: '', events: [] as any[], ended: false, wake: [] as (() => void)[] };
  const req = open('/v1/chat/completions', 'POST', body, headers);
  req.on('error', () => {});
  req.on('response', res => {
    state.status = res.statusCode!; state.headers = res.headers; res.setEncoding('utf8');
    res.on('data', (x: string) => {
      state.raw += x;
      const blocks = state.raw.split('\n\n'); state.raw = blocks.pop()!;
      for (const block of blocks) for (const line of block.split('\n')) if (line.startsWith('data: ')) state.events.push(line === 'data: [DONE]' ? '[DONE]' : JSON.parse(line.slice(6)));
      for (const wake of state.wake.splice(0)) wake();
    });
    res.on('end', () => { state.ended = true; for (const wake of state.wake.splice(0)) wake(); });
    res.on('error', () => {});
  });
  const until = async (ok: () => boolean, label: string) => {
    const deadline = Date.now() + 5000;
    while (!ok()) {
      if (Date.now() > deadline) throw new Error(`timed out waiting for ${label}: ${JSON.stringify(state.events)}`);
      await new Promise<void>(resolve => { state.wake.push(resolve); setTimeout(resolve, 50); });
    }
  };
  return { state, until, hangUp: () => req.destroy() };
}
async function waitFor<T>(fn: () => Promise<T>, label: string, ms = 5000): Promise<T> {
  const deadline = Date.now() + ms;
  for (;;) {
    try { return await fn(); } catch (error) { if (Date.now() > deadline) throw new Error(`timed out: ${label}: ${error}`); }
    await new Promise(resolve => setTimeout(resolve, 20));
  }
}

async function register() {
  const reply = await call('/api/v1/auth/register', 'POST', { email: `${randomUUID()}@example.test`, password: randomBytes(18).toString('base64url') }, { origin });
  assert.equal(reply.status, 201, reply.text);
  const cookie = String(reply.headers['set-cookie'][0]).split(';', 1)[0];
  return { user: { user_id: reply.json.user_id, group_id: reply.json.group_id }, browser: { cookie, origin, 'x-csrf-token': reply.json.csrf_token } };
}
async function newKey(browser: Record<string, string>, name = 'script') {
  const reply = await call('/api/v1/api-keys', 'POST', { name }, browser);
  assert.equal(reply.status, 201, reply.text);
  return reply.json as { api_key: Json; secret: string };
}
const bearer = (secret: string) => ({ authorization: `Bearer ${secret}` });
/** A signed-in user with a key and a ready session on two in-process devices. */
async function ready() {
  const { user, browser } = await register();
  const pair = await setupPair(plane, database.pool, user);
  const session = await startSession(plane, pair);
  const { api_key, secret } = await newKey(browser);
  return { user, browser, pair, session, key: api_key, secret, auth: bearer(secret) };
}
const ask = (extra: Json = {}) => ({ model: MODEL, messages: [{ role: 'user', content: 'Hi' }], ...extra });
const run = (pair: any) => waitFor(() => pair.next('service', 'run_request'), 'run_request');
const accepted = (cmd: Json, prompt = 5, budget = 100) => ({ request_id: cmd.request_id, instance_id: cmd.instance_id, prompt_tokens: prompt, effective_max_output: budget, committed_position: String(prompt), timing: EMPTY_TIMING });
const chunk = (cmd: Json, seq: number, text: string, segment: string, position: number, tokens = 1) => ({ request_id: cmd.request_id, instance_id: cmd.instance_id, seq: String(seq), text, token_count: tokens, committed_position: String(position), segment, engine_first_output_ns: null, engine_last_output_ns: null, engine_first_chunk_tokens: null });
const end = (cmd: Json, final: number, tokens: number, reason = 'eos', prompt = 5) => ({ request_id: cmd.request_id, instance_id: cmd.instance_id, final_seq: String(final), outcome: 'completed', reason, released: true, prompt_tokens: prompt, output_tokens: String(tokens), timing: EMPTY_TIMING, statistics: EMPTY_STATS, error: null });
/** The usual run: accepted, a thinking chunk, an answer chunk, the end. */
async function answer(pair: any, cmd: Json, reason = 'eos') {
  await pair.send('service', 'request.accepted', accepted(cmd));
  await pair.send('service', 'output.chunk', chunk(cmd, 1, 'Let me think.', 'think', 7, 2));
  await pair.send('service', 'output.chunk', chunk(cmd, 2, 'Hello!', 'answer', 8));
  await pair.send('service', 'request.end', end(cmd, 2, 3, reason));
}

test('API keys: shown once, listed by hint, revoked, and owned by one user', async () => {
  const { browser } = await register();
  const created = await newKey(browser, 'editor');
  assert.match(created.secret, /^oi_[A-Za-z0-9_-]{43}$/);
  assert.deepEqual(Object.keys(created.api_key).sort(), ['created_at', 'hint', 'id', 'last_used_at', 'name', 'revoked_at']);
  assert.equal(created.api_key.hint, `oi_${created.secret.slice(-4)}`);
  assert.equal((await call('/api/v1/api-keys', 'POST', { name: '' }, browser)).status, 400);
  assert.equal((await call('/api/v1/api-keys', 'POST', { name: 'x' }, { cookie: browser.cookie })).status, 403, 'a browser route keeps its CSRF check');
  const listed = await call('/api/v1/api-keys', 'GET', undefined, { cookie: browser.cookie });
  assert.equal(listed.status, 200);
  assert.deepEqual(listed.json.api_keys.map((k: Json) => k.id), [created.api_key.id]);
  assert.ok(!listed.text.includes(created.secret), 'the list never carries the secret');
  // The page names the certificate file the control plane loaded, which --dir moves (a path, not the key).
  assert.equal(listed.json.certificate_path, `${directory}/tls.crt`);
  const row = (await database.pool.query('SELECT key_hash FROM api_keys WHERE id=$1', [created.api_key.id])).rows[0];
  assert.ok(!row.key_hash.toString('utf8').includes(created.secret.slice(4)), 'only the hash is stored');

  assert.equal((await call('/v1/models', 'GET', undefined, bearer(created.secret))).status, 200);
  const other = await register();
  assert.equal((await call(`/api/v1/api-keys/${created.api_key.id}/revoke`, 'POST', {}, other.browser)).status, 404, 'another user cannot revoke it');
  const revoked = await call(`/api/v1/api-keys/${created.api_key.id}/revoke`, 'POST', {}, browser);
  assert.equal(revoked.status, 200);
  assert.ok(revoked.json.api_key.revoked_at);
  const again = await call(`/api/v1/api-keys/${created.api_key.id}/revoke`, 'POST', {}, browser);
  assert.equal(again.json.api_key.revoked_at, revoked.json.api_key.revoked_at, 'revoking twice keeps the first time');
  const refused = await call('/v1/models', 'GET', undefined, bearer(created.secret));
  assert.equal(refused.status, 401);
  assert.equal(refused.json.error.code, 'api_key_revoked');
});

test('the two authentications do not mix: /v1 takes only a key, /api/v1 only the cookie', async () => {
  const { browser } = await register();
  const { secret } = await newKey(browser);
  for (const headers of [{}, { authorization: 'Bearer oi_wrong' }, bearer(`oi_${'A'.repeat(43)}`), { cookie: browser.cookie }]) {
    const reply = await call('/v1/models', 'GET', undefined, headers);
    assert.equal(reply.status, 401, JSON.stringify(headers));
    assert.deepEqual(Object.keys(reply.json.error).sort(), ['code', 'message', 'param', 'type']);
    assert.equal(reply.json.error.code, 'invalid_api_key');
  }
  assert.equal((await call('/api/v1/snapshot', 'GET', undefined, bearer(secret))).status, 401);
  // RFC 7235: the scheme is not case-sensitive; another scheme is still no key.
  for (const scheme of ['bearer', 'BEARER', 'BeArEr'])
    assert.equal((await call('/v1/models', 'GET', undefined, { authorization: `${scheme} ${secret}` })).status, 200, scheme);
  assert.equal((await call('/v1/models', 'GET', undefined, { authorization: `Basic ${secret}` })).status, 401);
  const models = await call('/v1/models', 'GET', undefined, bearer(secret));
  assert.equal(models.json.object, 'list');
  assert.deepEqual(models.json.data.map((m: Json) => [m.id, m.object, m.owned_by]), [[MODEL, 'model', 'openinfer']]);
  const missing = await call('/v1/embeddings', 'POST', {}, bearer(secret));
  assert.equal(missing.status, 404);
  assert.ok(missing.json.error.message);
  const broken = await call('/v1/chat/completions', 'POST', '{"model":', bearer(secret));
  assert.equal(broken.status, 400);
  assert.ok(broken.json.error.message, 'a body that is not JSON gets the OpenAI error shape');
});

test('fields: unsupported features and values are refused, unknown fields ignored, before any request exists', async () => {
  const { user, browser } = await register();
  const auth = bearer((await newKey(browser)).secret);
  const refuse = async (extra: Json, status: number, param: string | null, code: string) => {
    const reply = await call('/v1/chat/completions', 'POST', ask(extra), auth);
    assert.equal(reply.status, status, `${JSON.stringify(extra)} ${reply.text}`);
    assert.equal(reply.json.error.param, param, JSON.stringify(extra));
    assert.equal(reply.json.error.code, code, JSON.stringify(extra));
    return reply.json.error;
  };
  const greedy = await refuse({ temperature: 0 }, 400, 'temperature', 'invalid_value');
  assert.match(greedy.message, /samples/); assert.match(greedy.message, /above 0/); assert.match(greedy.message, /1\.0/);
  await refuse({ model: 'gpt-4o' }, 404, 'model', 'model_not_found');
  await refuse({ temperature: 2.5 }, 400, 'temperature', 'invalid_value');
  await refuse({ top_p: 0 }, 400, 'top_p', 'invalid_value');
  await refuse({ top_k: 0 }, 400, 'top_k', 'invalid_value');
  await refuse({ seed: 2 ** 53 }, 400, 'seed', 'invalid_value');
  await refuse({ n: 2 }, 400, 'n', 'invalid_value');
  await refuse({ presence_penalty: 0.5 }, 400, 'presence_penalty', 'unsupported_parameter');
  await refuse({ min_p: 0.1 }, 400, 'min_p', 'unsupported_parameter');
  await refuse({ tools: [{ type: 'function', function: { name: 'f' } }] }, 400, 'tools', 'unsupported_parameter');
  await refuse({ response_format: { type: 'json_object' } }, 400, 'response_format', 'unsupported_parameter');
  await refuse({ logprobs: true }, 400, 'logprobs', 'unsupported_parameter');
  await refuse({ stop: ['a', 'b', 'c', 'd', 'e'] }, 400, 'stop', 'invalid_value');
  await refuse({ chat_template_kwargs: { enable_thinking: false } }, 400, 'chat_template_kwargs', 'unsupported_parameter');
  await refuse({ messages: [{ role: 'tool', content: 'x', tool_call_id: 'a' }] }, 400, 'messages', 'unsupported_parameter');
  await refuse({ messages: [{ role: 'user', content: [{ type: 'image_url', image_url: { url: 'x' } }] }] }, 400, 'messages', 'unsupported_parameter');
  await refuse({ messages: [{ role: 'user', content: 'x'.repeat(65537) }] }, 400, 'messages', 'invalid_value');
  await refuse({ messages: [] }, 400, 'messages', 'invalid_value');
  // top_k at most 262144, not below the vocabulary (248320), so the largest value means no cut; a larger one would reach
  // the helper's bridge, which reads it into a C int. At most 1024 messages.
  const many = (n: number) => Array.from({ length: n }, () => ({ role: 'user', content: 'x' }));
  const huge = await refuse({ top_k: 262145 }, 400, 'top_k', 'invalid_value');
  assert.match(huge.message, /262144/);
  await refuse({ top_k: 2 ** 32 }, 400, 'top_k', 'invalid_value');
  await refuse({ messages: many(1025) }, 400, 'messages', 'invalid_value');
  for (const extra of [{ top_k: 262144 }, { messages: many(1024) }])
    assert.equal((await call('/v1/chat/completions', 'POST', ask(extra), auth)).status, 503, JSON.stringify(extra).slice(0, 60));
  // Everything above is refused before a session is looked for: with no session the rest is a 503.
  const accepted = await call('/v1/chat/completions', 'POST', ask({ user: 'u1', metadata: { a: 1 }, store: false, reasoning_effort: 'low', frequency_penalty: 0, logit_bias: {}, n: 1 }), auth);
  assert.equal(accepted.status, 503, accepted.text);
  assert.equal((await database.pool.query('SELECT count(*)::int AS n FROM requests WHERE group_id=$1', [user.group_id])).rows[0].n, 0);
});

test('no session that can serve: 503 tells the user to start one on the website', async () => {
  const { browser } = await register();
  const reply = await call('/v1/chat/completions', 'POST', ask(), bearer((await newKey(browser)).secret));
  assert.equal(reply.status, 503);
  assert.equal(reply.json.error.code, 'session_not_ready');
  assert.match(reply.json.error.message, /Start a session on the website/);
  assert.ok(reply.json.error.message.includes('https://example.invalid'), reply.json.error.message);
});

test('a whole (non-streamed) request: the same request row and command as the website, answer and thinking apart', async () => {
  const { pair, session, auth, key } = await ready();
  const body = ask({ messages: [{ role: 'developer', content: 'Be brief.' }, { role: 'user', content: [{ type: 'text', text: 'Hi' }, { type: 'text', text: ' there' }] }],
    temperature: 0.6, top_p: 0.9, top_k: 10, seed: 42, stop: 'END', max_tokens: 10000 });
  const pending = call('/v1/chat/completions', 'POST', body, auth);
  const cmd = await run(pair);
  assert.deepEqual(cmd.payload.input, { kind: 'chat', messages: [{ role: 'system', content: 'Be brief.' }, { role: 'user', content: 'Hi there' }] });
  assert.deepEqual(cmd.payload.sampling, { temperature: 0.6, top_p: 0.9, top_k: 10, min_p: 0, presence_penalty: 0 });
  assert.deepEqual([cmd.payload.seed, cmd.payload.stop, cmd.payload.max_output_tokens, cmd.payload.cap_max_output],
    ['42', ['END'], 4096, true], 'a budget over 4096 is capped by the control plane and the serving machine caps the rest');
  // The serving machine capped the budget to what fits: less than asked is accepted for an API request.
  await pair.send('service', 'request.accepted', accepted(cmd, 5, 4000));
  await pair.send('service', 'output.chunk', chunk(cmd, 1, 'Let me think.', 'think', 7, 2));
  await pair.send('service', 'output.chunk', chunk(cmd, 2, 'Hello!', 'answer', 8));
  await pair.send('service', 'request.end', end(cmd, 2, 3, 'length'));
  const reply = await pending;
  assert.equal(reply.status, 200, reply.text);
  const r = reply.json;
  assert.equal(r.object, 'chat.completion');
  assert.equal(r.id, `chatcmpl-${cmd.request_id}`);
  assert.equal(r.model, MODEL);
  assert.deepEqual(r.choices, [{ index: 0, message: { role: 'assistant', content: 'Hello!', reasoning_content: 'Let me think.' }, finish_reason: 'length', logprobs: null }]);
  assert.deepEqual(r.usage, { prompt_tokens: 5, completion_tokens: 3, total_tokens: 8 });
  assert.deepEqual(r.openinfer, { request_id: cmd.request_id, session_id: session.id, seed: '42', sampling: cmd.payload.sampling, effective_max_output: 4000 });
  const row = (await database.pool.query('SELECT source,api_key_id,state,requested_max_output FROM requests WHERE id=$1', [cmd.request_id])).rows[0];
  assert.deepEqual(row, { source: 'api', api_key_id: key.id, state: 'completed', requested_max_output: 4096 });
  assert.ok((await database.pool.query('SELECT last_used_at FROM api_keys WHERE id=$1', [key.id])).rows[0].last_used_at, 'the key records its use with the request');
});

test('a streamed request: role first, thinking as reasoning_content, the answer as content, then finish, usage and [DONE]', async () => {
  const { pair, session, auth } = await ready();
  const s = stream(ask({ stream: true, stream_options: { include_usage: true } }), auth);
  const cmd = await run(pair);
  assert.deepEqual([cmd.payload.input.kind, cmd.payload.stop, cmd.payload.max_output_tokens, cmd.payload.cap_max_output], ['chat', [], null, true]);
  assert.deepEqual(cmd.payload.sampling, { temperature: 1, top_p: 0.95, top_k: 20, min_p: 0, presence_penalty: 0 }, 'the official sampling by default');
  assert.match(cmd.payload.seed, /^\d+$/);
  await new Promise(resolve => setTimeout(resolve, 100));
  assert.equal(s.state.status, 0, 'no status before the serving machine accepted the request');
  await pair.send('service', 'request.accepted', accepted(cmd));
  await s.until(() => s.state.events.length >= 1, 'the first event');
  assert.equal(s.state.status, 200);
  assert.match(String(s.state.headers['content-type']), /^text\/event-stream/);
  const first = s.state.events[0];
  assert.equal(first.object, 'chat.completion.chunk');
  assert.deepEqual(first.choices, [{ index: 0, delta: { role: 'assistant', content: '' }, logprobs: null, finish_reason: null }]);
  assert.deepEqual({ ...first.openinfer, seed: undefined }, { request_id: cmd.request_id, session_id: session.id, seed: undefined, sampling: cmd.payload.sampling, effective_max_output: 100 });
  await pair.send('service', 'output.chunk', chunk(cmd, 1, 'Let me think.', 'think', 7, 2));
  await s.until(() => s.state.events.length >= 2, 'the thinking');
  assert.deepEqual(s.state.events[1].choices[0].delta, { reasoning_content: 'Let me think.' });
  await pair.send('service', 'output.chunk', chunk(cmd, 2, '', 'answer', 8));
  await pair.send('service', 'output.chunk', chunk(cmd, 3, 'Hello!', 'answer', 9));
  await pair.send('service', 'request.end', end(cmd, 3, 4));
  await s.until(() => s.state.ended, 'the end of the stream');
  const later = s.state.events.slice(2);
  assert.deepEqual(later[0].choices[0].delta, { content: 'Hello!' }, 'an empty chunk sends nothing');
  assert.deepEqual(later[1].choices, [{ index: 0, delta: {}, logprobs: null, finish_reason: 'stop' }]);
  assert.deepEqual(later[2].choices, []);
  assert.deepEqual(later[2].usage, { prompt_tokens: 5, completion_tokens: 4, total_tokens: 9 });
  assert.equal(later[3], '[DONE]');
  assert.equal(later.length, 4);
  const stored = await plane.getChunks(pair.user, cmd.request_id);
  assert.deepEqual(stored.chunks.map((x: Json) => x.segment), ['think', 'answer', 'answer']);
});

// After </think> the model writes blank lines before its answer. The answer (content) starts at its first
// character that is not white space, whole and streamed alike, also when those blank lines come in chunks of their own;
// the thinking (reasoning_content) is passed on as it is, and white space later in the answer is kept.
test('the answer starts without the blank lines after the thinking, whole and streamed; the thinking is unchanged', async () => {
  const { pair, auth } = await ready();
  const pending = call('/v1/chat/completions', 'POST', ask(), auth);
  let cmd = await run(pair);
  await pair.send('service', 'request.accepted', accepted(cmd));
  await pair.send('service', 'output.chunk', chunk(cmd, 1, '\nLet me think.\n', 'think', 7, 2));
  await pair.send('service', 'output.chunk', chunk(cmd, 2, '\n\n', 'answer', 8));
  await pair.send('service', 'output.chunk', chunk(cmd, 3, ' \nHello!\n\nBye. ', 'answer', 9));
  await pair.send('service', 'request.end', end(cmd, 3, 4));
  const reply = await pending;
  assert.equal(reply.status, 200, reply.text);
  assert.deepEqual(reply.json.choices[0].message, { role: 'assistant', content: 'Hello!\n\nBye. ', reasoning_content: '\nLet me think.\n' });

  const s = stream(ask({ stream: true }), auth);
  cmd = await run(pair);
  await pair.send('service', 'request.accepted', accepted(cmd));
  await pair.send('service', 'output.chunk', chunk(cmd, 1, '\nLet me think.\n', 'think', 7, 2));
  await s.until(() => s.state.events.length >= 2, 'the thinking');
  await pair.send('service', 'output.chunk', chunk(cmd, 2, '\n\n', 'answer', 8));
  await new Promise(resolve => setTimeout(resolve, 100));
  await pair.send('service', 'output.chunk', chunk(cmd, 3, ' \nHello!', 'answer', 9));
  await pair.send('service', 'output.chunk', chunk(cmd, 4, '\n\nBye. ', 'answer', 10));
  await pair.send('service', 'request.end', end(cmd, 4, 5));
  await s.until(() => s.state.ended, 'the end of the stream');
  const deltas = s.state.events.slice(1, -2).map((e: Json) => e.choices[0].delta);
  assert.deepEqual(deltas, [{ reasoning_content: '\nLet me think.\n' }, { content: 'Hello!' }, { content: '\n\nBye. ' }],
    'the blank lines alone send nothing; the first answer piece starts with its text');
});

// Only the blank lines before the answer go; the indentation of its first line is part of the answer (a
// function body, an indented code block). An answer of white space alone is "". Streamed, a piece of white space that may
// be the first line's indentation is held until the line's first other character, or dropped at its newline.
test('the answer keeps the indentation of its first line, whole and streamed; white space alone is an empty answer', async () => {
  const { pair, auth } = await ready();
  const whole = async (pieces: string[]) => {
    const pending = call('/v1/chat/completions', 'POST', ask(), auth);
    const cmd = await run(pair);
    await pair.send('service', 'request.accepted', accepted(cmd));
    await pair.send('service', 'output.chunk', chunk(cmd, 1, 'Hm.', 'think', 7, 2));
    for (const [i, text] of pieces.entries()) await pair.send('service', 'output.chunk', chunk(cmd, i + 2, text, 'answer', 8 + i));
    await pair.send('service', 'request.end', end(cmd, pieces.length + 1, pieces.length + 2));
    const reply = await pending;
    assert.equal(reply.status, 200, reply.text);
    return reply.json.choices[0].message.content;
  };
  assert.equal(await whole(['\n\n    return x\n']), '    return x\n');
  assert.equal(await whole(['\n', ' \t\n', '\tif x:\n\t\treturn y']), '\tif x:\n\t\treturn y');
  assert.equal(await whole(['\n\n', '  ']), '');

  const streamed = async (pieces: string[]) => {
    const s = stream(ask({ stream: true }), auth);
    const cmd = await run(pair);
    await pair.send('service', 'request.accepted', accepted(cmd));
    await pair.send('service', 'output.chunk', chunk(cmd, 1, 'Hm.', 'think', 7, 2));
    await s.until(() => s.state.events.length >= 2, 'the thinking');
    for (const [i, text] of pieces.entries()) {
      await pair.send('service', 'output.chunk', chunk(cmd, i + 2, text, 'answer', 8 + i));
      await new Promise(resolve => setTimeout(resolve, 60));
    }
    await pair.send('service', 'request.end', end(cmd, pieces.length + 1, pieces.length + 2));
    await s.until(() => s.state.ended, 'the end of the stream');
    return s.state.events.slice(2, -2).map((e: Json) => e.choices[0].delta.content);
  };
  assert.deepEqual(await streamed(['\n\n    return x\n']), ['    return x\n']);
  assert.deepEqual(await streamed(['\n\n  ', '  return x\n', '  y']), ['    return x\n', '  y'], 'the indentation is held until its line has text');
  assert.deepEqual(await streamed(['\n  ', ' \n', 'Hi']), ['Hi'], 'white space up to a newline is a blank line');
  assert.deepEqual(await streamed(['\n\n', '  ']), [], 'white space alone sends no answer');
});

test('one request at a time: a busy session answers 429 with Retry-After, the website request counts too', async () => {
  const { pair, session, auth, user } = await ready();
  await plane.submitRequest(user, session.id, randomUUID(), { prompt: 'from the website' });
  const busy = await call('/v1/chat/completions', 'POST', ask(), auth);
  assert.equal(busy.status, 429);
  assert.equal(busy.json.error.code, 'request_busy');
  assert.equal(busy.headers['retry-after'], '10');
  const cmd = await run(pair);
  await answer(pair, cmd);
  await waitFor(async () => assert.equal((await plane.getRequest(user, cmd.request_id)).state, 'completed'), 'completed');
  const browserBusy = call('/v1/chat/completions', 'POST', ask(), auth);
  const apiCmd = await run(pair);
  await assert.rejects(plane.submitRequest(user, session.id, randomUUID(), { prompt: 'x' }), (e: any) => e.code === 'request_busy' && e.status === 409, 'the website still gets its 409');
  await answer(pair, apiCmd);
  assert.equal((await browserBusy).status, 200);
});

test('a request the serving machine refuses before any output keeps the HTTP status (context length)', async () => {
  const { pair, auth } = await ready();
  const pending = call('/v1/chat/completions', 'POST', ask({ stream: true }), auth);
  const cmd = await run(pair);
  const message = 'prompt has 4090 tokens; output must fit remaining 6 of 4096';
  await pair.send('service', 'request.end', { ...end(cmd, 0, 0), outcome: 'failed', reason: 'error', prompt_tokens: null,
    error: { code: 'context_budget_exceeded', message, field: null, device_id: null, phase: 'serve', retryable: false } });
  const reply = await pending;
  assert.equal(reply.status, 400, reply.text);
  assert.equal(reply.json.error.code, 'context_length_exceeded');
  assert.equal(reply.json.error.message, message);
});

test('a client that hangs up mid-stream cancels its request through the existing cancellation', async () => {
  const { pair, user, auth } = await ready();
  const s = stream(ask({ stream: true }), auth);
  const cmd = await run(pair);
  await pair.send('service', 'request.accepted', accepted(cmd));
  await pair.send('service', 'output.chunk', chunk(cmd, 1, 'Let me', 'think', 6));
  await s.until(() => s.state.events.length >= 2, 'the first output');
  s.hangUp();
  const cancel = await waitFor(() => pair.next('service', 'cancel_request'), 'cancel_request');
  assert.equal(cancel.payload.reason, 'client_disconnected');
  const r = await plane.getRequest(user, cmd.request_id);
  assert.deepEqual([r.state, r.cancel_reason], ['cancelling', 'client_disconnected']);
  await pair.result('service', cancel, { request_id: cmd.request_id, released: true });
  await pair.send('service', 'request.end', { ...end(cmd, 1, 1), outcome: 'cancelled', reason: 'cancelled' });
  await waitFor(async () => assert.equal((await plane.getRequest(user, cmd.request_id)).state, 'cancelled'), 'cancelled');
});

test('a hang-up does not cancel while the serving machine is disconnected', async () => {
  const { pair, user, auth } = await ready();
  const s = stream(ask({ stream: true }), auth);
  const cmd = await run(pair);
  await pair.send('service', 'request.accepted', accepted(cmd));
  await s.until(() => s.state.events.length >= 1, 'the first event');
  await plane.closeDevice(pair.devices.service.id, pair.devices.service.connection);
  s.hangUp();
  await new Promise(resolve => setTimeout(resolve, 200));
  const r = await plane.getRequest(user, cmd.request_id);
  assert.equal(r.state, 'running', 'the request is left to the disconnection rules');
  assert.equal((await database.pool.query("SELECT count(*)::int AS n FROM commands WHERE request_id=$1 AND kind='cancel_request'", [cmd.request_id])).rows[0].n, 0);
});

test('a request that fails mid-stream ends with an error event and no [DONE]', async () => {
  const { pair, auth } = await ready();
  const s = stream(ask({ stream: true }), auth);
  const cmd = await run(pair);
  await pair.send('service', 'request.accepted', accepted(cmd));
  await pair.send('service', 'output.chunk', chunk(cmd, 1, 'Let me', 'think', 6));
  await pair.send('service', 'request.end', { ...end(cmd, 1, 1), outcome: 'failed', reason: 'error',
    error: { code: 'engine_error', message: 'the engine stopped (error)', field: null, device_id: null, phase: 'serve', retryable: false } });
  await s.until(() => s.state.ended, 'the end of the stream');
  const last = s.state.events.at(-1);
  assert.equal(last.error.code, 'engine_error');
  assert.ok(!s.state.events.includes('[DONE]'));
});

test('chunks carry their segment: required on the wire, compared on a repeat, null for chunks saved before', async () => {
  const { pair, user, session } = await ready();
  const r = await plane.submitRequest(user, session.id, randomUUID(), { prompt: 'x' });
  const cmd = await run(pair);
  assert.deepEqual([cmd.payload.input, cmd.payload.stop, cmd.payload.cap_max_output], [{ kind: 'text', prompt: 'x' }, [], false], 'website requests are unchanged');
  await pair.send('service', 'request.accepted', accepted(cmd, 5, 4091));
  const { segment, ...bare } = chunk(cmd, 1, 'a', 'think', 6);
  await assert.rejects(pair.send('service', 'output.chunk', bare), (e: any) => e.code === 'invalid_input');
  await assert.rejects(pair.send('service', 'output.chunk', { ...bare, segment: 'other' }), (e: any) => e.code === 'invalid_input');
  await pair.send('service', 'output.chunk', chunk(cmd, 1, 'a', 'think', 6));
  await assert.rejects(pair.send('service', 'output.chunk', chunk(cmd, 1, 'a', 'answer', 6)), (e: any) => e.code === 'chunk_conflict');
  const after = await plane.getRequest(user, r.id);
  assert.equal(after.state, 'failed', 'a repeat with another segment is a chunk conflict');
  assert.equal(after.error.code, 'chunk_conflict');
  assert.equal((await database.pool.query("SELECT count(*)::int AS n FROM information_schema.columns WHERE table_name='output_chunks' AND column_name='segment' AND is_nullable='YES'")).rows[0].n, 1);
});

test('a website request keeps its exact budget rule: less than asked is a context budget conflict', async () => {
  const { pair, user, session } = await ready();
  await plane.submitRequest(user, session.id, randomUUID(), { prompt: 'x', max_output_tokens: 64 });
  const cmd = await run(pair);
  await assert.rejects(pair.send('service', 'request.accepted', accepted(cmd, 5, 60)), (e: any) => e.code === 'context_budget_exceeded');
});

test('the recent requests of a session: newest first, with their source, for the website list', async () => {
  const { pair, user, session, browser, key, auth } = await ready();
  await plane.submitRequest(user, session.id, randomUUID(), { prompt: 'one' });
  await answer(pair, await run(pair));
  const pending = call('/v1/chat/completions', 'POST', ask(), auth);
  await answer(pair, await run(pair));
  assert.equal((await pending).status, 200);
  const list = await call(`/api/v1/sessions/${session.id}/requests?limit=20`, 'GET', undefined, { cookie: browser.cookie });
  assert.equal(list.status, 200, list.text);
  assert.deepEqual(list.json.requests.map((r: Json) => [r.source, r.api_key_id]), [['api', key.id], ['web', null]]);
  assert.ok(list.json.requests.every((r: Json) => !('input' in r) && r.state === 'completed'));
  assert.equal((await call(`/api/v1/sessions/${session.id}/requests?limit=1`, 'GET', undefined, { cookie: browser.cookie })).json.requests.length, 1);
  assert.equal((await call(`/api/v1/sessions/${session.id}/requests?limit=0`, 'GET', undefined, { cookie: browser.cookie })).status, 400);
  const stranger = await register();
  assert.equal((await call(`/api/v1/sessions/${session.id}/requests`, 'GET', undefined, { cookie: stranger.browser.cookie })).status, 403);
});

test('stopping the control plane ends open API streams without cancelling their requests', async () => {
  // A restart closes every connection but does not cancel API requests; they run on and
  // show on the website. The stop must also finish: an open stream (kept alive every 15 s) must not hold it up.
  const { pair, user, auth } = await ready();
  const second = createServer(plane, { key: await readFile(`${directory}/tls.key`), cert: certificate, origin, tickIntervalMs: 3_600_000 });
  await new Promise<void>(resolve => second.server.listen(0, '127.0.0.1', resolve));
  const body = Buffer.from(JSON.stringify(ask({ stream: true })));
  let ended = false, events = '';
  const req = https.request({ host: '127.0.0.1', port: (second.server.address() as { port: number }).port, path: '/v1/chat/completions', method: 'POST', ca: certificate,
    headers: { 'content-type': 'application/json', 'content-length': String(body.length), ...auth } });
  req.on('error', () => { ended = true; });
  req.on('response', res => { res.setEncoding('utf8'); res.on('data', (x: string) => { events += x; }); res.on('end', () => { ended = true; }); res.on('error', () => { ended = true; }); });
  req.end(body);
  const cmd = await run(pair);
  await pair.send('service', 'request.accepted', accepted(cmd));
  await pair.send('service', 'output.chunk', chunk(cmd, 1, 'Let me', 'think', 6));
  await waitFor(async () => assert.match(events, /Let me/), 'the first output');
  const closed = await Promise.race([second.close().then(() => true), new Promise<false>(resolve => setTimeout(() => resolve(false), 3000))]);
  if (!closed) req.destroy();
  assert.ok(closed, 'the server stopped while an API stream was open');
  await waitFor(async () => assert.ok(ended), 'the stream ended');
  await new Promise(resolve => setTimeout(resolve, 200));
  const r = await plane.getRequest(user, cmd.request_id);
  assert.equal(r.state, 'running', 'the request runs on after the stop');
  assert.equal((await database.pool.query("SELECT count(*)::int AS n FROM commands WHERE request_id=$1 AND kind='cancel_request'", [cmd.request_id])).rows[0].n, 0);
  await pair.send('service', 'output.chunk', chunk(cmd, 2, 'Hello!', 'answer', 7));
  await pair.send('service', 'request.end', end(cmd, 2, 2));
  await waitFor(async () => assert.equal((await plane.getRequest(user, cmd.request_id)).state, 'completed'), 'completed');
});

test('client_disconnected: pending is cancelled, running starts the cancellation, nothing else takes it', () => {
  assert.deepEqual(transition('requests', 'pending', 'client_disconnected'), { state: 'cancelled', effects: [] });
  assert.deepEqual(transition('requests', 'running', 'client_disconnected'), { state: 'cancelling', effects: ['dispatch_cancel_request'] });
  for (const state of ['recovering', 'cancelling', 'completed', 'failed', 'cancelled'])
    assert.throws(() => transition('requests', state, 'client_disconnected'), /Illegal requests transition/);
  assert.equal(transition('requests', 'cancelling', 'cancel_released', { cancelReason: 'client_disconnected' }).state, 'cancelled');
});

test('a control plane that is stopping answers new API requests with 503 server_stopping and creates nothing', async () => {
  // Between stop() and the end of server.close() the port still listens; a request there would
  // otherwise be created and hold the stop up. The router is mounted as createServer mounts it.
  const { session, auth } = await ready();
  const api = createOpenAiRouter(plane);
  const app = express(); app.use(express.json({ limit: '1mb' })); app.use('/v1', api, openAiErrors);
  const server = https.createServer({ key: await readFile(`${directory}/tls.key`), cert: certificate }, app);
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
  try {
    api.stop();
    const reply = await callWithin(3000, '/v1/chat/completions', 'POST', ask(), auth, (server.address() as { port: number }).port);
    assert.notEqual(reply, 'timeout', 'the request was taken while stopping');
    if (reply === 'timeout') return;
    assert.equal(reply.status, 503, reply.text);
    assert.equal(reply.json.error.code, 'server_stopping');
    assert.equal(reply.headers.connection, 'close');
    assert.equal((await database.pool.query('SELECT count(*)::int AS n FROM requests WHERE session_id=$1', [session.id])).rows[0].n, 0);
  } finally {
    server.closeAllConnections();
    await new Promise<void>(resolve => server.close(() => resolve()));
  }
});

test("a key reaches only its own group: another group's idle session is not used", async () => {
  // Group A has a ready, idle session; group B has none. B's key gets 503 and A's session gets nothing.
  const a = await ready();
  const b = await register();
  const reply = await callWithin(3000, '/v1/chat/completions', 'POST', ask(), bearer((await newKey(b.browser)).secret));
  assert.notEqual(reply, 'timeout', 'the request went to a session of another group');
  if (reply === 'timeout') return;
  assert.equal(reply.status, 503, reply.text);
  assert.equal(reply.json.error.code, 'session_not_ready');
  assert.equal((await database.pool.query('SELECT count(*)::int AS n FROM requests WHERE session_id=$1', [a.session.id])).rows[0].n, 0);
});
