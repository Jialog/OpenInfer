import { createHash, createHmac, randomBytes, randomUUID, timingSafeEqual } from 'node:crypto';
import argon2 from 'argon2';
import express, { type RequestHandler, type Router } from 'express';
import type { Pool, PoolClient } from 'pg';

const COOKIE_NAME = '__Host-openinfer_session';
const CSRF_MESSAGE = 'openinfer.csrf.v1';
const SESSION_LIFETIME = '7 days';

export type Identity = {
  user_id: string;
  email: string;
  group_id: string;
  csrf_token: string;
  expires_at: string;
};

declare global {
  namespace Express {
    interface Request {
      auth: Identity;
    }
  }
}

type ApiError = {
  code: string;
  message: string;
  field: string | null;
  device_id: null;
  phase: null;
  retryable: boolean;
};

function sendError(
  res: express.Response,
  status: number,
  code: string,
  message: string,
  field: string | null = null,
): void {
  const error: ApiError = {
    code,
    message,
    field,
    device_id: null,
    phase: null,
    retryable: false,
  };
  res.status(status).json({ error });
}

function sha256(value: Buffer | string): Buffer {
  return createHash('sha256').update(value).digest();
}

function deriveCsrf(token: Buffer): string {
  return createHmac('sha256', token).update(CSRF_MESSAGE).digest('base64url');
}

function constantTimeStringEqual(left: string, right: string): boolean {
  return timingSafeEqual(sha256(left), sha256(right));
}

function readSessionToken(cookieHeader: string | undefined): Buffer | null {
  if (!cookieHeader) return null;
  const matches = cookieHeader
    .split(';')
    .map((part) => part.trim())
    .filter((part) => part.startsWith(`${COOKIE_NAME}=`));
  if (matches.length !== 1) return null;
  const encoded = matches[0].slice(COOKIE_NAME.length + 1);
  if (!/^[A-Za-z0-9_-]{43}$/.test(encoded)) return null;
  const token = Buffer.from(encoded, 'base64url');
  return token.length === 32 ? token : null;
}

function identityFromRow(row: {
  user_id: string;
  email: string;
  group_id: string;
  expires_at: Date | string;
}, csrfToken: string): Identity {
  const expiresAt = row.expires_at instanceof Date ? row.expires_at : new Date(row.expires_at);
  return {
    user_id: row.user_id,
    email: row.email,
    group_id: row.group_id,
    csrf_token: csrfToken,
    expires_at: expiresAt.toISOString(),
  };
}

function setSessionCookie(res: express.Response, token: Buffer): void {
  res.setHeader(
    'Set-Cookie',
    `${COOKIE_NAME}=${token.toString('base64url')}; Path=/; HttpOnly; Secure; SameSite=Strict`,
  );
}

function clearSessionCookie(res: express.Response): void {
  res.setHeader(
    'Set-Cookie',
    `${COOKIE_NAME}=; Path=/; Max-Age=0; HttpOnly; Secure; SameSite=Strict`,
  );
}

function hasExactKeys(value: unknown, expected: readonly string[]): value is Record<string, unknown> {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return false;
  const keys = Object.keys(value);
  return keys.length === expected.length && expected.every((key) => keys.includes(key));
}

function parseCredentials(
  body: unknown,
): { credentials: { email: string; password: string } } | { field: string | null; message: string } {
  if (!hasExactKeys(body, ['email', 'password'])) {
    return { field: null, message: 'Request body must contain only email and password.' };
  }
  if (typeof body.email !== 'string') return { field: 'email', message: 'Email must be a string.' };
  if (typeof body.password !== 'string') {
    return { field: 'password', message: 'Password must be a string.' };
  }
  const email = body.email.trim().toLowerCase();
  if (email.length <= 3 || email.length > 320 || !/^[^\s@]+@[^\s@]+$/.test(email)) {
    return { field: 'email', message: 'Email is invalid.' };
  }
  const passwordLength = Array.from(body.password).length;
  if (passwordLength < 12 || passwordLength > 128) {
    return { field: 'password', message: 'Password must be between 12 and 128 characters.' };
  }
  return { credentials: { email, password: body.password } };
}

