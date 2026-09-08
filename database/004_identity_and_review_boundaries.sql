-- Email claims become authorization evidence only after a server-controlled
-- verification flow. Existing accounts, sessions and memberships stay usable.
ALTER TABLE users ADD COLUMN IF NOT EXISTS email_verified_at timestamptz;
ALTER TABLE invitations ADD COLUMN IF NOT EXISTS recipient_user_id uuid REFERENCES users(id);
ALTER TABLE memberships ADD COLUMN IF NOT EXISTS access_revoked_at timestamptz;
UPDATE memberships SET access_revoked_at=now() WHERE role='removed' AND access_revoked_at IS NULL;

-- Keep authorship across reopen/resubmit cycles, so changing the last submitter
-- cannot make an author an independent reviewer of their own contribution.
CREATE TABLE IF NOT EXISTS task_authors (
 task_id uuid NOT NULL REFERENCES tasks(id) ON DELETE CASCADE,
 user_id uuid NOT NULL REFERENCES users(id), created_at timestamptz NOT NULL DEFAULT now(),
 PRIMARY KEY(task_id,user_id)
);
INSERT INTO task_authors(task_id,user_id) SELECT id,submitted_by FROM tasks WHERE submitted_by IS NOT NULL ON CONFLICT DO NOTHING;
INSERT INTO task_authors(task_id,user_id) SELECT DISTINCT c.task_id,a.created_by FROM contributions c JOIN agents a ON a.id=c.agent_id ON CONFLICT DO NOTHING;
