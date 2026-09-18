-- Reviewed staffing plans create paused identities, never workers or cleartext credentials.
CREATE TABLE studio_staffing_proposals (
 id uuid PRIMARY KEY DEFAULT gen_random_uuid(),company_id uuid NOT NULL REFERENCES companies(id) ON DELETE CASCADE,
 actor_key text NOT NULL,client_id uuid NOT NULL,request_hash text NOT NULL CHECK(length(request_hash)=64),
 created_by uuid NOT NULL REFERENCES users(id),created_agent_id uuid,run_id uuid,
 revision integer NOT NULL DEFAULT 1 CHECK(revision>0),status text NOT NULL DEFAULT 'pending' CHECK(status IN ('pending','applied','rejected')),
 plan jsonb NOT NULL CHECK(jsonb_typeof(plan)='object'),plan_hash text NOT NULL CHECK(length(plan_hash)=64),profile_revision integer NOT NULL CHECK(profile_revision>=0),
 created_at timestamptz NOT NULL DEFAULT clock_timestamp(),expires_at timestamptz NOT NULL DEFAULT clock_timestamp()+interval '24 hours',
 applied_by uuid REFERENCES users(id),applied_at timestamptz,result jsonb,rejection_note text,
 UNIQUE(company_id,id),UNIQUE(company_id,actor_key,client_id),
 FOREIGN KEY(company_id,created_agent_id) REFERENCES agents(company_id,id),
 FOREIGN KEY(company_id,run_id) REFERENCES agent_runs(company_id,id)
);
CREATE INDEX studio_staffing_proposals_page ON studio_staffing_proposals(company_id,id);
CREATE TABLE studio_staffing_applications (
 company_id uuid NOT NULL REFERENCES companies(id) ON DELETE CASCADE,applied_by uuid NOT NULL REFERENCES users(id),client_id uuid NOT NULL,
 proposal_id uuid NOT NULL,request_hash text NOT NULL CHECK(length(request_hash)=64),result jsonb NOT NULL,
 created_at timestamptz NOT NULL DEFAULT clock_timestamp(),PRIMARY KEY(company_id,applied_by,client_id),UNIQUE(company_id,proposal_id),
 FOREIGN KEY(company_id,proposal_id) REFERENCES studio_staffing_proposals(company_id,id) ON DELETE CASCADE
);
