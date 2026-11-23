// Protocol objects shaped as the server sends them (docs/API.md), for unit tests and the fake backend.
import type {
  ApiErrorBody,
  ApiKey,
  Catalog,
  ConnectionTest,
  Device,
  Enrollment,
  Instance,
  Inventory,
  Preflight,
  Request,
  Session,
  Timing,
  VersionConfig,
} from '@/api/types';

let counter = 0;
export function uuid(): string {
  counter += 1;
  return `00000000-0000-4000-8000-${counter.toString(16).padStart(12, '0')}`;
}

export const NOW = '2026-11-08T12:00:00Z';

export function makeError(patch: Partial<ApiErrorBody> = {}): ApiErrorBody {
  return {code: 'invalid_input', message: 'Rejected.', field: null, device_id: null, phase: null, retryable: false, ...patch};
}

export function makeInventory(kind: 'mac' | 'linux', patch: Partial<Inventory> = {}): Inventory {
  const mac = kind === 'mac';
  return {
    agent_version: '0.1.0',
    openinfer_revision: 'a'.repeat(40),
    os: mac ? 'darwin' : 'linux',
    arch: mac ? 'arm64' : 'x86_64',
    machine_model: mac ? 'Mac mini' : 'Workstation',
    cpu_model: mac ? 'Apple M2 Pro' : 'x86_64 CPU',
    memory_total_bytes: '34359738368',
    memory_available_bytes: String(20 * 2 ** 30),
    disk_available_bytes: String(500 * 2 ** 30),
    control_plane_reserved_bytes: null,
    gpus: mac
      ? []
      : [{id: '0', model: 'RTX A5000', vendor: 'NVIDIA', total_bytes: String(24 * 2 ** 30),
          available_bytes: String(19 * 2 ** 30), compute_tflops: null, bandwidth_gbps: null, driver: '550'}],
    addresses: [{address: mac ? '192.0.2.10' : '192.0.2.20', interface: 'en0'}],
    python_executables: mac
      ? [{path: '/opt/agent/bin/python', version: '3.12', purpose: 'agent'},
         {path: '/opt/mlx/bin/python', version: '3.12', purpose: 'mlx'}]
      : [{path: '/opt/agent/bin/python', version: '3.12', purpose: 'agent'},
         {path: '/opt/helper/bin/python', version: '3.12', purpose: 'helper'}],
    engines: [{name: mac ? 'mlx' : 'llama.cpp', version: '1', available: true, build: null, error: null}],
    prepared_versions: [],
    local_model_folders: false,
    ...patch,
  };
}

export function makeDevice(patch: Partial<Device> & {kind?: 'mac' | 'linux'} = {}): Device {
  const {kind = 'mac', ...rest} = patch;
  return {
    id: uuid(),
    group_id: 'group-1',
    name: kind === 'mac' ? 'studio' : 'gpu-box',
    state: 'idle',
    cleanup_required: false,
    agent_boot_id: uuid(),
    address_revision: '1',
    last_heartbeat_at: NOW,
    heartbeat_deadline_at: NOW,
    reconciled_at: NOW,
    inventory: makeInventory(kind),
    reservation: null,
    instances: [],
    error: null,
    removed_at: null,
    created_at: NOW,
    ...rest,
  };
}

export function makeEnrollment(patch: Partial<Enrollment> = {}): Enrollment {
  return {
    id: uuid(),
    group_id: 'group-1',
    device_name: 'studio',
    state: 'pending',
    created_at: NOW,
    expires_at: new Date(Date.now() + 24 * 3600 * 1000).toISOString(),   // enrollment tokens last 24 hours (docs/API.md)
    device_id: null,
    token: 'one-time-token',
    control_urls: {local: 'https://127.0.0.1:8443', lan: 'https://192.0.2.10:8443'},
    certificate_sha256: 'c'.repeat(64),
    ...patch,
  };
}

export function makeTest(patch: Partial<ConnectionTest> = {}): ConnectionTest {
  return {
    id: uuid(),
    source_device_id: 'source',
    target_device_id: 'target',
    source_boot_id: uuid(),
    target_boot_id: uuid(),
    source_address_revision: '1',
    target_address_revision: '1',
    target_addresses: ['192.0.2.10'],
    source_address: null,
    target_address: null,
    port: 40360,
    listener_python: '/opt/mlx/bin/python',
    state: 'listening',
    listener_ready_at: null,
    listener_closed_at: null,
    started_at: NOW,
    deadline_at: NOW,
    finished_at: null,
    valid_until: null,
    valid: false,
    invalid_reason: null,
    rtt_median_ms: null,
    transfer_bytes: null,
    transfer_ms: null,
    error: null,
    ...patch,
  };
}

export function makeSession(patch: Partial<Session> = {}): Session {
  return {
    id: uuid(),
    group_id: 'group-1',
    created_by: 'user-1',
    idempotency_key: uuid(),
    model: 'Qwen3.8-27B',
    state: 'starting',
    plan: {service_device_id: 'mac', service_version_id: 'service-v1',
           helpers: [{device_id: 'helper', version_id: 'helper-v1', draft_model: 'enabled',
                      acknowledge_no_draft_model: false, connection_test_id: 'test-1'}]},
    max_active_requests: 1,
    config_sha256: 'd'.repeat(64),
    effective_config: {versions: []},
    phase: 'prepare',
    phase_started_at: NOW,
    phase_deadline_at: null,
    service_disconnect_deadline_at: null,
    drain_deadline_at: null,
    term_deadline_at: null,
    stop_deadline_at: null,
    submissions_blocked: false,
    stop_cause: null,
    error: null,
    instances: [],
    active_request_ids: [],
    uncleared_device_ids: [],
    created_at: NOW,
    ended_at: null,
    ...patch,
  };
}

