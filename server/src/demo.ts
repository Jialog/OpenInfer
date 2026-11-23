// `npm run demo`: everything the website needs on one machine, then the server (main.ts). On the first start it makes a
// self-signed certificate for localhost and a PostgreSQL of its own, both under ./data; later starts reuse them. The
// catalogue is the simulator's, and the built website is served from the same address. A setting already in the
// environment (or .env) wins over each default here: DATABASE_URL, for one, uses another PostgreSQL instead.
import EmbeddedPostgres from 'embedded-postgres';
import { execFileSync } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { existsSync } from 'node:fs';
import { chmod, mkdir, readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { localOrigin } from './config.js';

const root = fileURLToPath(new URL('../..', import.meta.url));
const data = process.env.DEMO_DATA_DIR ?? join(root, 'data');
await mkdir(data, { recursive: true, mode: 0o700 });

const certificate = join(data, 'tls.crt'), key = join(data, 'tls.key');
if (!process.env.OPENINFER_TLS_CERT && !existsSync(certificate)) {
  execFileSync('openssl', ['req', '-x509', '-newkey', 'ec', '-pkeyopt', 'ec_paramgen_curve:P-256', '-nodes', '-days', '365', '-subj', '/CN=localhost',
    '-addext', 'subjectAltName=DNS:localhost,IP:127.0.0.1', '-keyout', key, '-out', certificate], { stdio: 'ignore' });
  await chmod(key, 0o600);
}

if (!process.env.DATABASE_URL) {
  // The database listens on this machine only, with a password made here and kept beside its files.
  const directory = join(data, 'postgres'), passwordFile = join(data, 'postgres-password'), port = Number(process.env.DEMO_DATABASE_PORT ?? 54329);
  const fresh = !existsSync(join(directory, 'PG_VERSION'));
  if (fresh) await writeFile(passwordFile, randomBytes(32).toString('hex'), { mode: 0o600 });
  const password = (await readFile(passwordFile, 'utf8')).trim();
  const database = new EmbeddedPostgres({ databaseDir: directory, user: 'openinfer', password, port, persistent: true, authMethod: 'scram-sha-256', autoRehydrateSymlinks: true,
    postgresFlags: ['-h', '127.0.0.1', '-c', 'unix_socket_directories='], onLog: () => {}, onError: () => {} });
  if (fresh) await database.initialise();
  // the package stops the database when this process ends (Ctrl-C included)
  await database.start().catch(() => { throw new Error(`PostgreSQL did not start on port ${port} with ${directory}. Is another demo still running?`); });
  process.env.DATABASE_URL = `postgresql://openinfer:${password}@127.0.0.1:${port}/postgres`;
}

const origin = localOrigin(process.env);
process.env.HOST ??= '127.0.0.1';
process.env.OPENINFER_ORIGIN ??= origin;
process.env.OPENINFER_LOCAL_URL ??= origin;
process.env.OPENINFER_TLS_CERT ??= certificate;
process.env.OPENINFER_TLS_KEY ??= key;
process.env.OPENINFER_CATALOG_FILE ??= join(root, 'simulator', 'catalog.json');
process.env.OPENINFER_WEB_DIR ??= join(root, 'web', 'dist');

console.info(`Open ${process.env.OPENINFER_ORIGIN} in a browser. Its certificate is self-signed (${process.env.OPENINFER_TLS_CERT}): the browser asks once before it shows the page.`);
console.info('Then start the simulated devices in another terminal: npm run devices -- --seed');
await import('./main.js');
