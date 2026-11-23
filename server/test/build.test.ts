import assert from 'node:assert/strict';
import { after, before, test } from 'node:test';
import { randomUUID } from 'node:crypto';

import { ControlPlane } from '../src/control.ts';
import { parseDeployment } from '../src/config.ts';
import { MemoryObjectStore } from '../src/storage.ts';
import { createDatabase } from './postgres.ts';
import { fixtureCatalog, fixtureDeployment, fixtureProof, inventory, setupPair } from './fixtures.ts';

// A version's build_requirements names what holds on any machine (source and bridge versions,
// required options); a device reports its own BuildProof (its paths, digests and every option), compared on those.
let database: Awaited<ReturnType<typeof createDatabase>>;

before(async () => {
  database = await createDatabase();
});

after(async () => {
  await database.close();
});

// A deployment JSON as the server reads one from its catalog file.
const deployment = async () => fixtureDeployment();

// That deployment JSON as the control plane runs it, with a pair of devices whose plan names its versions:
// the service version and the helper version Placement chooses for the fixture helper's card.
async function deployed() {
  const { controlUrls, certificateSha256 } = fixtureCatalog();
  const plane = new ControlPlane(database.pool, new MemoryObjectStore(), { ...parseDeployment(await deployment()), controlUrls, certificateSha256 });
  const pair = await setupPair(plane, database.pool);
  const service = plane.catalog().service_version_id;
  const placed = await plane.preflight(pair.user, { ...pair.plan, service_version_id: service, helpers: [{ ...pair.plan.helpers[0], version_id: null }] });
  assert.ok(placed.plan.helpers[0].version_id);
  pair.plan = placed.plan;
  return { plane, pair };
}

// Create the session and answer both prepares with PROOF(role, version).
async function prepare(plane: ControlPlane, pair: any, proof: (role: string, version: any) => any) {
  const session = await plane.createSession(pair.user, randomUUID(), pair.plan);
  for (const role of ['service', 'helper']) {
    const command = await pair.next(role, 'prepare');
    const version = command.payload.version;
    await pair.result(role, command, { manifest_sha256: version.manifest_sha256, prepared_version_id: version.id, build: proof(role, version) });
  }
  return plane.getSession(pair.user, session.id);
}

test('the deployment JSON of these tests loads, so a refusal below is of the change it names', async () => {
  const parsed = parseDeployment(await deployment());
  assert.deepEqual(parsed.catalog.versions.map((v: any) => v.role).sort(), ['helper', 'service']);
});

test('required options are strings, as a device reports them', async () => {
  for (const [role, key, wrong] of [['helper', 'GGML_CUDA', true], ['service', 'python', 3.12]] as const) {
    const value = await deployment();
    const version = value.catalog.versions.find((v: any) => v.role === role);
    version.build_requirements.options[key] = wrong;
    assert.throws(() => parseDeployment(value));
  }
});

test('a deployment JSON that still names binary digests and library paths is refused', async () => {
  const value = await deployment();
  const helper = value.catalog.versions.find((v: any) => v.role === 'helper');
  helper.build_requirements = { ...helper.build_requirements, compiler: 'c++', cuda: '13.1', binary_sha256: 'a'.repeat(64), libraries: [{ path: '/opt/llama/libllama.so', sha256: 'b'.repeat(64) }] };
  assert.throws(() => parseDeployment(value));
});

test('builds of the same versions in two directories, for two cards, both pass the prepare', async () => {
  for (const [directory, architecture] of [['/srv/first/llama.cpp/build/bin', '89'], ['/opt/second/build/bin', '86']]) {
    const { plane, pair } = await deployed();
    const session = await prepare(plane, pair, (role, version) =>
      fixtureProof(version, directory, role === 'helper' ? { options: { ...version.build_requirements.options, CMAKE_CUDA_ARCHITECTURES: architecture } } : {}));
    assert.equal(session.error, null);
    assert.equal(session.state, 'starting');
    assert.ok(await pair.next('service', 'start_service'));
  }
});

test('a proof of another source commit is a build mismatch that names it', async () => {
  const { plane, pair } = await deployed();
  const session = await prepare(plane, pair, (role, version) =>
    fixtureProof(version, '/srv/build', role === 'helper' ? { source_revision: 'c'.repeat(40) } : {}));
  assert.equal(session.state, 'stopping');
  assert.equal(session.error.code, 'build_mismatch');
  assert.match(session.error.message, /source_revision/);
});

test('a proof of another bridge revision is a build mismatch that names it', async () => {
  const { plane, pair } = await deployed();
  const session = await prepare(plane, pair, (role, version) =>
    fixtureProof(version, '/srv/build', role === 'helper' ? { bridge_revision: 'b'.repeat(64) } : {}));
  assert.equal(session.state, 'stopping');
  assert.equal(session.error.code, 'build_mismatch');
  assert.match(session.error.message, /build\.bridge_revision/);
});

test('a proof without a required build option is a build mismatch that names it', async () => {
  const { plane, pair } = await deployed();
  const session = await prepare(plane, pair, (role, version) => {
    const proof = fixtureProof(version, '/srv/build');
    if (role === 'helper') delete (proof.options as any).GGML_CUDA;
    return proof;
  });
  assert.equal(session.error.code, 'build_mismatch');
  assert.match(session.error.message, /options\.GGML_CUDA/);
});

test('preflight counts a build a device reports from its own directory as a match', async () => {
  const plane = new ControlPlane(database.pool, new MemoryObjectStore(), fixtureCatalog());
  const pair = await setupPair(plane, database.pool);
  const helper = plane.options.catalog.versions.find((v: any) => v.id === 'helper');
  const reported = inventory('helper');
  reported.engines[0].build = fixtureProof(helper, '/anywhere/build') as any;
  await pair.send('helper', 'heartbeat', { agent_boot_id: pair.devices.helper.boot, inventory: reported, instances: [] });
  const checks = (await plane.preflight(pair.user, pair.plan)).checks.filter((c: any) => c.device_id === pair.devices.helper.id);
  assert.deepEqual(checks.filter((c: any) => c.code.startsWith('build_')).map((c: any) => [c.code, c.passed]), [['build_match', true]]);
});
