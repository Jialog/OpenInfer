import assert from 'node:assert/strict';
import { randomBytes, randomUUID } from 'node:crypto';
import { after, before, test } from 'node:test';

import { ControlPlane } from '../src/control.ts';
import { Fault } from '../src/protocol.ts';
import { MemoryObjectStore } from '../src/storage.ts';
import { createDatabase } from './postgres.ts';
import { fixtureCatalog, fixtureProof, inventory, setupPair } from './fixtures.ts';

// Placement chooses the helper version in the preflight:
// among the catalog's helper versions with a draft model, the most precise one (lowest precision_rank; at equal precision
// the one with more drafts a round) whose memory_bytes is at most the free memory of the helper's card with the most of
// it. Where a version runs is its catalog `platform`: here a helper is any Linux x86_64 machine with an NVIDIA card, a
// service any Apple Silicon Mac; hardware not in the version's `validation.hardware` is marked unverified.

let database: Awaited<ReturnType<typeof createDatabase>>;
before(async () => { database = await createDatabase(); });
after(async () => { await database.close(); });

// Four candidates, listed out of order: ranks 2, 3, 3 and 4; rank 3 with 5 and with 3 drafts a round. Ahead of them, three
// rank-1 versions with the smallest needs that Placement must never choose: one without a draft model, one incomplete,
// one not paired with the service version.
function placementCatalog() {
  const options: any = fixtureCatalog();
  const base = options.catalog.versions.find((v: any) => v.id === 'helper');
  options.catalog.versions = options.catalog.versions.filter((v: any) => v.id !== 'helper');
  delete options.requirements.helper;
  const add = (id: string, patch: Record<string, unknown>, requirement: Record<string, unknown>) => {
    options.catalog.versions.push({ ...structuredClone(base), id, label: `fixture ${id}`, ...patch });
    options.requirements[id] = { disk_bytes: '100', ...requirement };
  };
  add('plain', { draft_model: { enabled: false, mechanism: null, draft_repo: null, draft_revision: null, files: [], parameters: {} } },
    { memory_bytes: '10', precision_rank: 1, without_draft_allowed: true });
  add('incomplete', { validation: { hardware: [], evidence: [], complete: false, missing: ['measured memory'] } }, { memory_bytes: '10', precision_rank: 1 });
  add('unpaired', { compatible_service_version_ids: [] }, { memory_bytes: '10', precision_rank: 1 });
  for (const [id, rank, drafts, memory, disk] of [['q2', 4, 5, 1000, 400], ['q4-d3', 3, 3, 1500, 600], ['q8', 2, 5, 3000, 800], ['q4-d5', 3, 5, 2000, 600]] as const) {
    add(id, { draft_model: { ...base.draft_model, parameters: { drafts_per_round: drafts } } }, { memory_bytes: String(memory), disk_bytes: String(disk), precision_rank: rank });
  }
  return options;
}

const gpu = (id: string, available: number | string, patch: Record<string, unknown> = {}) => ({
  id, model: 'fixture NVIDIA card', vendor: 'NVIDIA', total_bytes: '1000000000000', available_bytes: String(available),
  compute_tflops: null, bandwidth_gbps: null, driver: 'fixture', ...patch,
});

async function report(pair: any, role: 'service' | 'helper', patch: Record<string, unknown>) {
  await pair.send(role, 'heartbeat', { agent_boot_id: pair.devices[role].boot, inventory: { ...inventory(role), ...patch }, instances: [] });
}

const placed = (plan: any) => ({ ...plan, helpers: [{ ...plan.helpers[0], version_id: null }] });
const named = (plan: any, version_id: string) => ({ ...plan, helpers: [{ ...plan.helpers[0], version_id }] });
const helperCheck = (preflight: any, pair: any, code: string) => preflight.checks.find((c: any) => c.code === code && c.device_id === pair.devices.helper.id);

async function placementPair() {
  const plane = new ControlPlane(database.pool, new MemoryObjectStore(), placementCatalog());
  const pair = await setupPair(plane, database.pool);
  return { plane, pair };
}

