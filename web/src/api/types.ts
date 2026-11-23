// Protocol types of the server's API (docs/API.md). These describe the wire format; nothing here is logic.

export type ID = string;
export type Time = string;
export type U64 = string;
export type Sha256 = string;

export type ApiErrorBody = {
  code: string;
  message: string;
  field: string | null;
  device_id: ID | null;
  phase: string | null;
  retryable: boolean;
};

export type Identity = {
  user_id: ID;
  email: string;
  group_id: ID;
  csrf_token: string;
  expires_at: Time;
};

export type Enrollment = {
  id: ID;
  group_id: ID;
  device_name: string;
  state: 'pending' | 'consumed' | 'expired';
  created_at: Time;
  expires_at: Time;
  device_id: ID | null;
  token: string | null;
  control_urls: {local: string; lan: string};
  certificate_sha256: Sha256;
};

export type TestPlan = {
  source_device_id: ID;
  target_device_id: ID;
  target_addresses: string[];
  port: number;
  listener_python: string;
};

export type HelperPlan = {
  device_id: ID;
  /** null only in a preflight: Placement chooses the version, and the returned plan names it (docs/API.md). */
  version_id: string | null;
  draft_model: 'enabled' | 'disabled';
  acknowledge_no_draft_model: boolean;
  connection_test_id: ID;
};

export type SessionPlan = {
  service_device_id: ID;
  service_version_id: string;
  helpers: HelperPlan[];
};

/** A prompt uploaded as a .txt or .md file; its bytes are in the storage bucket. */
export type PromptFile = {id: ID; name: string; size_bytes: number};

export type RequestInput = {
  prompt?: string;
  /** The uploaded file the prompt is read from, instead of `prompt`. */
  prompt_file_id?: ID;
  acceptance_prompt_id?: string;
  max_output_tokens?: number;
};

export type PreflightCheck = {
  code: string;
  passed: boolean;
  device_id: ID | null;
  message: string;
  required_bytes: U64 | null;
  available_bytes: U64 | null;
};

export type Preflight = {
  checked_at: Time;
  allowed: boolean;
  plan: SessionPlan;
  checks: PreflightCheck[];
  config_sha256: Sha256 | null;
};

export type AcceptancePrompt = {
  id: string;
  label: string;
  resource_sha256: Sha256;
  max_output_tokens: number;
};

export type DeviceState = 'idle' | 'occupied' | 'cleanup_required' | 'offline' | 'removed';
export type SessionState = 'starting' | 'ready' | 'degraded' | 'stopping' | 'ended' | 'failed';
export type RequestState =
  | 'pending'
  | 'running'
  | 'recovering'
  | 'cancelling'
  | 'completed'
  | 'failed'
  | 'cancelled';
export type ConnectionTestState = 'listening' | 'testing' | 'reachable' | 'unreachable';

export type Gpu = {
  id: string;
  model: string;
  vendor: string;
  total_bytes: U64;
  available_bytes: U64;
  compute_tflops: number | null;
  bandwidth_gbps: number | null;
  driver: string | null;
};

export type Inventory = {
  agent_version: string;
  openinfer_revision: string;
  os: string;
  arch: string;
  machine_model: string;
  cpu_model: string;
  memory_total_bytes: U64;
  memory_available_bytes: U64;
  disk_available_bytes: U64;
  control_plane_reserved_bytes: U64 | null;
  gpus: Gpu[];
  addresses: {address: string; interface: string}[];
  python_executables: {path: string; version: string; purpose: 'agent' | 'mlx' | 'helper'}[];
  engines: {name: string; version: string | null; available: boolean; build: unknown; error: ApiErrorBody | null}[];
  prepared_versions: {version_id: string; manifest_sha256: Sha256; verified_at: Time}[];
  local_model_folders: boolean;
};

