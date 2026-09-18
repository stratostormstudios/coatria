-- Generation intent keeps the exact production task and assignment it was
-- reviewed against. Existing v1.7 project-level intents remain historical.
ALTER TABLE higgsfield_requests
 ADD COLUMN work_item_id uuid,
 ADD COLUMN task_revision integer,
 ADD COLUMN role_agent_id uuid,
 ADD COLUMN role_human_id uuid,
 ADD CONSTRAINT higgsfield_request_task_snapshot CHECK (
  (work_item_id IS NULL AND task_revision IS NULL AND role_agent_id IS NULL AND role_human_id IS NULL)
  OR (work_item_id IS NOT NULL AND task_revision IS NOT NULL AND task_revision > 0 AND NOT (role_agent_id IS NOT NULL AND role_human_id IS NOT NULL))
 ),
 ADD CONSTRAINT higgsfield_request_work FOREIGN KEY(company_id,project_id,work_item_id)
  REFERENCES studio_work_items(company_id,project_id,id) DEFERRABLE INITIALLY DEFERRED;
CREATE INDEX higgsfield_work_requests ON higgsfield_requests(company_id,project_id,work_item_id,created_at,id) WHERE work_item_id IS NOT NULL;
