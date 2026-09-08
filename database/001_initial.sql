CREATE TABLE IF NOT EXISTS users (
 id uuid PRIMARY KEY DEFAULT gen_random_uuid(), name text NOT NULL, email text NOT NULL UNIQUE,
 password_hash text NOT NULL, role_title text NOT NULL DEFAULT '', avatar_color text NOT NULL DEFAULT '#C9F16F', created_at timestamptz NOT NULL DEFAULT now()
);
CREATE TABLE IF NOT EXISTS sessions (token_hash text PRIMARY KEY, user_id uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE, expires_at timestamptz NOT NULL, created_at timestamptz NOT NULL DEFAULT now());
CREATE INDEX IF NOT EXISTS sessions_user_idx ON sessions(user_id);
CREATE TABLE IF NOT EXISTS companies (
 id uuid PRIMARY KEY DEFAULT gen_random_uuid(), name text NOT NULL, slug text NOT NULL UNIQUE, template text NOT NULL CHECK(template IN ('studio','blank')),
 layout jsonb NOT NULL DEFAULT '[]'::jsonb, created_at timestamptz NOT NULL DEFAULT now()
);
CREATE TABLE IF NOT EXISTS memberships (
 company_id uuid NOT NULL REFERENCES companies(id) ON DELETE CASCADE, user_id uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
 role text NOT NULL CHECK(role IN ('owner','admin','member','removed')), joined_at timestamptz NOT NULL DEFAULT now(), PRIMARY KEY(company_id,user_id)
);
CREATE INDEX IF NOT EXISTS memberships_user_idx ON memberships(user_id);
CREATE TABLE IF NOT EXISTS invitations (
 id uuid PRIMARY KEY DEFAULT gen_random_uuid(), company_id uuid NOT NULL REFERENCES companies(id) ON DELETE CASCADE, token_hash text NOT NULL UNIQUE,
 email text, role text NOT NULL CHECK(role IN ('admin','member')), created_by uuid NOT NULL REFERENCES users(id), expires_at timestamptz NOT NULL,
 used_by uuid REFERENCES users(id), used_at timestamptz, created_at timestamptz NOT NULL DEFAULT now()
);
CREATE TABLE IF NOT EXISTS rooms (
 id uuid PRIMARY KEY DEFAULT gen_random_uuid(), company_id uuid NOT NULL REFERENCES companies(id) ON DELETE CASCADE,
 name text NOT NULL, kind text NOT NULL CHECK(kind IN ('meeting','focus','lounge','auditorium')), capacity integer NOT NULL CHECK(capacity BETWEEN 1 AND 500), created_at timestamptz NOT NULL DEFAULT now(), UNIQUE(company_id,id)
);
CREATE TABLE IF NOT EXISTS presence (
 company_id uuid NOT NULL REFERENCES companies(id) ON DELETE CASCADE, user_id uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE, room_id uuid,
 x real NOT NULL DEFAULT 0 CHECK(x BETWEEN -20 AND 20), z real NOT NULL DEFAULT 0 CHECK(z BETWEEN -20 AND 20), status text NOT NULL CHECK(status IN ('available','focus','away')), updated_at timestamptz NOT NULL DEFAULT now(),
 PRIMARY KEY(company_id,user_id), FOREIGN KEY(company_id,room_id) REFERENCES rooms(company_id,id)
);
CREATE TABLE IF NOT EXISTS messages (
 id uuid PRIMARY KEY DEFAULT gen_random_uuid(), company_id uuid NOT NULL REFERENCES companies(id) ON DELETE CASCADE, room_id uuid,
 user_id uuid NOT NULL REFERENCES users(id), body text NOT NULL CHECK(length(body) BETWEEN 1 AND 4000), created_at timestamptz NOT NULL DEFAULT now(), FOREIGN KEY(company_id,room_id) REFERENCES rooms(company_id,id)
);
CREATE INDEX IF NOT EXISTS messages_company_created_idx ON messages(company_id,created_at DESC);
CREATE TABLE IF NOT EXISTS agents (
 id uuid PRIMARY KEY DEFAULT gen_random_uuid(), company_id uuid NOT NULL REFERENCES companies(id) ON DELETE CASCADE, name text NOT NULL,
 harness text NOT NULL CHECK(harness IN ('hermes','custom','claude-code','codex')), description text NOT NULL DEFAULT '', status text NOT NULL DEFAULT 'active' CHECK(status IN ('active','paused','revoked')),
 token_hash text NOT NULL UNIQUE, created_by uuid NOT NULL REFERENCES users(id), last_seen_at timestamptz, created_at timestamptz NOT NULL DEFAULT now(), UNIQUE(company_id,id)
);
CREATE TABLE IF NOT EXISTS tasks (
 id uuid PRIMARY KEY DEFAULT gen_random_uuid(), company_id uuid NOT NULL REFERENCES companies(id) ON DELETE CASCADE, title text NOT NULL, description text NOT NULL DEFAULT '',
 status text NOT NULL DEFAULT 'todo' CHECK(status IN ('todo','doing','review','done')), assignee_id uuid REFERENCES users(id), created_by uuid NOT NULL REFERENCES users(id),
 submission_url text, review_note text NOT NULL DEFAULT '', submitted_by uuid REFERENCES users(id), submitted_agent_id uuid REFERENCES agents(id), approved_by uuid REFERENCES users(id),
 created_at timestamptz NOT NULL DEFAULT now(), updated_at timestamptz NOT NULL DEFAULT now(), UNIQUE(company_id,id)
);
CREATE INDEX IF NOT EXISTS tasks_company_idx ON tasks(company_id,created_at DESC);
CREATE TABLE IF NOT EXISTS contributions (
 id uuid PRIMARY KEY DEFAULT gen_random_uuid(), company_id uuid NOT NULL REFERENCES companies(id) ON DELETE CASCADE, task_id uuid NOT NULL REFERENCES tasks(id), agent_id uuid NOT NULL REFERENCES agents(id),
 summary text NOT NULL, submission_url text, tokens_used bigint NOT NULL DEFAULT 0 CHECK(tokens_used BETWEEN 0 AND 1000000000), created_at timestamptz NOT NULL DEFAULT now()
);
CREATE TABLE IF NOT EXISTS activity (
 id uuid PRIMARY KEY DEFAULT gen_random_uuid(), company_id uuid NOT NULL REFERENCES companies(id) ON DELETE CASCADE, actor_id uuid REFERENCES users(id),
 kind text NOT NULL, description text NOT NULL, created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS activity_company_created_idx ON activity(company_id,created_at DESC);
CREATE TABLE IF NOT EXISTS skills (
 id uuid PRIMARY KEY DEFAULT gen_random_uuid(), user_id uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE, title text NOT NULL, description text NOT NULL DEFAULT '', content text NOT NULL,
 version integer NOT NULL DEFAULT 1 CHECK(version > 0), updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS skills_user_idx ON skills(user_id);
CREATE TABLE IF NOT EXISTS skill_versions (
 skill_id uuid NOT NULL REFERENCES skills(id) ON DELETE CASCADE, version integer NOT NULL, title text NOT NULL, description text NOT NULL, content text NOT NULL, created_at timestamptz NOT NULL DEFAULT now(), PRIMARY KEY(skill_id,version)
);
CREATE TABLE IF NOT EXISTS drives (
 id uuid PRIMARY KEY DEFAULT gen_random_uuid(), company_id uuid NOT NULL REFERENCES companies(id) ON DELETE CASCADE, name text NOT NULL, kind text NOT NULL DEFAULT 'byo' CHECK(kind='byo'), description text NOT NULL DEFAULT '',
 token_hash text NOT NULL UNIQUE, created_by uuid NOT NULL REFERENCES users(id), status text NOT NULL DEFAULT 'waiting' CHECK(status IN ('waiting','online','revoked')),
 last_seen_at timestamptz, file_count integer NOT NULL DEFAULT 0, created_at timestamptz NOT NULL DEFAULT now(), UNIQUE(company_id,id)
);
CREATE TABLE IF NOT EXISTS drive_files (
 drive_id uuid NOT NULL REFERENCES drives(id) ON DELETE CASCADE, path text NOT NULL, size bigint NOT NULL CHECK(size >= 0), modified_at timestamptz NOT NULL, PRIMARY KEY(drive_id,path)
);
CREATE TABLE IF NOT EXISTS openings (
 id uuid PRIMARY KEY DEFAULT gen_random_uuid(), company_id uuid NOT NULL REFERENCES companies(id) ON DELETE CASCADE, title text NOT NULL, description text NOT NULL,
 type text NOT NULL CHECK(type IN ('human','agent','either')), compensation text NOT NULL CHECK(compensation IN ('paid','volunteer')), budget text NOT NULL DEFAULT '',
 status text NOT NULL DEFAULT 'draft' CHECK(status IN ('draft','published','closed')), created_by uuid NOT NULL REFERENCES users(id), created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS openings_published_idx ON openings(status,created_at DESC);
CREATE TABLE IF NOT EXISTS applications (
 id uuid PRIMARY KEY DEFAULT gen_random_uuid(), opening_id uuid NOT NULL REFERENCES openings(id), company_id uuid NOT NULL REFERENCES companies(id), user_id uuid NOT NULL REFERENCES users(id),
 agent_id uuid REFERENCES agents(id), message text NOT NULL, status text NOT NULL DEFAULT 'applied' CHECK(status IN ('applied','shortlisted','declined','accepted')), invitation_id uuid REFERENCES invitations(id),
 created_at timestamptz NOT NULL DEFAULT now(), updated_at timestamptz NOT NULL DEFAULT now(), UNIQUE(opening_id,user_id)
);
CREATE TABLE IF NOT EXISTS rate_limits (key text PRIMARY KEY, count integer NOT NULL DEFAULT 1, expires_at timestamptz NOT NULL);