test('Placement chooses the most precise version whose memory fits, more drafts first at equal precision', async () => {
  const { plane, pair } = await placementPair();
  // free memory between two versions, exactly a version's need, one byte short of it
  for (const [free, chosen] of [[2500, 'q4-d5'], [2000, 'q4-d5'], [1999, 'q4-d3'], [1500, 'q4-d3'], [1499, 'q2'], [1000, 'q2'], [5000, 'q8']] as const) {
    await report(pair, 'helper', { gpus: [gpu('0', free)] });
    const preflight = await plane.preflight(pair.user, placed(pair.plan));
    assert.equal(preflight.plan.helpers[0].version_id, chosen, `free ${free}`);
    assert.equal(preflight.allowed, true, `free ${free}`);
    const capacity = helperCheck(preflight, pair, 'capacity_insufficient');
    assert.equal(capacity.passed, true);
    assert.equal(capacity.required_bytes, placementCatalog().requirements[chosen].memory_bytes);
    assert.equal(capacity.available_bytes, String(free));
    // the rest of the plan is returned as sent
    assert.deepEqual({ ...preflight.plan, helpers: [{ ...preflight.plan.helpers[0], version_id: null }] }, placed(pair.plan));
  }
});

test('the capacity check names each more precise version Placement skipped and how much it lacks', async () => {
  const { plane, pair } = await placementPair();
  await report(pair, 'helper', { gpus: [gpu('0', 1700)] });
  const preflight = await plane.preflight(pair.user, placed(pair.plan));
  assert.equal(preflight.plan.helpers[0].version_id, 'q4-d3');
  const capacity = helperCheck(preflight, pair, 'capacity_insufficient');
  assert.match(capacity.message, /fixture q8\b.*3000 bytes.*1300 bytes/);
  assert.match(capacity.message, /fixture q4-d5\b.*2000 bytes.*300 bytes/);
  assert.doesNotMatch(capacity.message, /fixture q2\b/);
});

test('Placement chooses only complete versions with a draft model, paired with the service version', async () => {
  const { plane, pair } = await placementPair();
  await report(pair, 'helper', { gpus: [gpu('0', 5000)] });
  assert.equal((await plane.preflight(pair.user, placed(pair.plan))).plan.helpers[0].version_id, 'q8');
  // the three rank-1 versions need only 10 bytes, but are no candidates even when nothing else fits
  await report(pair, 'helper', { gpus: [gpu('0', 999)] });
  assert.equal((await plane.preflight(pair.user, placed(pair.plan))).plan.helpers[0].version_id, null);
  assert.deepEqual(plane.catalog().placement[pair.plan.service_version_id].map((p: any) => p.version_id), ['q8', 'q4-d5', 'q4-d3', 'q2']);
});

// A version fits when both its GPU memory and its files fit.
test('a version fits only when its files also fit the free disk, and the capacity check says which is short', async () => {
  const { plane, pair } = await placementPair();
  for (const [disk, chosen] of [[700, 'q4-d5'], [600, 'q4-d5'], [599, 'q2'], [400, 'q2']] as const) {
    await report(pair, 'helper', { gpus: [gpu('0', 5000)], disk_available_bytes: String(disk) });
    const preflight = await plane.preflight(pair.user, placed(pair.plan));
    assert.equal(preflight.plan.helpers[0].version_id, chosen, `disk ${disk}`);
    assert.equal(preflight.allowed, true, `disk ${disk}`);
  }
  await report(pair, 'helper', { gpus: [gpu('0', 2500)], disk_available_bytes: '700' });
  const capacity = helperCheck(await plane.preflight(pair.user, placed(pair.plan)), pair, 'capacity_insufficient');
  // q8 lacks GPU memory and disk, so both are named; q4-d5 is chosen
  assert.match(capacity.message, /fixture q8\b.*3000 bytes of GPU memory, 500 bytes more than are free.*800 bytes of disk, 100 bytes more than are free/);
});

