/** Exact effective ACLs for two dedicated server identities. No role activation.
 * Runtime requires independent LOGIN; provisioning is explicitly separate. */
export const IMAGE_PREPARATION_BROKER_ROLE='coatria_image_preparation_broker_v1';
export const IMAGE_PREPARATION_REGISTRAR_ROLE='coatria_image_preparation_registrar_v1';
export const IMAGE_PREPARATION_BROKER_CONTRACT={
  "schema_migrations": {
    "SELECT": "*"
  },
  "companies": {
    "SELECT": [
      "id"
    ],
    "UPDATE": [
      "created_at"
    ]
  },
  "memberships": {
    "SELECT": [
      "company_id",
      "user_id",
      "role",
      "access_revoked_at",
      "joined_at"
    ],
    "UPDATE": [
      "joined_at"
    ]
  },
  "studio_projects": {
    "SELECT": "*",
    "UPDATE": [
      "updated_at"
    ]
  },
  "project_storage_connections": {
    "SELECT": "*",
    "UPDATE": [
      "created_at"
    ]
  },
  "project_storage_bindings": {
    "SELECT": "*",
    "UPDATE": [
      "created_at",
      "revision"
    ]
  },
  "project_gateway_bindings": {
    "SELECT": [
      "id",
      "company_id",
      "project_id",
      "provision_id",
      "configuration_hash",
      "origin",
      "verified_by",
      "verified_at",
      "expires_at",
      "revoked_at"
    ]
  },
  "trusted_service_provisions": {
    "SELECT": [
      "id",
      "company_id",
      "service",
      "phase",
      "provider_status",
      "stop_requested_at",
      "pod_id",
      "expires_at",
      "last_reconciled_at",
      "preset",
      "plan",
      "plan_hash",
      "created_by"
    ]
  },
  "company_runtime_selections": {
    "SELECT": [
      "company_id",
      "kind",
      "configuration_id",
      "revision",
      "state"
    ]
  },
  "company_runtime_configurations": {
    "SELECT": [
      "id",
      "company_id",
      "kind",
      "configuration_hash",
      "expires_at"
    ]
  },
  "project_image_preparation_services": {
    "SELECT": "*",
    "UPDATE": [
      "updated_at"
    ]
  },
  "project_image_preparation_service_projects": {
    "SELECT": "*"
  },
  "project_image_preparation_service_enrollments": {
    "SELECT": "*"
  },
  "studio_role_bindings": {
    "SELECT": "*",
    "UPDATE": [
      "created_at"
    ]
  },
  "studio_work_items": {
    "SELECT": "*",
    "UPDATE": [
      "id"
    ]
  },
  "tasks": {
    "SELECT": "*",
    "UPDATE": [
      "updated_at"
    ]
  },
  "studio_dependencies": {
    "SELECT": "*"
  },
  "studio_profiles": {
    "SELECT": "*",
    "UPDATE": [
      "updated_at"
    ]
  },
  "studio_dispatches": {
    "SELECT": "*"
  },
  "studio_coordination_dispatches": {
    "SELECT": "*"
  },
  "studio_coordination_policies": {
    "SELECT": "*",
    "UPDATE": [
      "updated_at"
    ]
  },
  "studio_image_preparation_dispatches": {
    "SELECT": "*"
  },
  "studio_reference_preparation_dispatches": {
    "SELECT": "*"
  },
  "studio_generated_revision_rounds": {
    "SELECT": "*"
  },
  "studio_generated_revision_work": {
    "SELECT": "*"
  },
  "studio_planning_reviews": {
    "SELECT": "*"
  },
  "studio_planning_review_decisions": {
    "SELECT": "*"
  },
  "task_authors": {
    "SELECT": "*"
  },
  "contributions": {
    "SELECT": "*"
  },
  "agents": {
    "SELECT": "*",
    "UPDATE": [
      "last_seen_at"
    ]
  },
  "agent_runs": {
    "SELECT": "*",
    "UPDATE": [
      "updated_at"
    ]
  },
  "agent_run_receipts": {
    "SELECT": "*"
  },
  "agent_tool_receipts": {
    "SELECT": "*"
  },
  "plugin_installations": {
    "SELECT": "*",
    "UPDATE": [
      "updated_at"
    ]
  },
  "studio_host_credentials": {
    "SELECT": "*"
  },
  "studio_managed_hosts": {
    "SELECT": "*"
  },
  "project_storage_folders": {
    "SELECT": "*",
    "UPDATE": [
      "created_at"
    ]
  },
  "project_storage_files": {
    "SELECT": "*",
    "UPDATE": [
      "created_at"
    ],
    "INSERT": "*"
  },
  "project_storage_versions": {
    "SELECT": "*",
    "UPDATE": [
      "created_at"
    ],
    "INSERT": "*"
  },
  "project_storage_uploads": {
    "SELECT": "*",
    "UPDATE": [
      "status",
      "provider_upload_id",
      "provider_descriptor",
      "provider_etag",
      "active_part",
      "action_id",
      "action_expires_at",
      "updated_at"
    ],
    "INSERT": "*"
  },
  "project_storage_upload_parts": {
    "SELECT": "*",
    "INSERT": "*"
  },
  "project_storage_verifications": {
    "SELECT": "*",
    "INSERT": "*"
  },
  "project_image_preparations": {
    "SELECT": "*",
    "UPDATE": [
      "status",
      "revision",
      "attempt",
      "claimed_at",
      "lease_id",
      "lease_expires_at",
      "action_id",
      "action_operation",
      "transform_result",
      "transform_sha256",
      "cleanup_confirmed_at",
      "diagnostic_code",
      "updated_at"
    ]
  },
  "project_image_preparation_approvals": {
    "SELECT": "*"
  },
  "project_image_preparation_receipts": {
    "SELECT": "*",
    "INSERT": "*"
  },
  "project_image_preparation_derivations": {
    "SELECT": "*",
    "INSERT": "*"
  },
  "project_image_preparation_allocations": {
    "SELECT": "*",
    "INSERT": "*"
  },
  "project_image_preparation_service_leases": {
    "SELECT": "*",
    "INSERT": "*"
  },
  "project_image_preparation_service_calls": {
    "SELECT": "*",
    "INSERT": "*",
    "UPDATE": [
      "status",
      "response",
      "finished_at"
    ]
  },
  "project_image_preparation_byte_grants": {
    "SELECT": "*",
    "INSERT": "*"
  },
  "project_image_preparation_byte_results": {
    "SELECT": "*"
  },
  "users": {
    "SELECT": [
      "id",
      "name",
      "email",
      "role_title",
      "avatar_color",
      "avatar_id",
      "email_verified_at"
    ]
  },
  "studio_coordination_followups": {
    "SELECT": [
      "company_id",
      "child_run_id"
    ]
  },
  "studio_generated_followups": {
    "SELECT": [
      "company_id",
      "child_run_id"
    ]
  },
  "studio_reference_generation_followups": {
    "SELECT": [
      "company_id",
      "child_run_id"
    ]
  },
  "agent_mission_cycles": {
    "SELECT": [
      "company_id",
      "run_id"
    ]
  }
};
export const IMAGE_PREPARATION_REGISTRAR_CONTRACT={
  "schema_migrations": {
    "SELECT": "*"
  },
  "companies": {
    "SELECT": [
      "id"
    ],
    "UPDATE": [
      "created_at"
    ]
  },
  "memberships": {
    "SELECT": [
      "company_id",
      "user_id",
      "role",
      "access_revoked_at",
      "joined_at"
    ],
    "UPDATE": [
      "joined_at"
    ]
  },
  "studio_projects": {
    "SELECT": [
      "id",
      "company_id",
      "revision",
      "status",
      "ai_policy",
      "production_path",
      "contract_version",
      "gates"
    ],
    "UPDATE": [
      "updated_at"
    ]
  },
  "project_storage_connections": {
    "SELECT": [
      "id",
      "company_id",
      "revision",
      "status",
      "created_by"
    ],
    "UPDATE": [
      "created_at"
    ]
  },
  "project_storage_bindings": {
    "SELECT": [
      "id",
      "company_id",
      "project_id",
      "connection_id",
      "revision"
    ],
    "UPDATE": [
      "created_at"
    ]
  },
  "project_gateway_bindings": {
    "SELECT": [
      "id",
      "company_id",
      "project_id",
      "provision_id",
      "configuration_hash",
      "origin",
      "verified_by",
      "verified_at",
      "expires_at",
      "revoked_at"
    ]
  },
  "trusted_service_provisions": {
    "SELECT": [
      "id",
      "company_id",
      "service",
      "phase",
      "provider_status",
      "stop_requested_at",
      "pod_id",
      "expires_at",
      "last_reconciled_at",
      "preset",
      "plan",
      "plan_hash",
      "created_by"
    ]
  },
  "company_runtime_selections": {
    "SELECT": [
      "company_id",
      "kind",
      "configuration_id",
      "revision",
      "state"
    ]
  },
  "company_runtime_configurations": {
    "SELECT": [
      "id",
      "company_id",
      "kind",
      "configuration_hash",
      "expires_at"
    ]
  },
  "project_image_preparation_services": {
    "SELECT": "*",
    "INSERT": "*"
  },
  "project_image_preparation_service_projects": {
    "SELECT": "*",
    "INSERT": "*"
  },
  "project_image_preparation_service_enrollments": {
    "SELECT": "*",
    "INSERT": "*"
  }
};
const LOCK_TABLES={"registrar":["companies","memberships","studio_projects","project_storage_connections","project_storage_bindings"],"broker":["companies","memberships","studio_projects","studio_role_bindings","studio_work_items","tasks","studio_profiles","studio_coordination_policies","agents","agent_runs","plugin_installations","project_storage_connections","project_storage_folders","project_storage_files","project_storage_versions","project_image_preparation_services"]};
export const IMAGE_PREPARATION_LOCK_BODY="BEGIN\n IF current_user=TG_ARGV[0] AND NEW IS DISTINCT FROM OLD THEN\n  RAISE EXCEPTION 'Preparation authority rows are read only' USING ERRCODE='42501';\n END IF;\n RETURN NEW;\nEND";
const migrations=['045_project_image_preparations.sql','046_project_image_preparation_storage.sql','047_project_image_preparation_handoff.sql','048_project_image_preparation_dispatch.sql','049_studio_reference_generation_continuations.sql','050_project_image_preparation_services.sql'];
// Frozen expected bodies: never load mutable SQL from disk during preflight.
const STATE_GUARDS=[
  {
    "table": "project_image_preparation_receipts",
    "trigger": "project_image_preparation_receipt_guard",
    "function": "validate_project_image_preparation_receipt",
    "body": "BEGIN\n IF NEW.operation='cleanup' AND NEW.phase='returned' AND NOT EXISTS(\n  SELECT 1 FROM project_image_preparations WHERE company_id=NEW.company_id AND project_id=NEW.project_id AND id=NEW.preparation_id\n   AND attempt=1 AND cleanup_confirmed_at IS NULL AND (transform_result IS NOT NULL OR status IN ('uncertain','blocked','failed','revoked'))\n ) THEN RAISE EXCEPTION 'Preparation cleanup cannot precede its processor terminal state' USING ERRCODE='23514'; END IF;\n IF NEW.phase='returned' AND NEW.operation IN ('transform','allocation','store') AND NOT EXISTS(\n  SELECT 1 FROM project_image_preparation_receipts WHERE company_id=NEW.company_id AND preparation_id=NEW.preparation_id\n   AND action_id=NEW.action_id AND operation=NEW.operation AND phase='intent'\n ) THEN RAISE EXCEPTION 'Preparation result requires its exact prior intent' USING ERRCODE='23514'; END IF;\n RETURN NEW;\nEND",
    "definer": false,
    "config": [
      "search_path=pg_catalog, public"
    ],
    "args": "",
    "type": 7,
    "enabled": "O"
  },
  {
    "table": "project_image_preparation_approvals",
    "trigger": "project_image_preparation_approval_immutable",
    "function": "guard_project_image_preparation_immutable",
    "body": "BEGIN\n IF NEW IS DISTINCT FROM OLD THEN RAISE EXCEPTION 'Preparation evidence is immutable' USING ERRCODE='42501'; END IF;\n RETURN NEW;\nEND",
    "definer": false,
    "config": [
      "search_path=pg_catalog, public"
    ],
    "args": "",
    "type": 19,
    "enabled": "A"
  },
  {
    "table": "project_image_preparation_receipts",
    "trigger": "project_image_preparation_receipt_immutable",
    "function": "guard_project_image_preparation_immutable",
    "body": "BEGIN\n IF NEW IS DISTINCT FROM OLD THEN RAISE EXCEPTION 'Preparation evidence is immutable' USING ERRCODE='42501'; END IF;\n RETURN NEW;\nEND",
    "definer": false,
    "config": [
      "search_path=pg_catalog, public"
    ],
    "args": "",
    "type": 19,
    "enabled": "A"
  },
  {
    "table": "project_image_preparation_requests",
    "trigger": "project_image_preparation_request_immutable",
    "function": "guard_project_image_preparation_immutable",
    "body": "BEGIN\n IF NEW IS DISTINCT FROM OLD THEN RAISE EXCEPTION 'Preparation evidence is immutable' USING ERRCODE='42501'; END IF;\n RETURN NEW;\nEND",
    "definer": false,
    "config": [
      "search_path=pg_catalog, public"
    ],
    "args": "",
    "type": 19,
    "enabled": "A"
  },
  {
    "table": "project_image_preparation_derivations",
    "trigger": "project_image_preparation_derivation_immutable",
    "function": "guard_project_image_preparation_immutable",
    "body": "BEGIN\n IF NEW IS DISTINCT FROM OLD THEN RAISE EXCEPTION 'Preparation evidence is immutable' USING ERRCODE='42501'; END IF;\n RETURN NEW;\nEND",
    "definer": false,
    "config": [
      "search_path=pg_catalog, public"
    ],
    "args": "",
    "type": 19,
    "enabled": "A"
  },
  {
    "table": "project_image_preparations",
    "trigger": "project_image_preparation_source_guard",
    "function": "validate_project_image_preparation_source",
    "body": "BEGIN\n IF NEW.status<>'proposed' OR NEW.revision<>1 OR NEW.attempt<>0 OR NEW.lease_id IS NOT NULL OR NEW.action_id IS NOT NULL\n  OR NEW.transform_result IS NOT NULL OR NEW.cleanup_confirmed_at IS NOT NULL OR NEW.revoked_at IS NOT NULL THEN\n  RAISE EXCEPTION 'A preparation starts as an unapproved proposal' USING ERRCODE='23514';\n END IF;\n IF NOT EXISTS (\n  SELECT 1 FROM project_storage_versions v\n  JOIN project_storage_files f ON (f.company_id,f.project_id,f.id)=(v.company_id,v.project_id,v.file_id)\n  JOIN project_storage_verifications ok ON (ok.company_id,ok.project_id,ok.version_id)=(v.company_id,v.project_id,v.id)\n  JOIN project_storage_bindings b ON (b.company_id,b.project_id,b.id)=(f.company_id,f.project_id,f.binding_id)\n  JOIN project_storage_connections c ON (c.company_id,c.id)=(b.company_id,b.connection_id)\n  WHERE (v.company_id,v.project_id,v.id)=(NEW.company_id,NEW.project_id,NEW.source_version_id)\n   AND v.bytes BETWEEN 1 AND 33554432 AND ok.bytes=v.bytes AND (v.sha256 IS NULL OR v.sha256=ok.sha256)\n   AND v.content_type IN ('image/png','image/jpeg','image/webp')\n   AND b.id=NEW.storage_binding_id AND b.revision=NEW.storage_binding_revision AND c.id=NEW.storage_connection_id\n   AND c.revision=NEW.storage_connection_revision AND c.created_by=NEW.storage_sponsor_id AND c.status='configured'\n   AND NEW.source_snapshot->>'versionId'=v.id::text AND NEW.source_snapshot->>'fileId'=v.file_id::text\n   AND NEW.source_snapshot->>'name'=f.name AND NEW.source_snapshot->>'version'=v.version::text\n   AND NEW.source_snapshot->>'bytes'=v.bytes::text AND NEW.source_snapshot->>'sha256'=ok.sha256\n   AND NEW.source_snapshot->>'contentType'=v.content_type AND NEW.source_snapshot->>'objectKey'=v.object_key\n   AND NEW.source_snapshot->>'providerEtag'=ok.provider_etag\n ) THEN RAISE EXCEPTION 'Preparation requires exact verified source facts' USING ERRCODE='23514'; END IF;\n RETURN NEW;\nEND",
    "definer": false,
    "config": [
      "search_path=pg_catalog, public"
    ],
    "args": "",
    "type": 7,
    "enabled": "O"
  },
  {
    "table": "project_image_preparation_approvals",
    "trigger": "project_image_preparation_approval_guard",
    "function": "validate_project_image_preparation_approval",
    "body": "DECLARE p project_image_preparations; s jsonb;\nBEGIN\n SELECT * INTO p FROM project_image_preparations WHERE (company_id,project_id,id)=(NEW.company_id,NEW.project_id,NEW.preparation_id) FOR UPDATE;\n s:=NEW.processor_snapshot;\n IF p.id IS NULL OR p.status<>'proposed' OR p.revoked_at IS NOT NULL OR NEW.approved_at>clock_timestamp() OR NEW.expires_at<=clock_timestamp()\n  OR NOT EXISTS(SELECT 1 FROM memberships WHERE company_id=NEW.company_id AND user_id=NEW.approved_by AND role IN ('owner','admin') AND access_revoked_at IS NULL\n   AND NEW.approver_snapshot->>'userId'=user_id::text AND NEW.approver_snapshot->>'role'=role\n   AND (NEW.approver_snapshot->>'joinedAt')::timestamptz=joined_at)\n  OR NOT ((s->>'id'~'^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$'\n   AND length(s->>'location') BETWEEN 1 AND 200 AND s->>'qualificationSha256'~'^[a-f0-9]{64}$'\n   AND s->>'releaseSha256'~'^[a-f0-9]{64}$' AND s->>'profileSha256'~'^[a-f0-9]{64}$'\n   AND s->>'sourceCommit'~'^[a-f0-9]{40}$' AND s->>'closureSha256'~'^[a-f0-9]{64}$'\n   AND s->>'transport' IN ('linux_binary_v1','vercel_binary_v1') AND s->>'recipeSha256'=p.recipe_sha256\n   AND s->>'expiresAt' IS NOT NULL) IS TRUE)\n THEN RAISE EXCEPTION 'Preparation requires current finite human processing approval' USING ERRCODE='23514'; END IF;\n IF (s->>'expiresAt')::timestamptz<NEW.expires_at THEN RAISE EXCEPTION 'Preparation outlives its selected processor' USING ERRCODE='23514'; END IF;\n RETURN NEW;\nEND",
    "definer": false,
    "config": [
      "search_path=pg_catalog, public"
    ],
    "args": "",
    "type": 7,
    "enabled": "O"
  },
  {
    "table": "project_image_preparations",
    "trigger": "project_image_preparation_update_guard",
    "function": "guard_project_image_preparation_update",
    "body": "DECLARE a project_image_preparation_approvals; result jsonb;\nBEGIN\n IF (to_jsonb(NEW)-ARRAY['status','revision','lease_id','lease_expires_at','claimed_at','attempt','action_id','action_operation','diagnostic_code','revoked_by','revoked_at','updated_at','transform_result','transform_sha256','cleanup_confirmed_at'])\n  IS DISTINCT FROM (to_jsonb(OLD)-ARRAY['status','revision','lease_id','lease_expires_at','claimed_at','attempt','action_id','action_operation','diagnostic_code','revoked_by','revoked_at','updated_at','transform_result','transform_sha256','cleanup_confirmed_at'])\n  OR NEW.revision<OLD.revision OR NEW.attempt<OLD.attempt\n  OR (OLD.claimed_at IS NOT NULL AND NEW.claimed_at IS DISTINCT FROM OLD.claimed_at)\n  OR (OLD.transform_result IS NOT NULL AND (NEW.transform_result IS DISTINCT FROM OLD.transform_result OR NEW.transform_sha256 IS DISTINCT FROM OLD.transform_sha256))\n  OR (OLD.cleanup_confirmed_at IS NOT NULL AND NEW.cleanup_confirmed_at IS DISTINCT FROM OLD.cleanup_confirmed_at)\n  OR (OLD.revoked_at IS NOT NULL AND (NEW.revoked_at IS DISTINCT FROM OLD.revoked_at OR NEW.revoked_by IS DISTINCT FROM OLD.revoked_by)) THEN\n  RAISE EXCEPTION 'Preparation source, recipe and completed evidence are immutable' USING ERRCODE='42501';\n END IF;\n IF NEW.status IS DISTINCT FROM OLD.status AND NOT (\n  (OLD.status='proposed' AND NEW.status IN ('queued','blocked','failed','revoked')) OR\n  (OLD.status='queued' AND NEW.status IN ('reading','blocked','failed','revoked')) OR\n  (OLD.status='reading' AND NEW.status IN ('transforming','blocked','failed','revoked')) OR\n  (OLD.status='transforming' AND NEW.status IN ('validating','uncertain','blocked','failed','revoked')) OR\n  (OLD.status='validating' AND NEW.status IN ('storing','blocked','failed','revoked')) OR\n  (OLD.status='storing' AND NEW.status IN ('verifying','uncertain','blocked','failed','revoked')) OR\n  (OLD.status='verifying' AND NEW.status IN ('ready','uncertain','blocked','failed','revoked')) OR\n  (OLD.status IN ('ready','uncertain','blocked','failed') AND NEW.status='revoked')\n ) THEN RAISE EXCEPTION 'Preparation phase transition rejected' USING ERRCODE='23514'; END IF;\n SELECT * INTO a FROM project_image_preparation_approvals WHERE company_id=NEW.company_id AND preparation_id=NEW.id;\n IF NEW.status IN ('queued','reading','transforming','validating','storing','verifying','ready') AND\n  (a.preparation_id IS NULL OR a.expires_at<=clock_timestamp()) THEN RAISE EXCEPTION 'Preparation approval ended' USING ERRCODE='23514'; END IF;\n IF NEW.status IS DISTINCT FROM OLD.status AND NEW.status IN ('transforming','validating','storing','verifying','ready') AND\n  NOT ((OLD.lease_id IS NOT NULL AND OLD.lease_expires_at>clock_timestamp()\n   AND (NEW.lease_id IS NOT DISTINCT FROM OLD.lease_id OR (NEW.status='ready' AND NEW.lease_id IS NULL))) IS TRUE)\n THEN RAISE EXCEPTION 'Preparation phase admission requires its current lease' USING ERRCODE='23514'; END IF;\n IF NEW.attempt<>OLD.attempt AND NOT (OLD.attempt=0 AND NEW.attempt=1 AND OLD.status='queued' AND NEW.status='reading'\n  AND NEW.claimed_at<=clock_timestamp() AND NEW.claimed_at>=OLD.created_at AND NEW.lease_id IS NOT NULL\n  AND NEW.lease_expires_at>clock_timestamp() AND NEW.lease_expires_at<=a.expires_at) THEN RAISE EXCEPTION 'Preparation can claim exactly one finite attempt' USING ERRCODE='23514'; END IF;\n IF NEW.lease_id IS NOT NULL AND (NEW.lease_expires_at>a.expires_at OR NEW.attempt<>1\n  OR (OLD.lease_id IS NOT NULL AND NEW.lease_id IS DISTINCT FROM OLD.lease_id)\n  OR (OLD.lease_id IS NOT NULL AND OLD.lease_expires_at<=clock_timestamp() AND NEW.lease_expires_at>clock_timestamp())\n  OR (OLD.attempt=1 AND OLD.lease_id IS NULL)) THEN RAISE EXCEPTION 'Preparation lease cannot be replaced' USING ERRCODE='23514'; END IF;\n IF NEW.action_id IS DISTINCT FROM OLD.action_id AND NEW.action_id IS NOT NULL AND\n  (OLD.action_id IS NOT NULL OR NOT EXISTS(SELECT 1 FROM project_image_preparation_receipts WHERE company_id=NEW.company_id AND preparation_id=NEW.id\n   AND action_id=NEW.action_id AND operation=NEW.action_operation AND phase='intent')) THEN\n  RAISE EXCEPTION 'Preparation action requires its committed intent identity' USING ERRCODE='23514';\n END IF;\n IF NEW.status='transforming' AND NOT ((NEW.action_id IS NOT NULL AND NEW.action_operation='transform') IS TRUE) THEN\n  RAISE EXCEPTION 'A transform needs its exact action intent' USING ERRCODE='23514';\n END IF;\n IF NEW.status='transforming' AND NEW.cleanup_confirmed_at IS NOT NULL THEN RAISE EXCEPTION 'A cleaned preparation cannot restart its processor' USING ERRCODE='23514'; END IF;\n IF NEW.transform_result IS DISTINCT FROM OLD.transform_result THEN\n  result:=NEW.transform_result;\n  IF OLD.transform_result IS NOT NULL OR OLD.status<>'transforming' OR NEW.status<>'validating' OR OLD.action_operation<>'transform'\n   OR OLD.action_id IS NULL OR OLD.lease_id IS NULL OR OLD.lease_expires_at<=clock_timestamp()\n   OR NOT ((result->>'sourceVersionId'=NEW.source_version_id::text AND result->>'sourceSha256'=NEW.source_snapshot->>'sha256'\n    AND result->>'sourceBytes'=NEW.source_snapshot->>'bytes' AND result->>'recipeSha256'=NEW.recipe_sha256\n    AND result->'processor'=a.processor_snapshot AND result#>>'{output,format}'='png' AND result#>>'{output,pixelFormat}'='rgba8'\n    AND result#>'{output,metadataRemoved}'='true'::jsonb AND result#>>'{output,sha256}'~'^[a-f0-9]{64}$'\n    AND (result#>>'{output,bytes}')::bigint BETWEEN 1 AND 10485760\n    AND (result#>>'{output,width}')::integer BETWEEN 1 AND 2048 AND (result#>>'{output,height}')::integer BETWEEN 1 AND 2048\n    AND result#>>'{source,format}' IN ('png','jpeg','webp') AND (result#>>'{source,orientation}')::integer BETWEEN 1 AND 8\n    AND (result#>>'{source,width}')::integer BETWEEN 1 AND 8192 AND (result#>>'{source,height}')::integer BETWEEN 1 AND 8192\n    AND (result#>>'{source,width}')::bigint*(result#>>'{source,height}')::bigint<=32000000) IS TRUE)\n   OR NOT EXISTS(SELECT 1 FROM project_image_preparation_receipts WHERE company_id=NEW.company_id AND preparation_id=NEW.id AND action_id=OLD.action_id AND operation='transform' AND phase='returned')\n  THEN RAISE EXCEPTION 'Preparation transform evidence does not match the finite job' USING ERRCODE='23514'; END IF;\n END IF;\n IF NEW.status IN ('validating','storing','verifying','ready') AND NEW.transform_result IS NULL THEN RAISE EXCEPTION 'Preparation transform evidence is required' USING ERRCODE='23514'; END IF;\n IF NEW.cleanup_confirmed_at IS DISTINCT FROM OLD.cleanup_confirmed_at AND (NEW.cleanup_confirmed_at IS NULL OR NEW.cleanup_confirmed_at>clock_timestamp()\n  OR (NEW.transform_result IS NULL AND NEW.status NOT IN ('uncertain','blocked','failed','revoked'))\n  OR NOT EXISTS(SELECT 1 FROM project_image_preparation_receipts WHERE company_id=NEW.company_id AND preparation_id=NEW.id AND operation='cleanup' AND phase='returned'))\n THEN RAISE EXCEPTION 'Preparation cleanup requires its own trusted receipt' USING ERRCODE='23514'; END IF;\n IF NEW.status='ready' AND (NEW.cleanup_confirmed_at IS NULL OR NOT EXISTS(SELECT 1 FROM project_image_preparation_derivations WHERE company_id=NEW.company_id AND project_id=NEW.project_id AND preparation_id=NEW.id))\n THEN RAISE EXCEPTION 'Preparation cannot be ready without its verified derivation' USING ERRCODE='23514'; END IF;\n RETURN NEW;\nEND",
    "definer": false,
    "config": [
      "search_path=pg_catalog, public"
    ],
    "args": "",
    "type": 19,
    "enabled": "A"
  },
  {
    "table": "project_image_preparation_derivations",
    "trigger": "project_image_preparation_derivation_guard",
    "function": "validate_project_image_preparation_derivation",
    "body": "BEGIN\n IF NOT EXISTS (\n  SELECT 1 FROM project_image_preparations p\n  JOIN project_image_preparation_approvals a ON (a.company_id,a.project_id,a.preparation_id)=(p.company_id,p.project_id,p.id)\n  JOIN project_storage_versions v ON (v.company_id,v.project_id,v.id)=(p.company_id,p.project_id,NEW.output_version_id)\n  JOIN project_storage_files f ON (f.company_id,f.project_id,f.id)=(v.company_id,v.project_id,v.file_id)\n  JOIN project_storage_uploads u ON (u.company_id,u.project_id,u.id,u.version_id)=(v.company_id,v.project_id,NEW.upload_id,v.id)\n  JOIN project_storage_verifications ok ON (ok.company_id,ok.project_id,ok.version_id)=(v.company_id,v.project_id,v.id)\n  WHERE (p.company_id,p.project_id,p.id)=(NEW.company_id,NEW.project_id,NEW.preparation_id)\n   AND p.status='verifying' AND p.revoked_at IS NULL AND p.lease_id IS NOT NULL AND p.lease_expires_at>clock_timestamp() AND a.expires_at>clock_timestamp()\n   AND p.source_version_id=NEW.source_version_id AND p.source_snapshot->>'sha256'=NEW.source_sha256 AND p.source_snapshot->>'bytes'=NEW.source_bytes::text\n   AND p.recipe_sha256=NEW.recipe_sha256 AND p.transform_result=NEW.transform_evidence AND a.processor_snapshot=NEW.processor_snapshot\n   AND p.transform_result#>>'{output,sha256}'=NEW.output_sha256 AND p.transform_result#>>'{output,bytes}'=NEW.output_bytes::text\n   AND p.transform_result#>>'{output,width}'=NEW.output_width::text AND p.transform_result#>>'{output,height}'=NEW.output_height::text\n   AND v.file_id=NEW.output_file_id AND v.file_id::text<>p.source_snapshot->>'fileId' AND v.version=1 AND v.content_type='image/png'\n   AND f.binding_id=p.storage_binding_id AND f.parent_id IS NOT DISTINCT FROM p.destination_folder_id AND f.name=p.destination_name\n   AND u.status='ready' AND u.archive_id IS NULL AND u.actor_key='preparation:'||p.id::text AND u.actor_user_id=a.approved_by AND u.actor_agent_id IS NULL AND u.run_id IS NULL\n   AND v.bytes=NEW.output_bytes AND v.sha256=NEW.output_sha256 AND ok.bytes=v.bytes AND ok.sha256=v.sha256 AND ok.provider_etag=u.provider_etag\n ) THEN RAISE EXCEPTION 'Preparation derivation needs its exact separate verified output' USING ERRCODE='23514'; END IF;\n RETURN NEW;\nEND",
    "definer": false,
    "config": [
      "search_path=pg_catalog, public"
    ],
    "args": "",
    "type": 7,
    "enabled": "O"
  },
  {
    "table": "project_image_preparation_allocations",
    "trigger": "project_image_preparation_allocation_immutable",
    "function": "guard_project_image_preparation_immutable",
    "body": "BEGIN\n IF NEW IS DISTINCT FROM OLD THEN RAISE EXCEPTION 'Preparation evidence is immutable' USING ERRCODE='42501'; END IF;\n RETURN NEW;\nEND",
    "definer": false,
    "config": [
      "search_path=pg_catalog, public"
    ],
    "args": "",
    "type": 19,
    "enabled": "A"
  },
  {
    "table": "project_image_preparation_allocations",
    "trigger": "project_image_preparation_allocation_guard",
    "function": "validate_project_image_preparation_allocation",
    "body": "BEGIN\n IF NOT EXISTS (\n  SELECT 1 FROM project_image_preparations p\n  JOIN project_image_preparation_approvals a ON (a.company_id,a.project_id,a.preparation_id)=(p.company_id,p.project_id,p.id)\n  JOIN memberships m ON m.company_id=a.company_id AND m.user_id=a.approved_by\n  JOIN project_storage_bindings b ON (b.company_id,b.project_id,b.id)=(p.company_id,p.project_id,p.storage_binding_id)\n  JOIN project_storage_connections c ON (c.company_id,c.id)=(b.company_id,b.connection_id)\n  JOIN project_storage_versions v ON (v.company_id,v.project_id,v.id)=(p.company_id,p.project_id,NEW.version_id)\n  JOIN project_storage_files f ON (f.company_id,f.project_id,f.id)=(v.company_id,v.project_id,v.file_id)\n  JOIN project_storage_uploads u ON (u.company_id,u.project_id,u.id,u.version_id)=(v.company_id,v.project_id,NEW.upload_id,v.id)\n  WHERE (p.company_id,p.project_id,p.id)=(NEW.company_id,NEW.project_id,NEW.preparation_id)\n   AND p.status='validating' AND p.revoked_at IS NULL AND p.lease_id IS NOT NULL AND p.lease_expires_at>clock_timestamp()\n   AND a.expires_at>clock_timestamp() AND a.processing_consent AND a.derivative_write_consent AND a.adoption_consent\n   AND m.role IN ('owner','admin') AND m.access_revoked_at IS NULL\n   AND a.approver_snapshot->>'userId'=m.user_id::text AND a.approver_snapshot->>'role'=m.role\n   AND (a.approver_snapshot->>'joinedAt')::timestamptz=m.joined_at\n   AND p.transform_result->'processor'=a.processor_snapshot AND p.transform_result->>'recipeSha256'=p.recipe_sha256\n   AND p.transform_result#>>'{output,sha256}'=NEW.output_sha256 AND p.transform_result#>>'{output,bytes}'=NEW.output_bytes::text\n   AND p.storage_binding_revision=NEW.binding_revision_before AND b.revision=NEW.binding_revision_after\n   AND c.id=p.storage_connection_id AND c.revision=p.storage_connection_revision AND c.created_by=p.storage_sponsor_id AND c.status='configured'\n   AND v.id<>p.source_version_id AND v.file_id=NEW.file_id AND v.file_id::text<>p.source_snapshot->>'fileId'\n   AND v.version=1 AND v.content_type='image/png' AND v.sha256=NEW.output_sha256 AND v.bytes=NEW.output_bytes\n   AND f.binding_id=p.storage_binding_id AND f.parent_id IS NOT DISTINCT FROM p.destination_folder_id AND f.name=p.destination_name\n   AND f.created_by=a.approved_by AND f.created_agent_id IS NULL AND f.run_id IS NULL\n   AND v.created_by=a.approved_by AND v.created_agent_id IS NULL AND v.run_id IS NULL\n   AND u.status='allocated' AND u.archive_id IS NULL AND u.actor_key='preparation:'||p.id::text\n   AND u.actor_user_id=a.approved_by AND u.actor_agent_id IS NULL AND u.run_id IS NULL\n   AND u.client_id=p.id AND u.request_hash=p.request_hash\n   AND u.part_bytes=67108864 AND u.provider_upload_id IS NULL AND u.provider_descriptor IS NULL AND u.provider_etag IS NULL\n   AND u.verification_grant_id IS NULL AND u.active_part IS NULL AND u.action_id IS NULL AND u.action_expires_at IS NULL\n   AND u.expires_at>clock_timestamp() AND u.expires_at<=p.lease_expires_at AND u.expires_at<=a.expires_at\n   AND NOT EXISTS(SELECT 1 FROM project_storage_versions other WHERE other.company_id=v.company_id AND other.file_id=v.file_id AND other.id<>v.id)\n   AND NOT EXISTS(SELECT 1 FROM project_storage_upload_parts part WHERE part.company_id=u.company_id AND part.upload_id=u.id)\n   AND NOT EXISTS(SELECT 1 FROM project_storage_verifications ok WHERE ok.company_id=v.company_id AND ok.version_id=v.id)\n   AND EXISTS(SELECT 1 FROM project_image_preparation_receipts intent WHERE intent.company_id=p.company_id AND intent.project_id=p.project_id AND intent.preparation_id=p.id\n    AND intent.action_id=NEW.store_action_id AND intent.operation='store' AND intent.phase='intent')\n ) THEN RAISE EXCEPTION 'Preparation allocation requires its exact approved new derivative and one binding revision' USING ERRCODE='23514'; END IF;\n RETURN NEW;\nEND",
    "definer": false,
    "config": [
      "search_path=pg_catalog, public"
    ],
    "args": "",
    "type": 7,
    "enabled": "O"
  },
  {
    "table": "project_image_preparation_receipts",
    "trigger": "project_image_preparation_multipart_receipt_guard",
    "function": "validate_project_image_preparation_multipart_receipt",
    "body": "BEGIN\n IF NEW.operation IN ('store_initiate','store_part','store_complete') AND NEW.phase='returned' AND NOT EXISTS(\n  SELECT 1 FROM project_image_preparation_receipts WHERE company_id=NEW.company_id AND project_id=NEW.project_id AND preparation_id=NEW.preparation_id\n   AND action_id=NEW.action_id AND operation=NEW.operation AND phase='intent'\n ) THEN RAISE EXCEPTION 'Preparation multipart result requires its exact prior intent' USING ERRCODE='23514'; END IF;\n RETURN NEW;\nEND",
    "definer": false,
    "config": [
      "search_path=pg_catalog, public"
    ],
    "args": "",
    "type": 7,
    "enabled": "O"
  },
  {
    "table": "project_storage_upload_parts",
    "trigger": "project_image_preparation_upload_part_guard",
    "function": "validate_project_image_preparation_upload_part",
    "body": "BEGIN\n IF EXISTS(SELECT 1 FROM public.project_image_preparation_allocations WHERE company_id=NEW.company_id AND upload_id=NEW.upload_id)\n  AND NOT EXISTS(SELECT 1 FROM public.project_image_preparation_allocations WHERE company_id=NEW.company_id AND upload_id=NEW.upload_id\n   AND NEW.part_number=1 AND output_bytes=NEW.bytes AND output_sha256=NEW.sha256)\n THEN RAISE EXCEPTION 'Preparation upload requires its one exact output part' USING ERRCODE='23514'; END IF;\n RETURN NEW;\nEND",
    "definer": true,
    "config": [
      "search_path=pg_catalog, public, pg_temp"
    ],
    "args": "",
    "type": 7,
    "enabled": "O"
  },
  {
    "table": "project_image_preparation_derivations",
    "trigger": "project_image_preparation_derivation_allocation_guard",
    "function": "validate_project_image_preparation_derivation_allocation",
    "body": "BEGIN\n IF NOT EXISTS(\n  SELECT 1 FROM project_image_preparation_allocations a\n  WHERE (a.company_id,a.project_id,a.preparation_id)=(NEW.company_id,NEW.project_id,NEW.preparation_id)\n   AND a.file_id=NEW.output_file_id AND a.version_id=NEW.output_version_id AND a.upload_id=NEW.upload_id\n   AND a.output_sha256=NEW.output_sha256 AND a.output_bytes=NEW.output_bytes\n ) THEN RAISE EXCEPTION 'Preparation derivation requires its exact immutable allocation' USING ERRCODE='23514'; END IF;\n RETURN NEW;\nEND",
    "definer": false,
    "config": [
      "search_path=pg_catalog, public"
    ],
    "args": "",
    "type": 7,
    "enabled": "O"
  },
  {
    "table": "project_image_preparation_service_projects",
    "trigger": "image_preparation_service_project_immutable",
    "function": "guard_image_preparation_service_immutable",
    "body": "BEGIN\n IF NEW IS DISTINCT FROM OLD THEN RAISE EXCEPTION 'preparation service evidence is immutable' USING ERRCODE='42501';END IF;\n RETURN NEW;\nEND",
    "definer": false,
    "config": [
      "search_path=pg_catalog, public"
    ],
    "args": "",
    "type": 19,
    "enabled": "A"
  },
  {
    "table": "project_image_preparation_service_enrollments",
    "trigger": "image_preparation_service_enrollment_immutable",
    "function": "guard_image_preparation_service_immutable",
    "body": "BEGIN\n IF NEW IS DISTINCT FROM OLD THEN RAISE EXCEPTION 'preparation service evidence is immutable' USING ERRCODE='42501';END IF;\n RETURN NEW;\nEND",
    "definer": false,
    "config": [
      "search_path=pg_catalog, public"
    ],
    "args": "",
    "type": 19,
    "enabled": "A"
  },
  {
    "table": "project_image_preparation_service_leases",
    "trigger": "image_preparation_service_lease_immutable",
    "function": "guard_image_preparation_service_immutable",
    "body": "BEGIN\n IF NEW IS DISTINCT FROM OLD THEN RAISE EXCEPTION 'preparation service evidence is immutable' USING ERRCODE='42501';END IF;\n RETURN NEW;\nEND",
    "definer": false,
    "config": [
      "search_path=pg_catalog, public"
    ],
    "args": "",
    "type": 19,
    "enabled": "A"
  },
  {
    "table": "project_image_preparation_byte_grants",
    "trigger": "image_preparation_byte_grant_immutable",
    "function": "guard_image_preparation_service_immutable",
    "body": "BEGIN\n IF NEW IS DISTINCT FROM OLD THEN RAISE EXCEPTION 'preparation service evidence is immutable' USING ERRCODE='42501';END IF;\n RETURN NEW;\nEND",
    "definer": false,
    "config": [
      "search_path=pg_catalog, public"
    ],
    "args": "",
    "type": 19,
    "enabled": "A"
  },
  {
    "table": "project_image_preparation_services",
    "trigger": "image_preparation_service_stop",
    "function": "guard_image_preparation_service_stop",
    "body": "BEGIN\n IF NEW IS DISTINCT FROM OLD AND NOT (\n  OLD.revoked_at IS NULL AND NEW.revoked_at IS NOT NULL AND NEW.revoked_at<=clock_timestamp() AND NEW.revoked_by IS NOT NULL\n  AND NEW.revision=OLD.revision+1 AND NEW.updated_at>=OLD.updated_at\n  AND (to_jsonb(NEW)-ARRAY['revoked_at','revoked_by','revision','updated_at'])=(to_jsonb(OLD)-ARRAY['revoked_at','revoked_by','revision','updated_at'])\n ) THEN RAISE EXCEPTION 'preparation service can only be stopped' USING ERRCODE='42501';END IF;\n RETURN NEW;\nEND",
    "definer": false,
    "config": [
      "search_path=pg_catalog, public"
    ],
    "args": "",
    "type": 19,
    "enabled": "A"
  },
  {
    "table": "project_image_preparation_service_calls",
    "trigger": "image_preparation_service_call_result",
    "function": "guard_image_preparation_service_result",
    "body": "BEGIN\n IF TG_OP='INSERT' THEN\n  IF NEW.status<>'started' THEN RAISE EXCEPTION 'preparation operation must start before external work' USING ERRCODE='23514';END IF;\n ELSIF (to_jsonb(NEW)-TG_ARGV::text[]) IS DISTINCT FROM (to_jsonb(OLD)-TG_ARGV::text[])\n  OR (OLD.status='completed' AND NEW IS DISTINCT FROM OLD)\n  OR (NEW IS DISTINCT FROM OLD AND NOT (OLD.status='started' AND NEW.status='completed')) THEN\n  RAISE EXCEPTION 'preparation operation result is immutable' USING ERRCODE='42501';\n END IF;\n RETURN NEW;\nEND",
    "definer": false,
    "config": [
      "search_path=pg_catalog, public"
    ],
    "args": "status\\000response\\000finished_at\\000",
    "type": 23,
    "enabled": "A"
  },
  {
    "table": "project_image_preparation_byte_results",
    "trigger": "image_preparation_byte_result",
    "function": "guard_image_preparation_service_result",
    "body": "BEGIN\n IF TG_OP='INSERT' THEN\n  IF NEW.status<>'started' THEN RAISE EXCEPTION 'preparation operation must start before external work' USING ERRCODE='23514';END IF;\n ELSIF (to_jsonb(NEW)-TG_ARGV::text[]) IS DISTINCT FROM (to_jsonb(OLD)-TG_ARGV::text[])\n  OR (OLD.status='completed' AND NEW IS DISTINCT FROM OLD)\n  OR (NEW IS DISTINCT FROM OLD AND NOT (OLD.status='started' AND NEW.status='completed')) THEN\n  RAISE EXCEPTION 'preparation operation result is immutable' USING ERRCODE='42501';\n END IF;\n RETURN NEW;\nEND",
    "definer": false,
    "config": [
      "search_path=pg_catalog, public"
    ],
    "args": "status\\000public_result\\000provider_result\\000observed_bytes\\000observed_sha256\\000observed_etag\\000finished_at\\000",
    "type": 23,
    "enabled": "A"
  },
  {
    "table": "project_image_preparation_service_leases",
    "trigger": "image_preparation_service_lease_guard",
    "function": "validate_image_preparation_service_lease",
    "body": "BEGIN\n IF NOT EXISTS(SELECT 1 FROM project_image_preparations p JOIN project_image_preparation_approvals a ON a.company_id=p.company_id AND a.preparation_id=p.id\n  JOIN project_image_preparation_services s ON s.company_id=p.company_id AND s.id=NEW.service_id\n  WHERE p.company_id=NEW.company_id AND p.project_id=NEW.project_id AND p.id=NEW.preparation_id AND p.lease_id=NEW.lease_id\n   AND p.status='reading' AND p.attempt=1 AND p.revoked_at IS NULL AND p.lease_expires_at>clock_timestamp()\n   AND s.revoked_at IS NULL AND s.expires_at>clock_timestamp() AND a.expires_at>clock_timestamp()\n   AND a.processor_snapshot->>'id'=s.id::text AND a.processor_snapshot=NEW.lease->'processor'\n   AND NEW.request_hash=p.request_hash AND NEW.lease->>'companyId'=p.company_id::text AND NEW.lease->>'projectId'=p.project_id::text\n   AND NEW.lease->>'preparationId'=p.id::text AND NEW.lease->>'leaseId'=p.lease_id::text AND NEW.lease->>'requestHash'=p.request_hash\n   AND NEW.lease->>'recipeSha256'=p.recipe_sha256 AND (NEW.lease->>'expiresAt')::timestamptz=date_trunc('milliseconds',p.lease_expires_at)\n   AND (NEW.lease->>'claimedAt')::timestamptz=date_trunc('milliseconds',p.claimed_at)\n   AND NEW.lease->'source'=p.source_snapshot-ARRAY['objectKey','providerEtag']) THEN\n  RAISE EXCEPTION 'preparation service lease differs from exact claim' USING ERRCODE='23514';END IF;\n RETURN NEW;\nEND",
    "definer": false,
    "config": [
      "search_path=pg_catalog, public"
    ],
    "args": "",
    "type": 7,
    "enabled": "A"
  },
  {
    "table": "project_image_preparation_byte_grants",
    "trigger": "image_preparation_byte_grant_guard",
    "function": "validate_image_preparation_byte_grant",
    "body": "DECLARE p project_image_preparations; a project_image_preparation_approvals; allocation project_image_preparation_allocations; s project_image_preparation_services; scope project_image_preparation_service_projects; call project_image_preparation_service_calls;\nBEGIN\n SELECT * INTO p FROM project_image_preparations WHERE company_id=NEW.company_id AND project_id=NEW.project_id AND id=NEW.preparation_id;\n SELECT * INTO a FROM project_image_preparation_approvals WHERE company_id=NEW.company_id AND preparation_id=NEW.preparation_id;\n SELECT * INTO s FROM project_image_preparation_services WHERE company_id=NEW.company_id AND id=NEW.service_id;\n SELECT * INTO scope FROM project_image_preparation_service_projects WHERE company_id=NEW.company_id AND project_id=NEW.project_id AND service_id=NEW.service_id;\n SELECT * INTO call FROM project_image_preparation_service_calls WHERE service_id=NEW.service_id AND request_id=NEW.request_id;\n IF NOT (p.id IS NOT NULL AND a.preparation_id IS NOT NULL AND s.id IS NOT NULL AND scope.service_id IS NOT NULL AND call.request_id IS NOT NULL\n  AND call.operation='byte-capability' AND call.status='started' AND call.deadline_at>clock_timestamp()\n  AND p.attempt=1 AND p.lease_id=NEW.lease_id AND p.request_hash=NEW.request_hash AND p.revoked_at IS NULL AND p.cleanup_confirmed_at IS NULL\n  AND s.revoked_at IS NULL AND a.processor_snapshot->>'id'=s.id::text\n  AND NEW.expires_at<=LEAST(p.lease_expires_at,a.expires_at,s.expires_at,scope.gateway_expires_at,call.deadline_at,(a.processor_snapshot->>'expiresAt')::timestamptz)\n  AND NEW.expires_at>clock_timestamp() AND NEW.storage_binding_id=p.storage_binding_id AND NEW.storage_connection_id=p.storage_connection_id\n  AND NEW.storage_connection_revision=p.storage_connection_revision\n  AND NEW.gateway_binding_id=scope.gateway_binding_id AND NEW.gateway_provision_id=scope.gateway_provision_id\n  AND NEW.gateway_configuration_sha256=scope.gateway_configuration_sha256 AND NEW.gateway_origin=scope.gateway_origin) IS TRUE THEN\n  RAISE EXCEPTION 'preparation capability authority changed' USING ERRCODE='23514';END IF;\n IF NEW.operation='read-source' THEN\n  IF NOT (p.status='reading' AND NEW.version_id=p.source_version_id AND NEW.storage_binding_revision=p.storage_binding_revision\n   AND NEW.bytes=(p.source_snapshot->>'bytes')::bigint AND NEW.sha256=p.source_snapshot->>'sha256'\n   AND NEW.content_type=p.source_snapshot->>'contentType' AND NEW.expected_etag=p.source_snapshot->>'providerEtag') IS TRUE THEN\n   RAISE EXCEPTION 'preparation source capability changed' USING ERRCODE='23514';END IF;\n ELSE\n  SELECT * INTO allocation FROM project_image_preparation_allocations WHERE company_id=p.company_id AND preparation_id=p.id;\n  IF NOT (allocation.preparation_id IS NOT NULL AND NEW.version_id=allocation.version_id AND NEW.upload_id=allocation.upload_id\n   AND NEW.storage_binding_revision=allocation.binding_revision_after AND NEW.bytes=allocation.output_bytes AND NEW.sha256=allocation.output_sha256\n   AND ((NEW.operation='read-output' AND p.status='verifying' AND NEW.expected_etag IS NOT NULL)\n    OR (NEW.operation<>'read-output' AND p.status='storing' AND EXISTS(SELECT 1 FROM project_storage_uploads u\n     WHERE u.company_id=p.company_id AND u.id=allocation.upload_id AND u.action_id=NEW.action_id AND u.action_expires_at>clock_timestamp())\n     AND EXISTS(SELECT 1 FROM project_image_preparation_receipts r WHERE r.company_id=p.company_id AND r.preparation_id=p.id AND r.action_id=NEW.action_id AND r.operation='store_'||NEW.operation AND r.phase='intent')))) IS TRUE THEN\n   RAISE EXCEPTION 'preparation derivative capability changed' USING ERRCODE='23514';END IF;\n END IF;\n RETURN NEW;\nEND",
    "definer": false,
    "config": [
      "search_path=pg_catalog, public"
    ],
    "args": "",
    "type": 7,
    "enabled": "A"
  },
  {
    "table": "project_image_preparation_byte_results",
    "trigger": "image_preparation_byte_result_guard",
    "function": "validate_image_preparation_byte_result",
    "body": "DECLARE grant_row project_image_preparation_byte_grants;\nBEGIN\n SELECT * INTO grant_row FROM project_image_preparation_byte_grants WHERE id=NEW.grant_id;\n IF grant_row.id IS NULL THEN RAISE EXCEPTION 'preparation transport grant is missing' USING ERRCODE='23514';END IF;\n IF TG_OP='INSERT' THEN\n  IF grant_row.expires_at<=clock_timestamp() OR NEW.provider_result IS NOT NULL OR NEW.observed_bytes IS NOT NULL OR NEW.observed_sha256 IS NOT NULL OR NEW.observed_etag IS NOT NULL THEN\n   RAISE EXCEPTION 'preparation transport must start empty within its grant' USING ERRCODE='23514';END IF;\n ELSIF NEW.status='completed' THEN\n  IF NOT ((grant_row.operation IN ('read-source','read-output'))=(NEW.provider_result IS NULL)\n   AND (grant_row.operation NOT IN ('read-source','read-output','part') OR (NEW.observed_bytes=grant_row.bytes AND NEW.observed_sha256=grant_row.sha256))\n   AND (grant_row.operation NOT IN ('read-source','read-output') OR NEW.observed_etag=grant_row.expected_etag)\n   AND (grant_row.operation<>'complete' OR NEW.observed_etag IS NOT NULL)) IS TRUE THEN\n   RAISE EXCEPTION 'preparation transport result differs from exact bytes' USING ERRCODE='23514';END IF;\n END IF;\n RETURN NEW;\nEND",
    "definer": false,
    "config": [
      "search_path=pg_catalog, public"
    ],
    "args": "",
    "type": 23,
    "enabled": "A"
  }
];
// Share frozen expected bodies with the explicit gateway extension. Never read
// mutable migration files to determine what a production preflight accepts.
for(const guard of STATE_GUARDS){if(guard.config)Object.freeze(guard.config);Object.freeze(guard);}
export const IMAGE_PREPARATION_STATE_GUARDS=Object.freeze(STATE_GUARDS);
const userSchema="n.nspname NOT IN ('pg_catalog','information_schema') AND n.nspname !~ '^pg_(toast|temp)'";
export class ImagePreparationDatabaseError extends Error{constructor(code){super(code);this.name='ImagePreparationDatabaseError';this.code=code;}}
/** @param {string} code @returns {never} */
const fail=code=>{throw new ImagePreparationDatabaseError(code);};
/** @param {{query:(sql:string,values?:any[])=>Promise<{rows:any[]}>}} db
 * @param {{provisioning?:boolean}} options SET ROLE allowed only in the owner
 * transaction before creating the independent registrar LOGIN connection. */
