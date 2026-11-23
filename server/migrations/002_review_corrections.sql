BEGIN;

-- Keep the already-applied initial migration immutable.
ALTER TABLE sessions DROP COLUMN preflight;
ALTER TABLE devices ADD COLUMN error jsonb;
ALTER TABLE instances ADD COLUMN http_healthy boolean NOT NULL DEFAULT false;
ALTER TABLE instances ADD COLUMN push_listening boolean NOT NULL DEFAULT false;
ALTER TABLE instances ADD COLUMN calibrated boolean NOT NULL DEFAULT false;
UPDATE instances SET
  http_healthy = COALESCE((metrics->>'http_healthy')::boolean, false),
  push_listening = COALESCE((metrics->>'push_listening')::boolean, false),
  calibrated = COALESCE((metrics->>'calibrated')::boolean, false),
  metrics = metrics - 'last_status_report' - 'http_healthy' - 'push_listening' - 'calibrated';

-- T6b removed test cancellation; migrate historic rows without inventing closure proof.
DO $$ DECLARE constraint_name text; BEGIN
  FOR constraint_name IN
    SELECT conname FROM pg_constraint WHERE conrelid='connection_tests'::regclass
      AND contype='c' AND (pg_get_constraintdef(oid) LIKE '%''pending''%'
        OR pg_get_constraintdef(oid) LIKE '%''cancelled''%')
  LOOP EXECUTE format('ALTER TABLE connection_tests DROP CONSTRAINT %I', constraint_name); END LOOP;
END $$;
UPDATE connection_tests SET state='listening' WHERE state='pending';
UPDATE connection_tests SET state='unreachable' WHERE state='cancelled';
ALTER TABLE connection_tests ADD CONSTRAINT connection_tests_state_check
  CHECK (state IN ('listening','testing','reachable','unreachable'));
ALTER TABLE connection_tests ADD CONSTRAINT connection_tests_finished_check
  CHECK ((state IN ('reachable','unreachable')) = (finished_at IS NOT NULL));
DROP INDEX tests_recover;
CREATE INDEX tests_recover ON connection_tests(state, deadline_at)
  WHERE state IN ('listening','testing') OR listener_closed_at IS NULL;
COMMIT;
