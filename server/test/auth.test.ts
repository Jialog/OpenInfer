import assert from 'node:assert/strict';
import { after, before, test } from 'node:test';
import { createHash, randomBytes } from 'node:crypto';
import express from 'express';
import type { Server } from 'node:http';

import { authenticateUser, createAuthRouter, requireUser } from '../src/auth.js';
import { createDatabase } from './postgres.js';

// Passwords made for this run.
const PASSWORD = Object.fromEntries(['alice', 'origin', 'other', 'wrong', 'expiry', 'owner', 'stranger'].map((k) => [k, randomBytes(18).toString('base64url')]));

const origin = 'https://control.example.test';
let database: Awaited<ReturnType<typeof createDatabase>>;
let server: Server;
let baseUrl: string;

function cookieFrom(response: Response): string {
  const value = response.headers.get('set-cookie');
  assert.ok(value, 'response must set a session cookie');
  return value.split(';', 1)[0];
}

async function request(path: string, init: RequestInit = {}): Promise<Response> {
  return fetch(`${baseUrl}${path}`, init);
}

async function jsonRequest(
  path: string,
  body: unknown,
  headers: Record<string, string> = {},
): Promise<Response> {
  return request(path, {
    method: 'POST',
    headers: { 'content-type': 'application/json', origin, ...headers },
    body: JSON.stringify(body),
  });
}

before(async () => {
  database = await createDatabase();
  const app = express();
  app.use(express.json());
  app.use('/api/v1/auth', createAuthRouter(database.pool, origin));
  app.use('/closed/api/v1/auth', createAuthRouter(database.pool, origin, { registration: 'closed' }));
  app.post('/api/v1/protected', requireUser(database.pool, origin), (req, res) => {
    res.json(req.auth);
  });
  server = app.listen(0, '127.0.0.1');
  await new Promise<void>((resolve) => server.once('listening', resolve));
  const address = server.address();
  assert.ok(address && typeof address === 'object');
  baseUrl = `http://127.0.0.1:${address.port}`;
});

after(async () => {
  await new Promise<void>((resolve, reject) =>
    server.close((error) => (error ? reject(error) : resolve())),
  );
  await database.close();
});

test('register normalizes email and atomically creates a group, membership, and login', async () => {
  const response = await jsonRequest('/api/v1/auth/register', {
    email: '  Alice@Example.COM ',
    password: PASSWORD.alice,
  });
  assert.equal(response.status, 201);
  const identity = await response.json();
  assert.equal(identity.email, 'alice@example.com');
  assert.match(identity.user_id, /^[0-9a-f-]{36}$/);
  assert.match(identity.group_id, /^[0-9a-f-]{36}$/);
  assert.match(identity.csrf_token, /^[A-Za-z0-9_-]{43}$/);
  assert.equal(new Date(identity.expires_at).getTime() > Date.now(), true);

  const cookie = cookieFrom(response);
  const setCookie = response.headers.get('set-cookie') ?? '';
  for (const attribute of ['Secure', 'HttpOnly', 'SameSite=Strict', 'Path=/']) {
    assert.ok(setCookie.includes(attribute), attribute);
  }
  const authenticated = await authenticateUser(database.pool, cookie);
  assert.deepEqual(authenticated, identity);

  const rows = await database.pool.query(
    `SELECT u.email, u.password_hash, count(DISTINCT m.group_id)::int AS memberships,
            count(DISTINCT s.id)::int AS sessions, s.token_hash
       FROM users u
       JOIN memberships m ON m.user_id = u.id
       JOIN login_sessions s ON s.user_id = u.id
      WHERE u.id = $1
      GROUP BY u.email, u.password_hash, s.token_hash`,
    [identity.user_id],
  );
  assert.equal(rows.rows[0].memberships, 1);
  assert.equal(rows.rows[0].sessions, 1);
  assert.match(rows.rows[0].password_hash, /^\$argon2id\$/);
  assert.equal(rows.rows[0].token_hash.length, 32);
  assert.equal(rows.rows[0].token_hash.equals(Buffer.from(cookie.split('=', 2)[1], 'base64url')), false);
});