export function makeInstance(patch: Partial<Instance> = {}): Instance {
  return {
    instance_id: uuid(), session_id: 'session-1', agent_boot_id: uuid(), generation: 1, state: 'starting', phase: 'prepare',
    config_sha256: 'd'.repeat(64), processes: [], http_healthy: false, push_listening: false, calibrated: false,
    peer_instance_id: null, push_connection_id: null,
    metrics: {load_seconds: null, peak_memory_bytes: null, tokenizer_mapping_id: null, step_cost: [], effective_spec: null},
    error: null, device_id: 'mac', created_at: NOW, phase_started_at: NOW, phase_deadline_at: null, stopped_at: null, progress: null,
    ...patch,
  };
}

export const emptyTiming: Timing = {
  clock_id: null,
  engine_received_ns: null,
  engine_first_output_ns: null,
  engine_last_output_ns: null,
  engine_first_chunk_tokens: null,
  engine_finished_ns: null,
  engine_started_at: null,
  engine_finished_at: null,
};

export function makeRequest(patch: Partial<Request> = {}): Request {
  return {
    id: uuid(),
    session_id: 'session-1',
    user_id: 'user-1',
    instance_id: uuid(),
    submission_id: uuid(),
    state: 'running',
    input: {prompt: 'hello'},
    seed: '1234567890123456789',
    sampling: {temperature: 1, top_p: 0.95, top_k: 20, min_p: 0, presence_penalty: 0},
    requested_max_output: null,
    prompt_tokens: 10,
    effective_max_output: 4086,
    committed_position: null,
    contiguous_seq: '0',
    final_seq: null,
    output_tokens: '0',
    timing: {...emptyTiming},
    statistics: {helper_draft_tokens: null, helper_verified_tokens: null, accepted_external_tokens: null, think_end_position: null},
    engine_end: null,
    no_output_deadline_at: NOW,
    disconnect_deadline_at: null,
    persistence_deadline_at: NOW,
    cancel_deadline_at: null,
    cancel_reason: null,
    engine_released_at: null,
    archive_state: 'pending',
    archive_error: null,
    prompt_file: null,
    result_sha256: null,
    received_at: NOW,
    started_at: null,
    ended_at: null,
    error: null,
    source: 'web',
    api_key_id: null,
    ...patch,
  };
}

export function makeApiKey(patch: Partial<ApiKey> = {}): ApiKey {
  return {id: uuid(), name: 'scripts', hint: 'oi_Ab3x', created_at: NOW, last_used_at: null, revoked_at: null, ...patch};
}

export function makePreflight(patch: Partial<Preflight> = {}): Preflight {
  return {
    checked_at: NOW,
    allowed: true,
    plan: makeSession().plan,
    checks: [{code: 'platform', passed: true, device_id: null, message: 'Platform supported.', required_bytes: null, available_bytes: null}],
    config_sha256: 'e'.repeat(64),
    ...patch,
  };
}

const GiB = 2 ** 30;
function helperVersion(id: string, label: string, patch: Partial<VersionConfig> = {}): VersionConfig {
  return {id, role: 'helper', label, model: 'Qwen3.8-27B', repo: 'r', revision: 'y', quantization: 'q', files: [], manifest_sha256: 'b'.repeat(64),
          engine: 'llama.cpp', build_requirements: null, draft_model: {enabled: true}, compatible_service_version_ids: ['service-v1'],
          validation: {hardware: [], evidence: [], complete: true, missing: []}, platform: {os: 'linux', arch: 'x86_64', gpu_vendor: 'NVIDIA'},
          launch_spec: {}, ...patch};
}

/** A catalog as GET /catalog returns it: three helper versions Placement chooses from (most precise first, with the free GPU
 *  memory and disk each needs) and one incomplete helper version it does not. */
export function makeCatalog(): Catalog {
  return {
    models: {'Qwen3.8-27B': {context_length: 4096}},
    service_version_id: 'service-v1',
    versions: [
      {id: 'service-v1', role: 'service', label: 'Qwen3.8-27B MLX 4-bit', model: 'Qwen3.8-27B', repo: 'r', revision: 'x', quantization: '4bit', files: [], manifest_sha256: 'a'.repeat(64), engine: 'mlx', build_requirements: null, draft_model: null, compatible_service_version_ids: [], validation: {hardware: [], evidence: [], complete: true, missing: []}, platform: {os: 'darwin', arch: 'arm64', gpu_vendor: null}, launch_spec: {}},
      helperVersion('helper-v1', 'UD-Q3_K_XL + draft Q4_K_M, 5 drafts a round'),
      helperVersion('helper-v2', 'UD-Q2_K_XL candidate', {manifest_sha256: null, draft_model: null, launch_spec: null,
        validation: {hardware: [], evidence: [], complete: false, missing: ['draft model parameters']}}),
      helperVersion('helper-small', 'UD-Q2_K_XL + draft Q4_K_M, 5 drafts a round'),
      helperVersion('helper-big', 'UD-Q8_K_L + draft Q4_K_M, 5 drafts a round'),
    ],
    placement: {'service-v1': [
      {version_id: 'helper-big', memory_bytes: String(33 * GiB), disk_bytes: String(27 * GiB)},
      {version_id: 'helper-v1', memory_bytes: String(19 * GiB), disk_bytes: String(13 * GiB)},
      {version_id: 'helper-small', memory_bytes: String(16 * GiB), disk_bytes: String(10 * GiB)},
    ]},
  };
}