function exactOrigin(publicOrigin: string): RequestHandler {
  return (req, res, next) => {
    if (req.get('origin') !== publicOrigin) {
      sendError(res, 403, 'forbidden', 'Origin is not allowed.');
      return;
    }
    next();
  };
}

async function insertLoginSession(
  client: Pool | PoolClient,
  userId: string,
): Promise<{ token: Buffer; csrfToken: string; expiresAt: Date | string }> {
  const token = randomBytes(32);
  const csrfToken = deriveCsrf(token);
  const result = await client.query<{ expires_at: Date | string }>(
    `INSERT INTO login_sessions (id, user_id, token_hash, csrf_hash, expires_at)
     VALUES ($1, $2, $3, $4, now() + $5::interval)
     RETURNING expires_at`,
    [randomUUID(), userId, sha256(token), sha256(csrfToken), SESSION_LIFETIME],
  );
  return { token, csrfToken, expiresAt: result.rows[0].expires_at };
}

export async function authenticateUser(
  pool: Pool,
  cookieHeader: string | undefined,
): Promise<Identity | null> {
  const token = readSessionToken(cookieHeader);
  if (!token) return null;
  const csrfToken = deriveCsrf(token);
  const result = await pool.query<{
    user_id: string;
    email: string;
    group_id: string;
    expires_at: Date | string;
    csrf_hash: Buffer;
  }>(
    `SELECT u.id AS user_id, u.email, m.group_id, s.expires_at, s.csrf_hash
       FROM login_sessions s
       JOIN users u ON u.id = s.user_id
       JOIN memberships m ON m.user_id = u.id
      WHERE s.token_hash = $1
        AND s.revoked_at IS NULL
        AND s.expires_at > now()`,
    [sha256(token)],
  );
  if (result.rows.length !== 1) return null;
  const row = result.rows[0];
  if (row.csrf_hash.length !== 32 || !timingSafeEqual(row.csrf_hash, sha256(csrfToken))) return null;
  return identityFromRow(row, csrfToken);
}

export function requireUser(pool: Pool, publicOrigin: string): RequestHandler {
  return async (req, res, next) => {
    try {
      const identity = await authenticateUser(pool, req.get('cookie'));
      if (!identity) {
        sendError(res, 401, 'unauthenticated', 'Authentication is required.');
        return;
      }
      if (req.method === 'POST') {
        if (req.get('origin') !== publicOrigin) {
          sendError(res, 403, 'forbidden', 'Origin is not allowed.');
          return;
        }
        const csrf = req.get('x-csrf-token');
        if (!csrf || !constantTimeStringEqual(csrf, identity.csrf_token)) {
          sendError(res, 403, 'forbidden', 'CSRF token is invalid.');
          return;
        }
      }
      req.auth = identity;
      next();
    } catch {
      sendError(res, 500, 'internal_error', 'Authentication could not be completed.');
    }
  };
}

export type Registration = 'open' | 'closed';

