// docs/API.md names every route the server has: a route added without a word in the document fails here.
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { test } from 'node:test';

const read = (path: string) => readFile(new URL(path, import.meta.url), 'utf8');
// a path with its parameters blanked, so /devices/:id and /devices/{id} are the same route
const shape = (path: string) => path.replace(/:\w+|\{\w+\}/g, '{}');

test('every route of the server is in docs/API.md, with its method', async () => {
  const [server, auth, openai, doc] = await Promise.all([read('../src/server.ts'), read('../src/auth.ts'), read('../src/openai.ts'), read('../../docs/API.md')]);
  const routes = [
    ...[...server.matchAll(/app\.(get|post)\('(\/api\/v1[^']*)'/g)].map((m) => [m[1], m[2]]),
    ...[...auth.matchAll(/router\.(get|post)\(\s*'(\/[^']*)'/g)].map((m) => [m[1], `/api/v1/auth${m[2]}`]),
    ...[...openai.matchAll(/router\.(get|post)\('(\/[^']*)'/g)].map((m) => [m[1], `/v1${m[2]}`]),
    ['get', '/api/v1/ws/browser'], ['get', '/api/v1/ws/device'],
  ];
  assert.ok(routes.length >= 30, `found only ${routes.length} routes; the patterns no longer match the source`);
  const documented = new Set([...doc.matchAll(/`(GET|POST) (\/[^`?\s]*)/g)].map((m) => `${m[1]} ${shape(m[2])}`));
  const websockets = new Set([...doc.matchAll(/wss:\/\/[^/`]+(\/api\/v1\/ws\/\w+)/g)].map((m) => `GET ${m[1]}`));
  const missing = routes.map(([method, path]) => `${method.toUpperCase()} ${shape(path)}`).filter((route) => !documented.has(route) && !websockets.has(route));
  assert.deepEqual(missing, []);
});