// A device with folders of the user's own model files (--models) may have every file already;
// how many bytes are missing is known only once its preparation checked them, so the disk does not rule a version out
// before then (the device's preparation checks the bytes really missing, before any download).
test('a device with model folders of its own is not refused for the disk before its preparation knows what is missing', async () => {
  const { plane, pair } = await placementPair();
  await report(pair, 'helper', { gpus: [gpu('0', 5000)], disk_available_bytes: '300', local_model_folders: true });
  const preflight = await plane.preflight(pair.user, placed(pair.plan));
  assert.equal(preflight.plan.helpers[0].version_id, 'q8');      // the most precise whose GPU memory fits
  assert.equal(preflight.allowed, true);
  const disk = helperCheck(preflight, pair, 'disk_insufficient');
  assert.equal(disk.passed, true);
  assert.match(disk.message, /folders of model files of its own.*checks how many bytes are missing.*before it downloads/);
  // the serving machine the same: all of its weights on another disk, the cache's disk nearly full
  await report(pair, 'service', { disk_available_bytes: '1', local_model_folders: true });
  assert.equal((await plane.preflight(pair.user, placed(pair.plan))).allowed, true);
  // without folders of its own, the files' total is what is missing
  await report(pair, 'service', { disk_available_bytes: '1', local_model_folders: false });
  const refused = await plane.preflight(pair.user, placed(pair.plan));
  assert.equal(refused.allowed, false);
  assert.deepEqual(refused.checks.filter((c: any) => !c.passed).map((c: any) => [c.code, c.device_id]), [['disk_insufficient', pair.devices.service.id]]);
});

// Devices and the control plane are upgraded one at a time: a device of the release before reports no
// local_model_folders; registration, reconcile and heartbeat take its inventory, read as no model folders of its own.
test('an inventory without local_model_folders counts as a device without model folders of its own', async () => {
  const { plane, pair } = await placementPair();
  const older = (role: 'service' | 'helper', patch: Record<string, unknown> = {}) => {
    const { local_model_folders: _, ...rest } = { ...inventory(role), ...patch };
    return rest;
  };
  const token = await plane.enrollment(pair.user, 'older');
  const enrolled = await plane.enroll({ enrollment_token: token.token, credential: randomBytes(32).toString('base64url'), agent_boot_id: randomUUID(), inventory: older('helper') });
  const stored = await database.pool.query('SELECT inventory FROM devices WHERE id=$1', [enrolled.device_id]);
  assert.equal(stored.rows[0].inventory.local_model_folders, false);
  const boot = pair.devices.helper.boot;
  await pair.reopen('helper');
  await pair.send('helper', 'reconcile', { agent_boot_id: boot, inventory: older('helper'), instances: [], commands: [], requests: [] });
  await pair.send('helper', 'heartbeat', { agent_boot_id: boot, inventory: older('helper', { gpus: [gpu('0', 5000)], disk_available_bytes: '700' }), instances: [] });
  const preflight = await plane.preflight(pair.user, placed(pair.plan));
  assert.equal(preflight.plan.helpers[0].version_id, 'q4-d5');    // q8's 800 bytes do not fit 700: the files' total counts
  assert.equal(preflight.allowed, true);
});

test('when the disk is what no version fits, the disk check fails with the smallest need of the versions whose GPU memory fits', async () => {
  const { plane, pair } = await placementPair();
  await report(pair, 'helper', { gpus: [gpu('0', 1600)], disk_available_bytes: '300' });
  const preflight = await plane.preflight(pair.user, placed(pair.plan));
  assert.equal(preflight.allowed, false);
  assert.equal(preflight.plan.helpers[0].version_id, null);
  assert.deepEqual(preflight.checks.filter((c: any) => !c.passed).map((c: any) => c.code), ['disk_insufficient']);
  const disk = helperCheck(preflight, pair, 'disk_insufficient');
  assert.deepEqual([disk.required_bytes, disk.available_bytes], ['400', '300']);
  assert.match(disk.message, /No helper version fits/);
  assert.match(disk.message, /fixture q4-d3\b.*600 bytes of disk, 300 bytes more than are free/);
  assert.match(disk.message, /fixture q8\b.*3000 bytes of GPU memory, 1400 bytes more than are free/);
});