test('register and login require the exact public Origin and reject malformed fields', async () => {
  const missing = await request('/api/v1/auth/register', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ email: 'origin@example.com', password: PASSWORD.origin }),
  });
  assert.equal(missing.status, 403);
  assert.equal((await missing.json()).error.code, 'forbidden');

  const wrong = await jsonRequest(
    '/api/v1/auth/login',
    { email: 'alice@example.com', password: PASSWORD.alice },
    { origin: `${origin}/` },
  );
  assert.equal(wrong.status, 403);

  const extra = await jsonRequest('/api/v1/auth/register', {
    email: 'extra@example.com',
    password: PASSWORD.origin,
    role: 'admin',
  });
  assert.equal(extra.status, 400);
  assert.equal((await extra.json()).error.code, 'invalid_input');
});

test('duplicate registration conflicts and login has a uniform credential failure', async () => {
  const duplicate = await jsonRequest('/api/v1/auth/register', {
    email: 'ALICE@example.com',
    password: PASSWORD.other,
  });
  assert.equal(duplicate.status, 409);

  for (const credentials of [
    { email: 'missing@example.com', password: PASSWORD.wrong },
    { email: 'alice@example.com', password: PASSWORD.wrong },
  ]) {
    const response = await jsonRequest('/api/v1/auth/login', credentials);
    assert.equal(response.status, 401);
    const error = (await response.json()).error;
    assert.equal(error.code, 'unauthenticated');
    assert.equal(error.field, null);
  }
});

test('me authenticates the cookie and modifying requests enforce Origin and CSRF', async () => {
  const login = await jsonRequest('/api/v1/auth/login', {
    email: 'alice@example.com',
    password: PASSWORD.alice,
  });
  assert.equal(login.status, 200);
  const identity = await login.json();
  const cookie = cookieFrom(login);

  const me = await request('/api/v1/auth/me', { headers: { cookie } });
  assert.equal(me.status, 200);
  assert.deepEqual(await me.json(), identity);

  const noOrigin = await request('/api/v1/protected', {
    method: 'POST',
    headers: { cookie, 'x-csrf-token': identity.csrf_token },
  });
  assert.equal(noOrigin.status, 403);

  const badCsrf = await request('/api/v1/protected', {
    method: 'POST',
    headers: { cookie, origin, 'x-csrf-token': `${identity.csrf_token}x` },
  });
  assert.equal(badCsrf.status, 403);

  const accepted = await request('/api/v1/protected', {
    method: 'POST',
    headers: { cookie, origin, 'x-csrf-token': identity.csrf_token },
  });
  assert.equal(accepted.status, 200);
  assert.deepEqual(await accepted.json(), identity);
});

test('logout revokes the current login and clears its cookie', async () => {
  const login = await jsonRequest('/api/v1/auth/login', {
    email: 'alice@example.com',
    password: PASSWORD.alice,
  });
  const identity = await login.json();
  const cookie = cookieFrom(login);
  const logout = await jsonRequest('/api/v1/auth/logout', {}, {
    cookie,
    'x-csrf-token': identity.csrf_token,
  });
  assert.equal(logout.status, 204);
  assert.match(logout.headers.get('set-cookie') ?? '', /Max-Age=0/);
  assert.equal(await authenticateUser(database.pool, cookie), null);
  assert.equal((await request('/api/v1/auth/me', { headers: { cookie } })).status, 401);
});