async function assertImagePreparationDatabase(db,kind,options={}){
 const roleName=kind==='broker'?IMAGE_PREPARATION_BROKER_ROLE:IMAGE_PREPARATION_REGISTRAR_ROLE,contract=kind==='broker'?IMAGE_PREPARATION_BROKER_CONTRACT:IMAGE_PREPARATION_REGISTRAR_CONTRACT,lockTables=LOCK_TABLES[kind];
 try{
  const role=(await db.query(`SELECT current_user::text AS current_user,session_user::text AS session_user,r.rolcanlogin,r.rolinherit,r.rolsuper,r.rolcreatedb,r.rolcreaterole,r.rolreplication,r.rolbypassrls,
   current_setting('server_version_num')::integer AS version,EXISTS(SELECT 1 FROM pg_catalog.pg_auth_members m WHERE m.member=r.oid) AS member_of_role,
   d.datdba=r.oid AS owns_database,pg_catalog.has_database_privilege(current_user,d.oid,'CREATE') AS database_create,
   pg_catalog.has_database_privilege(current_user,d.oid,'CONNECT') AS can_connect,pg_catalog.has_schema_privilege(current_user,'public','USAGE') AS public_usage
   FROM pg_catalog.pg_roles r JOIN pg_catalog.pg_database d ON d.datname=current_database() WHERE r.rolname=current_user`)).rows[0];
  if(!role||role.current_user!==roleName||!options.provisioning&&role.session_user!==roleName)fail('IMAGE_PREPARATION_DB_IDENTITY');
  if(role.rolcanlogin!==true||role.can_connect!==true||['rolinherit','rolsuper','rolcreatedb','rolcreaterole','rolreplication','rolbypassrls','member_of_role','owns_database','database_create'].some(k=>role[k]!==false))fail('IMAGE_PREPARATION_DB_ROLE');
  if(role.public_usage!==true||(await db.query(`SELECT 1 FROM pg_catalog.pg_namespace n WHERE ${userSchema} AND (n.nspowner=(SELECT oid FROM pg_catalog.pg_roles WHERE rolname=current_user) OR pg_catalog.has_schema_privilege(current_user,n.oid,'CREATE')) LIMIT 1`)).rows.length)fail('IMAGE_PREPARATION_DB_SCHEMA');
  const saved=(await db.query('SELECT name FROM public.schema_migrations WHERE name=ANY($1::text[])',[migrations])).rows;if(new Set(saved.map(r=>r.name)).size!==migrations.length)fail('IMAGE_PREPARATION_DB_MIGRATIONS');
  const privileges=['SELECT','INSERT','UPDATE','REFERENCES'],tablePrivileges=[...privileges,'DELETE','TRUNCATE','TRIGGER',...Number(role.version)>=170000?['MAINTAIN']:[]];
  const tables=(await db.query(`SELECT n.nspname AS schema,c.relname AS name,c.relkind AS kind,c.relowner=(SELECT oid FROM pg_catalog.pg_roles WHERE rolname=current_user) AS owned,p.privilege,
   pg_catalog.has_table_privilege(current_user,c.oid,p.privilege) AS allowed,pg_catalog.has_table_privilege(current_user,c.oid,p.privilege||' WITH GRANT OPTION') AS grantable
   FROM pg_catalog.pg_class c JOIN pg_catalog.pg_namespace n ON n.oid=c.relnamespace CROSS JOIN unnest($1::text[]) p(privilege)
   WHERE ${userSchema} AND c.relkind IN ('r','p','v','m','f')`,[tablePrivileges])).rows,found=new Set();
  for(const row of tables){const spec=row.schema==='public'?contract[row.name]:undefined;if(spec){found.add(row.name);if(row.kind!=='r')fail('IMAGE_PREPARATION_DB_SCHEMA');}if(row.owned!==false||row.grantable!==false||row.allowed!==(spec?.[row.privilege]==='*'))fail('IMAGE_PREPARATION_DB_PRIVILEGES');}
  if(Object.keys(contract).some(name=>!found.has(name)))fail('IMAGE_PREPARATION_DB_SCHEMA');
  const columns=(await db.query(`SELECT n.nspname AS schema,c.relname AS name,a.attname AS column,p.privilege,pg_catalog.has_column_privilege(current_user,c.oid,a.attnum,p.privilege) AS allowed,
   pg_catalog.has_column_privilege(current_user,c.oid,a.attnum,p.privilege||' WITH GRANT OPTION') AS grantable FROM pg_catalog.pg_class c JOIN pg_catalog.pg_namespace n ON n.oid=c.relnamespace
   JOIN pg_catalog.pg_attribute a ON a.attrelid=c.oid AND a.attnum>0 AND NOT a.attisdropped CROSS JOIN unnest($1::text[]) p(privilege)
   WHERE ${userSchema} AND c.relkind IN ('r','p','v','m','f')`,[privileges])).rows,foundColumns=new Set();
  for(const row of columns){const spec=row.schema==='public'?contract[row.name]?.[row.privilege]:undefined;if(row.grantable!==false||row.allowed!==(spec==='*'||Array.isArray(spec)&&spec.includes(row.column)))fail('IMAGE_PREPARATION_DB_PRIVILEGES');foundColumns.add(`${row.schema}.${row.name}.${row.column}.${row.privilege}`);}
  for(const [table,spec]of Object.entries(contract))for(const privilege of privileges){const required=spec[privilege];if(Array.isArray(required)&&required.some(c=>!foundColumns.has(`public.${table}.${c}.${privilege}`)))fail('IMAGE_PREPARATION_DB_SCHEMA');}
  if((await db.query(`SELECT 'sequence' AS kind FROM pg_catalog.pg_class c JOIN pg_catalog.pg_namespace n ON n.oid=c.relnamespace WHERE ${userSchema} AND c.relkind='S'
   AND (c.relowner=(SELECT oid FROM pg_catalog.pg_roles WHERE rolname=current_user) OR pg_catalog.has_sequence_privilege(current_user,c.oid,'SELECT,UPDATE,USAGE'))
   UNION ALL SELECT 'function' FROM pg_catalog.pg_proc p JOIN pg_catalog.pg_namespace n ON n.oid=p.pronamespace WHERE ${userSchema}
   AND (p.proowner=(SELECT oid FROM pg_catalog.pg_roles WHERE rolname=current_user) OR p.prosecdef AND pg_catalog.has_function_privilege(current_user,p.oid,'EXECUTE')) LIMIT 1`)).rows.length)fail('IMAGE_PREPARATION_DB_PRIVILEGES');
  const guards=(await db.query(`SELECT c.relname,t.tgname,t.tgenabled,t.tgtype,t.tgqual IS NULL AS no_when,t.tgattr::text AS update_columns,p.prosrc,p.prosecdef,p.proconfig,p.pronargs,p.proretset,p.prokind,p.prorettype='pg_catalog.trigger'::regtype AS trigger_return,pn.nspname AS function_schema,p.proname AS function_name,l.lanname,encode(t.tgargs,'escape') AS arguments FROM pg_catalog.pg_trigger t JOIN pg_catalog.pg_class c ON c.oid=t.tgrelid JOIN pg_catalog.pg_namespace n ON n.oid=c.relnamespace JOIN pg_catalog.pg_proc p ON p.oid=t.tgfoid JOIN pg_catalog.pg_namespace pn ON pn.oid=p.pronamespace JOIN pg_catalog.pg_language l ON l.oid=p.prolang WHERE n.nspname='public'`)).rows;
  const lockName='coatria_image_preparation_'+kind+'_lock_guard';
  const expected=[...lockTables.map(table=>({table,trigger:lockName,function:lockName,body:IMAGE_PREPARATION_LOCK_BODY,args:roleName+'\\000',type:19})),...STATE_GUARDS];
  for(const e of expected){const g=guards.find(v=>v.relname===e.table&&v.tgname===e.trigger);if(!g||g.tgenabled!==(e.enabled??'A')||g.tgtype!==e.type||g.no_when!==true||g.update_columns!==''||g.prosecdef!==(e.definer??false)||g.prosrc.replaceAll('\r\n','\n').trim()!==e.body||g.arguments!==e.args||JSON.stringify(g.proconfig)!==JSON.stringify(e.config??['search_path=pg_catalog, public'])||g.function_schema!=='public'||g.function_name!==e.function||g.lanname!=='plpgsql'||g.pronargs!==0||g.proretset!==false||g.prokind!=='f'||g.trigger_return!==true)fail('IMAGE_PREPARATION_DB_GUARD');}
  return {status:'passed',role:roleName,contractVersion:1,independentLogin:!options.provisioning,checkedMigrations:migrations.length};
 }catch(error){if(error instanceof ImagePreparationDatabaseError)throw error;fail('IMAGE_PREPARATION_DB_CHECK_FAILED');}
}

export const assertImagePreparationBrokerDatabase=(db,options={})=>assertImagePreparationDatabase(db,'broker',options);
export const assertImagePreparationRegistrarDatabase=(db,options={})=>assertImagePreparationDatabase(db,'registrar',options);