export type Instance = {
  instance_id: ID;
  session_id: ID;
  agent_boot_id: ID;
  generation: number;
  state: 'starting' | 'loading' | 'connectable' | 'ready' | 'stopping' | 'stopped' | 'failed' | 'cleanup_required';
  phase: string;
  config_sha256: Sha256;
  processes: {pid: number; process_group_id: number; alive: boolean}[];
  http_healthy: boolean;
  push_listening: boolean;
  calibrated: boolean;
  peer_instance_id: ID | null;
  push_connection_id: ID | null;
  metrics: unknown;
  error: ApiErrorBody | null;
  device_id: ID;
  created_at: Time;
  phase_started_at: Time;
  phase_deadline_at: Time | null;
  stopped_at: Time | null;
  /** While downloading: the bytes its prepare command last reported, at the server's time of that report. */
  progress: {completed_bytes: U64; total_bytes: U64 | null; at: Time} | null;
};

export type Device = {
  id: ID;
  group_id: ID;
  name: string;
  state: DeviceState;
  cleanup_required: boolean;
  agent_boot_id: ID;
  address_revision: U64;
  last_heartbeat_at: Time | null;
  heartbeat_deadline_at: Time | null;
  reconciled_at: Time | null;
  inventory: Inventory;
  reservation: {session_id: ID; role: 'service' | 'helper'} | null;
  instances: Instance[];
  error: ApiErrorBody | null;
  removed_at: Time | null;
  created_at: Time;
};
export type DeviceSummary = Omit<Device, 'inventory' | 'instances'>;

export type ConnectionTest = {
  id: ID;
  source_device_id: ID;
  target_device_id: ID;
  source_boot_id: ID;
  target_boot_id: ID;
  source_address_revision: U64;
  target_address_revision: U64;
  target_addresses: string[];
  source_address: string | null;
  target_address: string | null;
  port: number;
  listener_python: string;
  state: ConnectionTestState;
  listener_ready_at: Time | null;
  listener_closed_at: Time | null;
  started_at: Time;
  deadline_at: Time;
  finished_at: Time | null;
  valid_until: Time | null;
  valid: boolean;
  invalid_reason: string | null;
  rtt_median_ms: number | null;
  transfer_bytes: U64 | null;
  transfer_ms: number | null;
  error: ApiErrorBody | null;
};

export type Session = {
  id: ID;
  group_id: ID;
  created_by: ID;
  idempotency_key: ID;
  model: string;
  state: SessionState;
  plan: SessionPlan;
  max_active_requests: 1;
  config_sha256: Sha256;
  effective_config: EffectiveConfig;
  phase: string;
  phase_started_at: Time;
  phase_deadline_at: Time | null;
  service_disconnect_deadline_at: Time | null;
  drain_deadline_at: Time | null;
  term_deadline_at: Time | null;
  stop_deadline_at: Time | null;
  submissions_blocked: boolean;
  stop_cause: string | null;
  error: ApiErrorBody | null;
  instances: Instance[];
  active_request_ids: ID[];
  uncleared_device_ids: ID[];
  created_at: Time;
  ended_at: Time | null;
};
// The version catalog. Only the version list is read here; the rest is shown nowhere.
export type EffectiveConfig = {versions: VersionConfig[]} & Record<string, unknown>;

export type SessionSummary = Omit<Session, 'effective_config' | 'instances' | 'plan'>;

export type Timing = {
  clock_id: string | null;
  engine_received_ns: U64 | null;
  engine_first_output_ns: U64 | null;
  engine_last_output_ns: U64 | null;
  engine_first_chunk_tokens: number | null;
  engine_finished_ns: U64 | null;
  engine_started_at: Time | null;
  engine_finished_at: Time | null;
};

export type Statistics = {
  helper_draft_tokens: U64 | null;
  helper_verified_tokens: U64 | null;
  accepted_external_tokens: U64 | null;
  think_end_position: U64 | null;
};