test('expired, revoked, malformed, and membership-less sessions do not authenticate', async () => {
  const expireLogin = await jsonRequest('/api/v1/auth/login', {
    email: 'alice@example.com',
    password: PASSWORD.alice,
  });
  const expireCookie = cookieFrom(expireLogin);
  const expireToken = Buffer.from(expireCookie.split('=', 2)[1], 'base64url');
  await database.pool.query('UPDATE login_sessions SET expires_at = now() WHERE token_hash = $1', [
    createHash('sha256').update(expireToken).digest(),
  ]);
  assert.equal(await authenticateUser(database.pool, expireCookie), null);

  const revokeLogin = await jsonRequest('/api/v1/auth/login', {
    email: 'alice@example.com',
    password: PASSWORD.alice,
  });
  const revokeCookie = cookieFrom(revokeLogin);
  const revokeToken = Buffer.from(revokeCookie.split('=', 2)[1], 'base64url');
  await database.pool.query('UPDATE login_sessions SET revoked_at = now() WHERE token_hash = $1', [
    createHash('sha256').update(revokeToken).digest(),
  ]);
  assert.equal(await authenticateUser(database.pool, revokeCookie), null);

  const registration = await jsonRequest('/api/v1/auth/register', {
    email: 'expiry@example.com',
    password: PASSWORD.expiry,
  });
  const identity = await registration.json();
  const cookie = cookieFrom(registration);
  await database.pool.query('DELETE FROM memberships WHERE user_id = $1', [identity.user_id]);
  assert.equal(await authenticateUser(database.pool, cookie), null);
  assert.equal(await authenticateUser(database.pool, 'other=value; malformed'), null);
  assert.equal(await authenticateUser(database.pool, undefined), null);
});

test('closed registration refuses new accounts and creates nothing, while existing accounts still sign in', async () => {
  const open = await jsonRequest('/api/v1/auth/register', {
    email: 'owner@example.com',
    password: PASSWORD.owner,
  });
  assert.equal(open.status, 201);
  const before = await database.pool.query<{ users: number; groups: number }>(
    'SELECT (SELECT count(*) FROM users)::int AS users, (SELECT count(*) FROM groups)::int AS groups',
  );

  const refused = await jsonRequest('/closed/api/v1/auth/register', {
    email: 'stranger@example.com',
    password: PASSWORD.stranger,
  });
  assert.equal(refused.status, 403);
  assert.equal(refused.headers.get('set-cookie'), null);
  const error = (await refused.json()).error;
  assert.equal(error.code, 'registration_closed');
  assert.match(error.message, /^Registration is closed on this control plane\./);
  assert.equal(error.field, null);
  assert.equal(error.retryable, false);
  const after = await database.pool.query<{ users: number; groups: number }>(
    'SELECT (SELECT count(*) FROM users)::int AS users, (SELECT count(*) FROM groups)::int AS groups',
  );
  assert.deepEqual(after.rows[0], before.rows[0]);

  // An existing email gets the same answer: a closed control plane says nothing about who is registered.
  const existing = await jsonRequest('/closed/api/v1/auth/register', {
    email: 'owner@example.com',
    password: PASSWORD.owner,
  });
  assert.equal(existing.status, 403);
  assert.equal((await existing.json()).error.code, 'registration_closed');

  const login = await jsonRequest('/closed/api/v1/auth/login', {
    email: 'owner@example.com',
    password: PASSWORD.owner,
  });
  assert.equal(login.status, 200);
  const cookie = cookieFrom(login);
  const identity = await login.json();
  const me = await request('/closed/api/v1/auth/me', { headers: { cookie } });
  assert.equal(me.status, 200);
  assert.equal((await me.json()).user_id, identity.user_id);
  const logout = await jsonRequest('/closed/api/v1/auth/logout', {}, { cookie, 'x-csrf-token': identity.csrf_token });
  assert.equal(logout.status, 204);
});

// The sign-in page asks before it shows the registration form. The answer needs no sign-in and says only open
// or closed.
test('the registration setting is readable without signing in', async () => {
  for (const [path, registration] of [['/api/v1/auth/registration', 'open'], ['/closed/api/v1/auth/registration', 'closed']]) {
    const response = await request(path);
    assert.equal(response.status, 200, path);
    assert.equal(response.headers.get('set-cookie'), null);
    assert.deepEqual(await response.json(), { registration });
  }
});
