-- Existing projects retain their VFX graph. New Higgsfield projects use a distinct
-- application-generated creative graph; adding this column creates no tasks/grants.
ALTER TABLE studio_projects ADD COLUMN production_path text NOT NULL DEFAULT 'vfx' CHECK(production_path IN ('vfx','higgsfield'));
CREATE FUNCTION studio_project_path_immutable() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
 IF NEW.production_path IS DISTINCT FROM OLD.production_path THEN
  RAISE EXCEPTION 'The project production path is immutable; create a new project' USING ERRCODE='23514';
 END IF;
 RETURN NEW;
END
$$;
CREATE TRIGGER studio_project_path_immutable BEFORE UPDATE OF production_path ON studio_projects FOR EACH ROW EXECUTE FUNCTION studio_project_path_immutable();
ALTER TABLE studio_work_items DROP CONSTRAINT studio_work_items_execution_check;
ALTER TABLE studio_work_items ADD CONSTRAINT studio_work_items_execution_check CHECK(execution IN ('agent','dcc','creative','human'));