export function createAuthRouter(
  pool: Pool,
  publicOrigin: string,
  { registration = 'open' }: { registration?: Registration } = {},
): Router {
  const router = express.Router();
  const checkOrigin = exactOrigin(publicOrigin);

  // Read by the sign-in page before it shows the registration form; it needs no sign-in.
  router.get('/registration', (_req, res) => {
    res.json({ registration });
  });

  router.post('/register', checkOrigin, async (req, res) => {
    if (registration === 'closed') {
      sendError(
        res,
        403,
        'registration_closed',
        'Registration is closed on this control plane. Ask its administrator for an account.',
      );
      return;
    }
    const parsed = parseCredentials(req.body);
    if (!('credentials' in parsed)) {
      sendError(res, 400, 'invalid_input', parsed.message, parsed.field);
      return;
    }
    let passwordHash: string;
    try {
      passwordHash = await argon2.hash(parsed.credentials.password, { type: argon2.argon2id });
    } catch {
      sendError(res, 500, 'internal_error', 'Registration could not be completed.');
      return;
    }
    let client: PoolClient;
    try {
      client = await pool.connect();
    } catch {
      sendError(res, 500, 'internal_error', 'Registration could not be completed.');
      return;
    }
    try {
      await client.query('BEGIN');
      const userId = randomUUID();
      const groupId = randomUUID();
      await client.query('INSERT INTO users (id, email, password_hash) VALUES ($1, $2, $3)', [
        userId,
        parsed.credentials.email,
        passwordHash,
      ]);
      await client.query('INSERT INTO groups (id) VALUES ($1)', [groupId]);
      await client.query('INSERT INTO memberships (group_id, user_id) VALUES ($1, $2)', [groupId, userId]);
      const login = await insertLoginSession(client, userId);
      await client.query('COMMIT');
      setSessionCookie(res, login.token);
      res.status(201).json(
        identityFromRow(
          {
            user_id: userId,
            email: parsed.credentials.email,
            group_id: groupId,
            expires_at: login.expiresAt,
          },
          login.csrfToken,
        ),
      );
    } catch (error) {
      await client.query('ROLLBACK').catch(() => undefined);
      if ((error as { code?: string }).code === '23505') {
        sendError(res, 409, 'invalid_input', 'An account with this email already exists.', 'email');
      } else {
        sendError(res, 500, 'internal_error', 'Registration could not be completed.');
      }
    } finally {
      client.release();
    }
  });

  router.post('/login', checkOrigin, async (req, res) => {
    const parsed = parseCredentials(req.body);
    if (!('credentials' in parsed)) {
      sendError(res, 400, 'invalid_input', parsed.message, parsed.field);
      return;
    }
    try {
      const result = await pool.query<{
        user_id: string;
        email: string;
        password_hash: string;
        group_id: string;
      }>(
        `SELECT u.id AS user_id, u.email, u.password_hash, m.group_id
           FROM users u
           JOIN memberships m ON m.user_id = u.id
          WHERE u.email = $1`,
        [parsed.credentials.email],
      );
      const row = result.rows.length === 1 ? result.rows[0] : null;
      let verified = false;
      if (row) {
        try {
          verified = await argon2.verify(row.password_hash, parsed.credentials.password);
        } catch {
          verified = false;
        }
      }
      if (!row || !verified) {
        sendError(res, 401, 'unauthenticated', 'Email or password is incorrect.');
        return;
      }
      const login = await insertLoginSession(pool, row.user_id);
      setSessionCookie(res, login.token);
      res.status(200).json(
        identityFromRow({ ...row, expires_at: login.expiresAt }, login.csrfToken),
      );
    } catch {
      sendError(res, 500, 'internal_error', 'Login could not be completed.');
    }
  });

  router.get('/me', requireUser(pool, publicOrigin), (req, res) => {
    res.status(200).json(req.auth);
  });

  router.post('/logout', requireUser(pool, publicOrigin), async (req, res) => {
    if (!hasExactKeys(req.body, [])) {
      sendError(res, 400, 'invalid_input', 'Request body must be an empty object.');
      return;
    }
    const token = readSessionToken(req.get('cookie'));
    if (!token) {
      sendError(res, 401, 'unauthenticated', 'Authentication is required.');
      return;
    }
    try {
      await pool.query(
        `UPDATE login_sessions
            SET revoked_at = now()
          WHERE token_hash = $1 AND user_id = $2 AND revoked_at IS NULL`,
        [sha256(token), req.auth.user_id],
      );
      clearSessionCookie(res);
      res.status(204).send();
    } catch {
      sendError(res, 500, 'internal_error', 'Logout could not be completed.');
    }
  });

  return router;
}