test('when no version fits, the capacity check fails with the smallest need and no version is chosen', async () => {
  const { plane, pair } = await placementPair();
  await report(pair, 'helper', { gpus: [gpu('0', 999)] });
  const preflight = await plane.preflight(pair.user, placed(pair.plan));
  assert.equal(preflight.allowed, false);
  assert.equal(preflight.config_sha256, null);
  assert.equal(preflight.plan.helpers[0].version_id, null);
  const capacity = helperCheck(preflight, pair, 'capacity_insufficient');
  assert.equal(capacity.passed, false);
  assert.equal(capacity.required_bytes, '1000');
  assert.equal(capacity.available_bytes, '999');
  // memory is the only reason: the other checks hold for the smallest version
  assert.deepEqual(preflight.checks.filter((c: any) => !c.passed).map((c: any) => c.code), ['capacity_insufficient']);
});

test('a version the user names is checked as named and never replaced', async () => {
  const { plane, pair } = await placementPair();
  await report(pair, 'helper', { gpus: [gpu('0', 2500)] });
  const smaller = await plane.preflight(pair.user, named(pair.plan, 'q2'));
  assert.equal(smaller.allowed, true);
  assert.equal(smaller.plan.helpers[0].version_id, 'q2');
  const larger = await plane.preflight(pair.user, named(pair.plan, 'q8'));
  assert.equal(larger.allowed, false);
  assert.equal(larger.plan.helpers[0].version_id, 'q8');
  const capacity = helperCheck(larger, pair, 'capacity_insufficient');
  assert.deepEqual([capacity.passed, capacity.required_bytes, capacity.available_bytes], [false, '3000', '2500']);
});

test('Placement reads the card of the helper with the most free memory, and the helper runs on it', async () => {
  const { plane, pair } = await placementPair();
  // the card with the most free memory is not the first the inventory lists
  await report(pair, 'helper', { gpus: [gpu('0', 1200), gpu('1', 9000)] });
  const preflight = await plane.preflight(pair.user, placed(pair.plan));
  assert.equal(preflight.plan.helpers[0].version_id, 'q8');
  assert.equal(helperCheck(preflight, pair, 'capacity_insufficient').available_bytes, '9000');
  await plane.createSession(pair.user, randomUUID(), preflight.plan);
  for (const role of ['service', 'helper'] as const) {
    const prepare = await pair.next(role, 'prepare');
    await pair.result(role, prepare, { manifest_sha256: 'a'.repeat(64), prepared_version_id: prepare.payload.version.id, build: fixtureProof(prepare.payload.version) });
  }
  const start = await pair.next('service', 'start_service');
  await pair.result('service', start, { instance: await pair.report('service', 'connectable') });
  const helper = await pair.next('helper', 'start_helper');
  assert.equal(helper.payload.entry.environment.gpu, '1');
});

test('a session is created only with a named version: the one the preflight plan returns', async () => {
  const { plane, pair } = await placementPair();
  await report(pair, 'helper', { gpus: [gpu('0', 2500)] });
  await assert.rejects(plane.createSession(pair.user, randomUUID(), placed(pair.plan)),
    (e: any) => e instanceof Fault && e.status === 400 && e.code === 'invalid_input' && e.field === 'helpers.0.version_id');
  const preflight = await plane.preflight(pair.user, placed(pair.plan));
  const session = await plane.createSession(pair.user, randomUUID(), preflight.plan);
  assert.equal(session.plan.helpers[0].version_id, 'q4-d5');
  const prepare = await pair.next('helper', 'prepare');
  assert.equal(prepare.payload.version.id, 'q4-d5');
});