export type Request = {
  id: ID;
  session_id: ID;
  user_id: ID;
  instance_id: ID;
  submission_id: ID;
  state: RequestState;
  input: RequestInput;
  seed: U64;
  sampling: unknown;
  requested_max_output: number | null;
  prompt_tokens: number | null;
  effective_max_output: number | null;
  committed_position: U64 | null;
  contiguous_seq: U64;
  final_seq: U64 | null;
  output_tokens: U64;
  timing: Timing;
  statistics: Statistics;
  engine_end: unknown;
  no_output_deadline_at: Time;
  disconnect_deadline_at: Time | null;
  persistence_deadline_at: Time;
  cancel_deadline_at: Time | null;
  cancel_reason: string | null;
  engine_released_at: Time | null;
  archive_state: 'pending' | 'saved' | 'failed';
  archive_error: ApiErrorBody | null;
  result_sha256: Sha256 | null;
  received_at: Time;
  started_at: Time | null;
  ended_at: Time | null;
  error: ApiErrorBody | null;
  /** Where the request came from: this website, or a program through the OpenAI-compatible API with one of the user's keys. */
  source: 'web' | 'api';
  api_key_id: ID | null;
  /** The uploaded file the request took its prompt from; null for a typed prompt. */
  prompt_file: PromptFile | null;
};
export type RequestSummary = Omit<Request, 'input' | 'seed' | 'sampling' | 'engine_end' | 'statistics'>;

export type Chunk = {
  request_id: ID;
  seq: U64;
  text: string;
  token_count: number;
  committed_position: U64;
  /** Thinking or answer; null for chunks recorded before the two were told apart. */
  segment: 'think' | 'answer' | null;
  engine_first_output_ns: U64 | null;
  engine_last_output_ns: U64 | null;
  engine_first_chunk_tokens: number | null;
  received_at: Time;
};

/** A key a program uses to call the OpenAI-compatible API. The secret itself is shown once, when it is generated. */
export type ApiKey = {
  id: ID;
  name: string;
  hint: string;
  created_at: Time;
  last_used_at: Time | null;
  revoked_at: Time | null;
};

export type Snapshot = {
  at: Time;
  group_id: ID;
  /** Where the server keeps uploaded files and saved results: a storage bucket, or (none configured) the memory of the
   *  server process, lost when it restarts. */
  storage: 'bucket' | 'memory';
  devices: DeviceSummary[];
  connection_tests: ConnectionTest[];
  sessions: SessionSummary[];
  requests: RequestSummary[];
  output_watermarks: {request_id: ID; contiguous_seq: U64}[];
};

export type VersionConfig = {
  id: string;
  role: 'service' | 'helper';
  label: string;
  model: string;
  repo: string;
  revision: string;
  quantization: string;
  files: {path: string; sha256: Sha256; size_bytes: U64}[];
  manifest_sha256: Sha256 | null;
  engine: string;
  build_requirements: unknown;
  draft_model: {enabled: boolean} | null;
  compatible_service_version_ids: string[];
  validation: {hardware: string[]; evidence: string[]; complete: boolean; missing: string[]};
  /** Where it runs: the system and processor, and the vendor of the card it runs on (null: any, or none). */
  platform: {os: string; arch: string; gpu_vendor: string | null};
  launch_spec: unknown;
};

export type Catalog = {
  /** The models the versions belong to, by name. */
  models: Record<string, {context_length: number}>;
  /** The catalog's first serving version: the default where it runs. */
  service_version_id: string;
  versions: VersionConfig[];
  /** Per service version, the helper versions Placement chooses from for it, most precise first, with the free GPU memory
   *  and disk each needs. */
  placement: Record<string, {version_id: string; memory_bytes: U64; disk_bytes: U64}[]>;
};

export type WsMessage =
  | {v: 1; type: 'snapshot'; connection_id: ID; seq: U64; at: Time; payload: Snapshot}
  | {v: 1; type: 'enrollment.updated'; connection_id: ID; seq: U64; at: Time; payload: Enrollment}
  | {v: 1; type: 'device.updated'; connection_id: ID; seq: U64; at: Time; payload: Device}
  | {v: 1; type: 'connection_test.updated'; connection_id: ID; seq: U64; at: Time; payload: ConnectionTest}
  | {v: 1; type: 'session.updated'; connection_id: ID; seq: U64; at: Time; payload: Session}
  | {v: 1; type: 'request.updated'; connection_id: ID; seq: U64; at: Time; payload: Request}
  | {v: 1; type: 'output.chunk'; connection_id: ID; seq: U64; at: Time; payload: Chunk}
  | {v: 1; type: 'resync_required'; connection_id: ID; seq: U64; at: Time; payload: {reason: string}};
