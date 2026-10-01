import {z} from 'zod';
import {requireMembership} from './auth';
import {memberMutation} from './company';
import {body,id,json,fail} from './security';
/** Read/stop only. Qualification and credential enrollment are operator-owned. */
export async function referenceServiceAdminRoute(request:Request,parts:string[],method:string){
 if(parts[0]!=='companies'||parts[2]!=='higgsfield'||parts[3]!=='reference-services')return null;
 const member=await requireMembership(request,id(parts[1]),true);
 if(parts.length===4&&method==='GET')return json(await memberMutation(member,true,async db=>({services:(await db.query(`SELECT s.id,s.revision,s.created_at AS "createdAt",s.expires_at AS "expiresAt",s.revoked_at AS "revokedAt",s.release_sha256 AS "releaseSha256",
 s.qualification_sha256 AS "qualificationSha256",ARRAY(SELECT p.project_id FROM higgsfield_reference_service_projects p WHERE p.service_id=s.id ORDER BY p.project_id) AS "projectIds"
 FROM higgsfield_reference_services s WHERE s.company_id=$1 ORDER BY s.created_at DESC,s.id LIMIT 50`,[member.companyId])).rows})));
 if(parts.length===6&&parts[5]==='revoke'&&method==='POST'){
  const input=await body(request,z.object({revision:z.number().int().positive()}).strict());
  return json(await memberMutation(member,true,async db=>{const result=await db.query('UPDATE higgsfield_reference_services SET revoked_at=clock_timestamp(),revoked_by=$4,revision=revision+1,updated_at=clock_timestamp() WHERE company_id=$1 AND id=$2 AND revision=$3 AND revoked_at IS NULL RETURNING id,revision,revoked_at AS "revokedAt"',[member.companyId,id(parts[4]),input.revision,member.userId]);if(!result.rowCount)fail(409,'This service changed. Refresh its state before stopping it.','REFERENCE_SERVICE_REVISION_CONFLICT');return {service:result.rows[0],providerBytesDeleted:false};}));
 }
 return null;
}