test('any Linux x86_64 helper with an NVIDIA card is allowed when a version fits, whatever the card', async () => {
  const { plane, pair } = await placementPair();
  await report(pair, 'helper', { machine_model: 'fixture workstation', gpus: [gpu('0', String(23 * 2 ** 30), { model: 'RTX A5000' })] });
  const preflight = await plane.preflight(pair.user, named(pair.plan, 'q8'));
  assert.equal(preflight.allowed, true);
  assert.equal(helperCheck(preflight, pair, 'hardware_unvalidated').passed, true);
  assert.equal(helperCheck(preflight, pair, 'capacity_insufficient').available_bytes, String(23 * 2 ** 30));
});

test('a helper that is not Linux x86_64, or has no NVIDIA card, is refused', async () => {
  const { plane, pair } = await placementPair();
  for (const [patch, code] of [
    [{ os: 'darwin', arch: 'arm64' }, 'unsupported_platform'],
    [{ os: 'windows', arch: 'x86_64' }, 'unsupported_platform'],
    [{ arch: 'aarch64' }, 'unsupported_platform'],
    [{ gpus: [] }, 'hardware_unvalidated'],
    [{ gpus: [gpu('0', 5000, { vendor: 'AMD', model: 'Radeon fixture' })] }, 'hardware_unvalidated'],
  ] as const) {
    await report(pair, 'helper', { gpus: [gpu('0', 5000)], ...patch });
    const preflight = await plane.preflight(pair.user, named(pair.plan, 'q2'));
    assert.equal(preflight.allowed, false, JSON.stringify(patch));
    assert.equal(helperCheck(preflight, pair, code).passed, false, JSON.stringify(patch));
  }
});

test('any Mac of the platform of the version whose memory fits may serve; one it was not measured on is marked unverified', async () => {
  const options: any = fixtureCatalog();
  options.catalog.versions[0].validation.hardware = ['Apple M2 Pro'];
  const plane = new ControlPlane(database.pool, new MemoryObjectStore(), options);
  const pair = await setupPair(plane, database.pool);
  const serviceCheck = (preflight: any, code: string) => preflight.checks.find((c: any) => c.code === code && c.device_id === pair.devices.service.id);

  await report(pair, 'service', { machine_model: 'MacBook Pro', cpu_model: 'Apple M3 Pro', memory_total_bytes: String(18 * 2 ** 30) });
  const other = await plane.preflight(pair.user, pair.plan);
  assert.equal(other.allowed, true);
  const mark = serviceCheck(other, 'hardware_unverified');
  assert.equal(mark.passed, true);
  assert.match(mark.message, /Apple M3 Pro/);
  assert.match(mark.message, /Apple M2 Pro/);
  assert.equal(serviceCheck(other, 'hardware_unvalidated'), undefined);      // the version needs no graphics card

  // an M2 Pro in another machine or with more memory is hardware the version was measured on
  await report(pair, 'service', { machine_model: 'MacBook Pro', memory_total_bytes: String(64 * 2 ** 30) });
  const measured = await plane.preflight(pair.user, pair.plan);
  assert.equal(measured.allowed, true);
  assert.equal(serviceCheck(measured, 'hardware_unverified'), undefined);

  // an Intel Mac is not the version's platform
  await report(pair, 'service', { arch: 'x86_64', cpu_model: 'Intel fixture' });
  const intel = await plane.preflight(pair.user, pair.plan);
  assert.equal(intel.allowed, false);
  assert.equal(serviceCheck(intel, 'unsupported_platform').passed, false);
});

test('the catalog response lists the versions Placement chooses from, in its order, with their memory and disk needs', async () => {
  const plane = new ControlPlane(database.pool, new MemoryObjectStore(), placementCatalog());
  const catalog = plane.catalog();
  assert.deepEqual(catalog.versions, plane.options.catalog.versions);
  assert.deepEqual(catalog.placement, { [catalog.service_version_id]: [
    { version_id: 'q8', memory_bytes: '3000', disk_bytes: '800' },
    { version_id: 'q4-d5', memory_bytes: '2000', disk_bytes: '600' },
    { version_id: 'q4-d3', memory_bytes: '1500', disk_bytes: '600' },
    { version_id: 'q2', memory_bytes: '1000', disk_bytes: '400' },
  ] });
});
