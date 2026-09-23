import type {PoolClient} from 'pg';
import {loadCompanyRuntimeConfiguration} from './company-runtime-config';
import {sameRuntimeConfiguration,trustedServiceHash,type TrustedServicePreset} from './company-runtime-preset';
/** Legacy operational gate, not a claim that any transfer is healthy. */
export function higgsfieldArchiveAvailability(){
 const enabled=process.env.COATRIA_HIGGSFIELD_ARCHIVE_ENABLED==='true';
 return {enabled,message:enabled?'Archive processing is enabled. Each request is checked again by the transfer worker.':'Archive processing is not enabled for this deployment. You can prepare destinations; approval becomes available after the transfer worker and storage are configured.'};
}

/** A durable selection supersedes deployment-wide configuration permanently. */
export async function companyHiggsfieldArchiveAvailability(db:PoolClient,companyId:string,projectId?:string){
 const unavailable={enabled:false,message:'A running, configured archive service is required for this project.',expiresAt:null as string|null};
 if(process.env.COATRIA_HIGGSFIELD_ARCHIVE_ENABLED==='false')return unavailable;
 const selected=await loadCompanyRuntimeConfiguration(db,companyId,'archive');
 if(!selected)return {...higgsfieldArchiveAvailability(),expiresAt:null};
 if(!selected.enabled)return unavailable;
 const preset=selected.preset as TrustedServicePreset;if(projectId&&!preset.projectIds.includes(projectId))return unavailable;
 const rows=(await db.query("SELECT p.preset,p.plan,p.plan_hash,p.expected_environment_hashes,p.expires_at FROM trusted_service_provisions p JOIN company_runtime_configurations c ON c.id=$2 AND c.company_id=p.company_id AND c.phase='service' WHERE p.company_id=$1 AND p.service='archive' AND p.phase='running' AND p.provider_status='RUNNING' AND p.stop_requested_at IS NULL AND p.expires_at>clock_timestamp()+interval '1 minute' AND p.last_reconciled_at>clock_timestamp()-interval '2 minutes' AND EXISTS(SELECT 1 FROM memberships m WHERE m.company_id=p.company_id AND m.user_id=p.created_by AND m.role IN ('owner','admin'))",[companyId,selected.configurationId])).rows;
 const row=rows.find(row=>sameRuntimeConfiguration(row.plan.runtimeConfiguration,selected)&&trustedServiceHash(row.plan)===row.plan_hash&&trustedServiceHash(row.preset)===row.plan.preset.hash&&trustedServiceHash(row.preset)===trustedServiceHash(preset));
 if(!row)return unavailable;
 const credential=(await db.query('SELECT id FROM company_runtime_executor_credentials WHERE company_id=$1 AND configuration_id=$2 AND revoked_at IS NULL AND expires_at>=$3::timestamptz+interval \'1 minute\' AND token_hash=$4',[companyId,selected.configurationId,preset.expiresAt,row.expected_environment_hashes?.COATRIA_VERCEL_MEDIA_TOKEN??null])).rowCount;
 if(!credential)return unavailable;
 return {enabled:true,message:'The project archive service is running. Every transfer is checked again before processing.',expiresAt:new Date(Math.min(Date.parse(selected.expiresAt),+new Date(row.expires_at))).toISOString()};
}
