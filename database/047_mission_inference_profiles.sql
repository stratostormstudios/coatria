-- Optional model-catalogue selection. Existing missions, cycles and request
-- hashes retain NULL; this migration enables no mission, provider or permission.
ALTER TABLE agent_missions ADD COLUMN inference_profile jsonb
 CHECK(inference_profile IS NULL OR COALESCE(
  studio_generated_keys(inference_profile,ARRAY['kind','version','projectId'])
  AND inference_profile->>'kind'='studio_generated_coordinator'
  AND inference_profile->'version'='1'::jsonb
  AND jsonb_typeof(inference_profile->'projectId')='string'
  AND inference_profile->>'projectId' ~ '^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$',false));
ALTER TABLE agent_mission_cycles ADD COLUMN inference_profile jsonb
 CHECK(inference_profile IS NULL OR COALESCE(
  studio_generated_keys(inference_profile,ARRAY['kind','version','projectId'])
  AND inference_profile->>'kind'='studio_generated_coordinator'
  AND inference_profile->'version'='1'::jsonb
  AND jsonb_typeof(inference_profile->'projectId')='string'
  AND inference_profile->>'projectId' ~ '^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$',false));

CREATE FUNCTION guard_mission_cycle_inference_profile() RETURNS trigger
LANGUAGE plpgsql SET search_path=pg_catalog,public AS $$
DECLARE mission public.agent_missions%ROWTYPE; run public.agent_runs%ROWTYPE;
BEGIN
 IF TG_OP='DELETE' THEN
  IF EXISTS(SELECT 1 FROM public.companies WHERE id=OLD.company_id) THEN
   RAISE EXCEPTION 'Mission cycle provenance is immutable' USING ERRCODE='42501';
  END IF;
  RETURN OLD;
 END IF;
 IF TG_OP='UPDATE' THEN
  IF NEW IS DISTINCT FROM OLD THEN RAISE EXCEPTION 'Mission cycle provenance is immutable' USING ERRCODE='42501'; END IF;
  RETURN NEW;
 END IF;
 SELECT * INTO STRICT mission FROM public.agent_missions WHERE company_id=NEW.company_id AND id=NEW.mission_id FOR SHARE;
 IF NEW.inference_profile IS DISTINCT FROM mission.inference_profile THEN
  RAISE EXCEPTION 'Mission cycle must snapshot the selected inference profile' USING ERRCODE='23514';
 END IF;
 IF NEW.inference_profile IS NOT NULL THEN
  SELECT * INTO STRICT run FROM public.agent_runs WHERE company_id=NEW.company_id AND id=NEW.run_id FOR SHARE;
  IF run.agent_id IS DISTINCT FROM mission.agent_id OR run.requested_by IS DISTINCT FROM mission.created_by
   OR run.client_id IS DISTINCT FROM NEW.client_id OR run.purpose IS DISTINCT FROM 'task' THEN
   RAISE EXCEPTION 'Mission inference profile requires the exact mission run identity' USING ERRCODE='23514';
  END IF;
  IF NOT EXISTS(SELECT 1 FROM public.studio_projects WHERE company_id=NEW.company_id
     AND id=(NEW.inference_profile->>'projectId')::uuid AND contract_version=2)
   OR NOT EXISTS(SELECT 1 FROM public.studio_role_bindings WHERE company_id=NEW.company_id
     AND role_key IN ('producer','coordinator') AND agent_id=mission.agent_id AND human_id IS NULL) THEN
   RAISE EXCEPTION 'Mission inference profile requires a generated project and coordinator' USING ERRCODE='23514';
  END IF;
 END IF;
 RETURN NEW;
END $$;
CREATE TRIGGER mission_cycle_inference_profile_guard BEFORE INSERT OR UPDATE OR DELETE ON agent_mission_cycles
 FOR EACH ROW EXECUTE FUNCTION guard_mission_cycle_inference_profile();

-- The cycle snapshot must not be reinterpreted by changing either joined
-- identity later. Ordinary run status, lease and result updates remain valid.
CREATE FUNCTION guard_profiled_mission_identity() RETURNS trigger
LANGUAGE plpgsql SET search_path=pg_catalog,public AS $$
BEGIN
 IF TG_TABLE_NAME='agent_runs' THEN
  IF (NEW.id,NEW.company_id,NEW.agent_id,NEW.requested_by,NEW.client_id,NEW.purpose)
   IS DISTINCT FROM (OLD.id,OLD.company_id,OLD.agent_id,OLD.requested_by,OLD.client_id,OLD.purpose)
   AND EXISTS(SELECT 1 FROM public.agent_mission_cycles WHERE company_id=OLD.company_id AND run_id=OLD.id AND inference_profile IS NOT NULL) THEN
   RAISE EXCEPTION 'Profiled mission run identity is immutable' USING ERRCODE='42501';
  END IF;
 ELSE
  IF (NEW.id,NEW.company_id,NEW.agent_id,NEW.created_by)
   IS DISTINCT FROM (OLD.id,OLD.company_id,OLD.agent_id,OLD.created_by)
   AND (OLD.inference_profile IS NOT NULL OR EXISTS(SELECT 1 FROM public.agent_mission_cycles WHERE company_id=OLD.company_id AND mission_id=OLD.id AND inference_profile IS NOT NULL)) THEN
   RAISE EXCEPTION 'Profiled mission identity is immutable' USING ERRCODE='42501';
  END IF;
 END IF;
 RETURN NEW;
END $$;
CREATE TRIGGER profiled_mission_run_identity_guard BEFORE UPDATE OF id,company_id,agent_id,requested_by,client_id,purpose ON agent_runs
 FOR EACH ROW EXECUTE FUNCTION guard_profiled_mission_identity();
CREATE TRIGGER profiled_mission_identity_guard BEFORE UPDATE OF id,company_id,agent_id,created_by ON agent_missions
 FOR EACH ROW EXECUTE FUNCTION guard_profiled_mission_identity();
