import {transaction} from './db';
import type {Membership} from './auth';
import {createHiggsfieldReferenceBroker} from './higgsfield-reference-broker';
import {beginHiggsfieldReferencePhase,completeHiggsfieldReferencePhase,failHiggsfieldReference,getHiggsfieldReferenceTransport,getHiggsfieldReferenceProviderContext,higgsfieldReferenceDigest,type HiggsfieldReferenceOptions} from './higgsfield-references';
import {fail} from './security';

/** Control-plane composition, never an agent tool or worker credential grant.
 * The availability resolver must originate from a qualified finite runtime.
 * Omission remains disabled in the durable backend, regardless of environment. */
export function createDatabaseHiggsfieldReferenceBroker(options:HiggsfieldReferenceOptions={}){
 return createHiggsfieldReferenceBroker({
  authority:async(lease,signal)=>{signal.throwIfAborted();return transaction(db=>getHiggsfieldReferenceProviderContext(db,lease,options));},
  credential:async(lease,signal)=>{
   signal.throwIfAborted();
   const prepared=await transaction(async db=>{
    const context=await getHiggsfieldReferenceProviderContext(db,lease,options);
    const row=(await db.query(`SELECT m.role,u.id,u.name,u.email,u.role_title AS "roleTitle",u.avatar_color AS "avatarColor",u.avatar_id AS "avatarId",u.email_verified_at IS NOT NULL AS "emailVerified" FROM memberships m JOIN users u ON u.id=m.user_id WHERE m.company_id=$1 AND m.user_id=$2 AND m.role IN ('owner','admin') AND m.access_revoked_at IS NULL FOR SHARE OF m`,[lease.companyId,context.approvedBy])).rows[0];
    if(!row)fail(403,'The reference approver is no longer available.','HIGGSFIELD_REFERENCE_AUTHORITY_CHANGED');
    const member:Membership={companyId:lease.companyId,userId:row.id,role:row.role,user:{id:row.id,name:row.name,email:row.email,roleTitle:row.roleTitle,avatarColor:row.avatarColor,avatarId:row.avatarId,emailVerified:row.emailVerified}};
    return {context,member};
   });
   signal.throwIfAborted();const {higgsfieldCredential}=await import('./higgsfield');
   const saved=await higgsfieldCredential(prepared.member);
   if('error' in saved)fail(409,'Reconnect the company Higgsfield account.','HIGGSFIELD_RECONNECT_REQUIRED');
   signal.throwIfAborted();
   return {connectionId:saved.row.id as string,connectionRevision:saved.row.revision as number,catalogSha256:higgsfieldReferenceDigest(saved.row.tools),tools:saved.row.tools,token:saved.token};
  },
  beginPhase:async(lease,phase)=>(await transaction(db=>beginHiggsfieldReferencePhase(db,lease,phase,options))).actionId,
  completePhase:(lease,actionId,result)=>transaction(db=>completeHiggsfieldReferencePhase(db,lease,actionId,result,options)),
  failPhase:(lease,_actionId,_code)=>transaction(db=>failHiggsfieldReference(db,lease,'HIGGSFIELD_REFERENCE_OUTCOME_UNKNOWN')),
  allocation:lease=>transaction(db=>getHiggsfieldReferenceTransport(db,lease,options)),
 });
}
