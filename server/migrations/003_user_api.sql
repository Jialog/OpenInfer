BEGIN;

-- API keys, the source of a request, and the segment of an output chunk. Additions only.
CREATE TABLE api_keys (
  id uuid PRIMARY KEY,
  group_id uuid NOT NULL,
  user_id uuid NOT NULL,
  name text NOT NULL CHECK (length(name) BETWEEN 1 AND 80),
  key_hash bytea NOT NULL UNIQUE CHECK (octet_length(key_hash) = 32),
  hint text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  last_used_at timestamptz,
  revoked_at timestamptz,
  UNIQUE (group_id, id),
  FOREIGN KEY (group_id, user_id) REFERENCES memberships(group_id, user_id)
);
CREATE INDEX api_keys_by_owner ON api_keys(group_id, user_id, created_at, id);

ALTER TABLE requests ADD COLUMN source text NOT NULL DEFAULT 'web' CHECK (source IN ('web','api'));
ALTER TABLE requests ADD COLUMN api_key_id uuid;
ALTER TABLE requests ADD CONSTRAINT requests_api_key_fk FOREIGN KEY (group_id, api_key_id) REFERENCES api_keys(group_id, id);
ALTER TABLE requests ADD CONSTRAINT requests_source_key CHECK ((source = 'api') = (api_key_id IS NOT NULL));

-- Null: a chunk saved before chunks had segments (its text may hold both); every new report names its segment.
ALTER TABLE output_chunks ADD COLUMN segment text CHECK (segment IN ('think','answer'));
COMMIT;
