-- The first schema. Apply once, in order, to an empty PostgreSQL database.
-- Migration runner must record this filename/checksum only after COMMIT succeeds.
BEGIN;

CREATE TABLE users (
  id uuid PRIMARY KEY,
  email text NOT NULL CHECK (email = lower(btrim(email)) AND length(email) > 3),
  password_hash text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (email)
);
CREATE TABLE groups (
  id uuid PRIMARY KEY,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE TABLE memberships (
  group_id uuid NOT NULL REFERENCES groups(id),
  user_id uuid NOT NULL REFERENCES users(id),
  PRIMARY KEY (group_id, user_id)
);
CREATE TABLE login_sessions (
  id uuid PRIMARY KEY,
  user_id uuid NOT NULL REFERENCES users(id),
  token_hash bytea NOT NULL UNIQUE CHECK (octet_length(token_hash) = 32),
  csrf_hash bytea NOT NULL CHECK (octet_length(csrf_hash) = 32),
  created_at timestamptz NOT NULL DEFAULT now(),
  expires_at timestamptz NOT NULL CHECK (expires_at > created_at),
  revoked_at timestamptz
);
CREATE TABLE enrollment_tokens (
  id uuid PRIMARY KEY,
  group_id uuid NOT NULL,
  created_by uuid NOT NULL,
  token_hash bytea NOT NULL UNIQUE CHECK (octet_length(token_hash) = 32),
  device_name text NOT NULL CHECK (length(device_name) BETWEEN 1 AND 80),
  state text NOT NULL CHECK (state IN ('pending','consumed','expired')),
  created_at timestamptz NOT NULL DEFAULT now(),
  expires_at timestamptz NOT NULL CHECK (expires_at > created_at),
  consumed_at timestamptz,
  FOREIGN KEY (group_id, created_by) REFERENCES memberships(group_id, user_id),
  UNIQUE (group_id, id),
  CHECK ((state = 'consumed') = (consumed_at IS NOT NULL))
);
CREATE TABLE devices (
  id uuid PRIMARY KEY,
  group_id uuid NOT NULL REFERENCES groups(id),
  enrollment_id uuid NOT NULL UNIQUE,
  name text NOT NULL CHECK (length(name) BETWEEN 1 AND 80),
  credential_hash bytea UNIQUE CHECK (octet_length(credential_hash) = 32),
  state text NOT NULL CHECK (state IN ('idle','occupied','cleanup_required','offline','removed')),
  cleanup_required boolean NOT NULL DEFAULT false,
  agent_boot_id uuid NOT NULL,
  control_connection_id uuid,
  reconciled_at timestamptz,
  last_heartbeat_at timestamptz,
  heartbeat_deadline_at timestamptz,
  inventory jsonb NOT NULL CHECK (jsonb_typeof(inventory) = 'object'),
  address_revision bigint NOT NULL DEFAULT 1 CHECK (address_revision > 0),
  removed_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (group_id, id),
  FOREIGN KEY (group_id, enrollment_id) REFERENCES enrollment_tokens(group_id, id),
  CHECK ((state = 'removed') = (removed_at IS NOT NULL)),
  CHECK ((state = 'removed') = (credential_hash IS NULL)),
  CHECK (state <> 'cleanup_required' OR cleanup_required)
);
CREATE TABLE connection_tests (
  id uuid PRIMARY KEY,
  group_id uuid NOT NULL REFERENCES groups(id),
  source_device_id uuid NOT NULL,
  target_device_id uuid NOT NULL,
  source_boot_id uuid NOT NULL,
  target_boot_id uuid NOT NULL,
  source_address_revision bigint NOT NULL CHECK (source_address_revision > 0),
  target_address_revision bigint NOT NULL CHECK (target_address_revision > 0),
  target_addresses jsonb NOT NULL CHECK (jsonb_typeof(target_addresses) = 'array'),
  source_address text,
  target_address text,
  port integer NOT NULL CHECK (port BETWEEN 1 AND 65535),
  listener_python text NOT NULL,
  nonce_hash bytea NOT NULL CHECK (octet_length(nonce_hash) = 32),
  state text NOT NULL CHECK (state IN ('pending','listening','testing','reachable','unreachable','cancelled')),
  listener_report jsonb, -- Immutable test.listening payload.
  result_report jsonb, -- Full immutable test.result, including individual RTT samples.
  listener_closed_at timestamptz, -- Terminal measurement is not proof of port release.
  listener_ready_at timestamptz,
  started_at timestamptz NOT NULL DEFAULT now(),
  deadline_at timestamptz NOT NULL CHECK (deadline_at > started_at),
  finished_at timestamptz,
  valid_until timestamptz,
  rtt_median_ms double precision CHECK (rtt_median_ms >= 0 AND rtt_median_ms < 'Infinity'::float8),
  transfer_bytes bigint CHECK (transfer_bytes > 0),
  transfer_ms double precision CHECK (transfer_ms > 0 AND transfer_ms < 'Infinity'::float8),
  error jsonb,
  UNIQUE (group_id, id),
  FOREIGN KEY (group_id, source_device_id) REFERENCES devices(group_id, id),
  FOREIGN KEY (group_id, target_device_id) REFERENCES devices(group_id, id),
  CHECK (source_device_id <> target_device_id),
  CHECK ((state IN ('reachable','unreachable','cancelled')) = (finished_at IS NOT NULL)),
  CHECK (state <> 'reachable' OR (source_address IS NOT NULL AND target_address IS NOT NULL
    AND valid_until IS NOT NULL AND rtt_median_ms IS NOT NULL AND transfer_bytes IS NOT NULL AND transfer_ms IS NOT NULL))
);
-- A test listener owns the same target port as the future inference listener.
CREATE UNIQUE INDEX one_active_test_listener ON connection_tests(target_device_id, port)
  WHERE listener_closed_at IS NULL;

CREATE TABLE sessions (
  id uuid PRIMARY KEY,
  group_id uuid NOT NULL,
  created_by uuid NOT NULL,
  idempotency_key uuid NOT NULL,
  state text NOT NULL CHECK (state IN ('starting','ready','degraded','stopping','ended','failed')),
  model text NOT NULL CHECK (model = 'Qwen3.8-27B'),
  max_active_requests integer NOT NULL DEFAULT 1 CHECK (max_active_requests = 1),
  config jsonb NOT NULL CHECK (jsonb_typeof(config) = 'object'),
  config_sha256 bytea NOT NULL CHECK (octet_length(config_sha256) = 32),
  preflight jsonb NOT NULL CHECK (jsonb_typeof(preflight) = 'object'),
  -- Session-lifetime secret; never included in browser responses or logs.
  session_key bytea CHECK (octet_length(session_key) = 32),
  phase text NOT NULL,
  phase_started_at timestamptz NOT NULL,
  phase_deadline_at timestamptz,
  service_disconnect_deadline_at timestamptz,
  drain_deadline_at timestamptz,
  term_deadline_at timestamptz,
  stop_deadline_at timestamptz,
  warmup_command_id uuid,
  submissions_blocked boolean NOT NULL DEFAULT true,
  stop_cause text CHECK (stop_cause IN ('user','startup_failure','service_failure','service_offline','cancel_timeout','reconcile_failure')),
  error jsonb,
  created_at timestamptz NOT NULL DEFAULT now(),
  ended_at timestamptz,
  UNIQUE (group_id, id),
  UNIQUE (group_id, created_by, idempotency_key),
  FOREIGN KEY (group_id, created_by) REFERENCES memberships(group_id, user_id),
  CHECK ((state IN ('ended','failed')) = (ended_at IS NOT NULL)),
  CHECK ((state IN ('ended','failed')) = (session_key IS NULL)),
  CHECK (state NOT IN ('starting','stopping','ended','failed') OR submissions_blocked)
);
CREATE TABLE session_devices (
  group_id uuid NOT NULL,
  session_id uuid NOT NULL,
  device_id uuid NOT NULL,
  role text NOT NULL CHECK (role IN ('service','helper')),
  ordinal integer NOT NULL CHECK ((role = 'service' AND ordinal = 0) OR (role = 'helper' AND ordinal > 0)),
  reserved_at timestamptz NOT NULL DEFAULT now(),
  released_at timestamptz,
  release_reason text CHECK (release_reason IN ('confirmed_stopped','device_removed')),
  PRIMARY KEY (session_id, device_id),
  UNIQUE (group_id, session_id, device_id),
  UNIQUE (session_id, role, ordinal),
  FOREIGN KEY (group_id, session_id) REFERENCES sessions(group_id, id),
  FOREIGN KEY (group_id, device_id) REFERENCES devices(group_id, id),
  CHECK ((released_at IS NULL) = (release_reason IS NULL))
);
CREATE UNIQUE INDEX one_reservation_per_device ON session_devices(device_id) WHERE released_at IS NULL;
CREATE TABLE instances (
  id uuid PRIMARY KEY,
  group_id uuid NOT NULL,
  session_id uuid NOT NULL,
  device_id uuid NOT NULL,
  generation integer NOT NULL CHECK (generation > 0),
  agent_boot_id uuid NOT NULL,
  state text NOT NULL CHECK (state IN ('starting','loading','connectable','ready','stopping','stopped','failed','cleanup_required')),
  spec jsonb NOT NULL CHECK (jsonb_typeof(spec) = 'object'),
  config_sha256 bytea NOT NULL CHECK (octet_length(config_sha256) = 32),
  phase text NOT NULL,
  phase_started_at timestamptz NOT NULL,
  phase_deadline_at timestamptz,
  push_connection_id uuid,
  peer_instance_id uuid,
  processes jsonb NOT NULL DEFAULT '[]'::jsonb CHECK (jsonb_typeof(processes) = 'array'),
  metrics jsonb NOT NULL DEFAULT '{}'::jsonb CHECK (jsonb_typeof(metrics) = 'object'),
  created_at timestamptz NOT NULL DEFAULT now(),
  stopped_at timestamptz,
  error jsonb,
  UNIQUE (group_id, id),
  UNIQUE (group_id, session_id, id),
  UNIQUE (group_id, device_id, id),
  UNIQUE (session_id, device_id, generation),
  FOREIGN KEY (group_id, session_id, device_id) REFERENCES session_devices(group_id, session_id, device_id),
  FOREIGN KEY (group_id, session_id, peer_instance_id) REFERENCES instances(group_id, session_id, id),
  CHECK (state <> 'stopped' OR stopped_at IS NOT NULL)
);
-- failed is not proof of exit; only stopped_at proves cleanup. Removal explicitly
-- releases the device reservation but keeps its historical instances for auditing.
CREATE UNIQUE INDEX one_unstopped_instance ON instances(device_id) WHERE stopped_at IS NULL;

CREATE TABLE requests (
  id uuid PRIMARY KEY,
  group_id uuid NOT NULL,
  session_id uuid NOT NULL,
  user_id uuid NOT NULL,
  instance_id uuid NOT NULL,
  submission_id uuid NOT NULL,
  slot integer NOT NULL DEFAULT 1 CHECK (slot = 1),
  state text NOT NULL CHECK (state IN ('pending','running','recovering','cancelling','completed','failed','cancelled')),
  input jsonb NOT NULL CHECK (jsonb_typeof(input) = 'object'),
  seed text NOT NULL,
  sampling jsonb NOT NULL CHECK (jsonb_typeof(sampling) = 'object'),
  requested_max_output integer CHECK (requested_max_output > 0),
  prompt_tokens integer CHECK (prompt_tokens >= 0),
  effective_max_output integer CHECK (effective_max_output > 0),
  committed_position bigint CHECK (committed_position >= 0),
  contiguous_seq bigint NOT NULL DEFAULT 0 CHECK (contiguous_seq >= 0),
  final_seq bigint CHECK (final_seq >= 0),
  output_tokens bigint NOT NULL DEFAULT 0 CHECK (output_tokens >= 0),
  accepted_report jsonb, -- Immutable request.accepted payload.
  engine_end jsonb,
  timing jsonb NOT NULL DEFAULT '{}'::jsonb CHECK (jsonb_typeof(timing) = 'object'),
  statistics jsonb NOT NULL DEFAULT '{}'::jsonb CHECK (jsonb_typeof(statistics) = 'object'),
  no_output_deadline_at timestamptz NOT NULL,
  disconnect_deadline_at timestamptz,
  persistence_deadline_at timestamptz NOT NULL,
  cancel_deadline_at timestamptz,
  cancel_reason text,
  engine_released_at timestamptz,
  archive_state text NOT NULL DEFAULT 'pending' CHECK (archive_state IN ('pending','saved','failed')),
  result_object_key text UNIQUE,
  result_sha256 bytea CHECK (octet_length(result_sha256) = 32),
  archive_error jsonb,
  received_at timestamptz NOT NULL DEFAULT now(),
  started_at timestamptz,
  ended_at timestamptz,
  error jsonb,
  UNIQUE (group_id, id),
  UNIQUE (group_id, session_id, instance_id, id),
  UNIQUE (group_id, user_id, submission_id),
  FOREIGN KEY (group_id, user_id) REFERENCES memberships(group_id, user_id),
  FOREIGN KEY (group_id, session_id, instance_id) REFERENCES instances(group_id, session_id, id),
  CHECK (prompt_tokens IS NULL OR effective_max_output IS NULL OR prompt_tokens + effective_max_output <= 4096),
  CHECK (final_seq IS NULL OR contiguous_seq <= final_seq),
  CHECK ((state IN ('completed','failed','cancelled')) = (ended_at IS NOT NULL)),
  CHECK (state <> 'completed' OR (final_seq IS NOT NULL AND contiguous_seq = final_seq
    AND engine_end IS NOT NULL AND archive_state = 'saved' AND engine_released_at IS NOT NULL)),
  CHECK (state <> 'cancelled' OR engine_released_at IS NOT NULL OR started_at IS NULL),
  CHECK (archive_state <> 'saved' OR (result_object_key IS NOT NULL AND result_sha256 IS NOT NULL)),
  CHECK (archive_state <> 'failed' OR archive_error IS NOT NULL)
);
CREATE UNIQUE INDEX one_active_request_slot ON requests(session_id, slot)
  WHERE state IN ('pending','running','recovering','cancelling');
CREATE TABLE output_chunks (
  group_id uuid NOT NULL,
  request_id uuid NOT NULL,
  seq bigint NOT NULL CHECK (seq > 0),
  text text NOT NULL,
  token_count integer NOT NULL CHECK (token_count >= 0),
  committed_position bigint NOT NULL CHECK (committed_position >= 0),
  engine_first_output_ns numeric(20,0) CHECK (engine_first_output_ns >= 0),
  engine_last_output_ns numeric(20,0) CHECK (engine_last_output_ns >= 0),
  engine_first_chunk_tokens integer CHECK (engine_first_chunk_tokens >= 0),
  received_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (request_id, seq),
  FOREIGN KEY (group_id, request_id) REFERENCES requests(group_id, id),
  CHECK (engine_first_output_ns IS NULL OR engine_last_output_ns IS NULL OR engine_last_output_ns >= engine_first_output_ns)
);
CREATE TABLE commands (
  id uuid PRIMARY KEY,
  group_id uuid NOT NULL,
  device_id uuid NOT NULL,
  session_id uuid,
  instance_id uuid,
  request_id uuid,
  connection_test_id uuid,
  kind text NOT NULL CHECK (kind IN ('prepare','start_service','start_helper','warmup',
    'listen_test','connect_test','close_test','run_request','cancel_request','recheck','stop')),
  state text NOT NULL CHECK (state IN ('pending','sent','executing','completed','failed','cancelled')),
  payload jsonb NOT NULL CHECK (jsonb_typeof(payload) = 'object'),
  result jsonb, -- Full immutable command.result envelope payload.
  progress_completed_bytes bigint CHECK (progress_completed_bytes >= 0),
  progress_total_bytes bigint CHECK (progress_total_bytes >= 0),
  progress_at timestamptz,
  progress_message text,
  created_at timestamptz NOT NULL DEFAULT now(),
  first_sent_at timestamptz,
  last_sent_at timestamptz,
  acknowledged_at timestamptz,
  ack_deadline_at timestamptz,
  retry_at timestamptz,
  deadline_at timestamptz NOT NULL,
  phase text NOT NULL,
  phase_started_at timestamptz NOT NULL,
  phase_deadline_at timestamptz NOT NULL,
  finished_at timestamptz,
  attempts integer NOT NULL DEFAULT 0 CHECK (attempts >= 0),
  UNIQUE (group_id, id),
  UNIQUE (group_id, session_id, id),
  FOREIGN KEY (group_id, device_id) REFERENCES devices(group_id, id),
  FOREIGN KEY (group_id, session_id, device_id) REFERENCES session_devices(group_id, session_id, device_id),
  FOREIGN KEY (group_id, device_id, instance_id) REFERENCES instances(group_id, device_id, id),
  FOREIGN KEY (group_id, session_id, instance_id) REFERENCES instances(group_id, session_id, id),
  FOREIGN KEY (group_id, session_id, instance_id, request_id) REFERENCES requests(group_id, session_id, instance_id, id),
  FOREIGN KEY (group_id, connection_test_id) REFERENCES connection_tests(group_id, id),
  CHECK (instance_id IS NULL OR session_id IS NOT NULL),
  CHECK (request_id IS NULL OR (session_id IS NOT NULL AND instance_id IS NOT NULL)),
  CHECK ((state IN ('completed','failed','cancelled')) = (finished_at IS NOT NULL)),
  CHECK (progress_completed_bytes IS NULL OR progress_total_bytes IS NULL OR progress_completed_bytes <= progress_total_bytes),
  CHECK (deadline_at >= phase_deadline_at),
  CHECK (phase_deadline_at > phase_started_at)
);
ALTER TABLE sessions ADD CONSTRAINT warmup_command_fk FOREIGN KEY (group_id, id, warmup_command_id) REFERENCES commands(group_id, session_id, id);
CREATE UNIQUE INDEX one_test_action ON commands(connection_test_id, kind) WHERE kind IN ('listen_test','connect_test');
CREATE UNIQUE INDEX one_run_per_request ON commands(request_id) WHERE kind = 'run_request';
CREATE UNIQUE INDEX one_start_per_instance ON commands(instance_id) WHERE kind IN ('start_service','start_helper');
CREATE UNIQUE INDEX one_warmup_per_session ON commands(session_id) WHERE kind = 'warmup';
CREATE INDEX sessions_recover ON sessions(state, phase_deadline_at) WHERE state NOT IN ('ended','failed');
CREATE INDEX commands_recover ON commands(state, deadline_at, retry_at) WHERE state NOT IN ('completed','failed','cancelled');
CREATE INDEX requests_recover ON requests(state, no_output_deadline_at, persistence_deadline_at) WHERE state NOT IN ('completed','failed','cancelled');
CREATE INDEX requests_archive_recover ON requests(persistence_deadline_at) WHERE archive_state = 'pending';
CREATE INDEX tests_recover ON connection_tests(state, deadline_at)
  WHERE state IN ('pending','listening','testing') OR listener_closed_at IS NULL;
CREATE INDEX devices_heartbeat ON devices(heartbeat_deadline_at) WHERE state <> 'removed';
CREATE INDEX sessions_by_group ON sessions(group_id, created_at, id);
CREATE INDEX requests_by_session ON requests(session_id, received_at, id);
CREATE INDEX commands_by_device ON commands(device_id, created_at, id);
COMMIT;
