-- Files a user uploads: a prompt as a .txt or .md file. The bytes are an object in the bucket (object_key); the row ties
-- the object to the user who uploaded it and to the group, and a request that took its prompt from a file points at it.
BEGIN;
CREATE TABLE files (
  id uuid PRIMARY KEY,
  group_id uuid NOT NULL,
  user_id uuid NOT NULL,
  name text NOT NULL CHECK (length(name) BETWEEN 1 AND 255),
  content_type text NOT NULL CHECK (content_type IN ('text/plain', 'text/markdown')),
  size_bytes integer NOT NULL CHECK (size_bytes BETWEEN 1 AND 65536),
  sha256 bytea NOT NULL CHECK (octet_length(sha256) = 32),
  object_key text NOT NULL UNIQUE,
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (group_id, id),
  FOREIGN KEY (group_id, user_id) REFERENCES memberships(group_id, user_id)
);
CREATE INDEX files_by_owner ON files(group_id, user_id, created_at, id);
ALTER TABLE requests ADD COLUMN prompt_file_id uuid;
ALTER TABLE requests ADD CONSTRAINT requests_prompt_file FOREIGN KEY (group_id, prompt_file_id) REFERENCES files(group_id, id);
COMMIT;
