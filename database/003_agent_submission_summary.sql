ALTER TABLE tasks ADD COLUMN IF NOT EXISTS submission_summary text NOT NULL DEFAULT '';
