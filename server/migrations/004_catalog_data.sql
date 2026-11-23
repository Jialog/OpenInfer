-- The model, the number of requests a session serves at once and the context length come from the catalog (the
-- session's config), no longer from constants: their CHECKs go. A request's slot is one of its session's
-- max_active_requests; the unique index on (session_id, slot) of the active requests stays. A helper instance keeps the
-- newest generation of its connection the serving machine has reported.
BEGIN;
DO $$
DECLARE r record;
BEGIN
  FOR r IN SELECT conrelid::regclass AS tab, conname FROM pg_constraint
           WHERE contype = 'c' AND conrelid IN ('sessions'::regclass, 'requests'::regclass)
             AND (pg_get_constraintdef(oid) LIKE '%Qwen3.8-27B%'
                  OR pg_get_constraintdef(oid) LIKE '%max_active_requests = 1%'
                  OR pg_get_constraintdef(oid) LIKE '%(slot = 1)%'
                  OR pg_get_constraintdef(oid) LIKE '%<= 4096%')
  LOOP
    EXECUTE format('ALTER TABLE %s DROP CONSTRAINT %I', r.tab, r.conname);
  END LOOP;
END $$;
ALTER TABLE sessions ADD CONSTRAINT sessions_max_active_requests_positive CHECK (max_active_requests >= 1);
ALTER TABLE requests ADD CONSTRAINT requests_slot_within_session CHECK (slot >= 1);
ALTER TABLE instances ADD COLUMN connection_generation integer NOT NULL DEFAULT 0 CHECK (connection_generation >= 0);
COMMIT;
