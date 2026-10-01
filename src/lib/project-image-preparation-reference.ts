/** A fresh reference proposal derived only from a verified preparation. No
 * inspection, sharing permission, agent impersonation or provider call. */
import type {PoolClient} from 'pg';
import {fail,id} from './security';
import {getProjectImagePreparation} from './project-image-preparations';
import {projectImagePreparationReferenceInput,type ProjectImagePreparationActor} from './project-image-preparations-protocol';
import {projectImagePreparationProvenance} from './project-image-preparation-provenance';
import {proposeHiggsfieldReference,currentHiggsfieldReferenceHandoff} from './higgsfield-references';

export async function proposeProjectImagePreparationReference(db:PoolClient,actor:ProjectImagePreparationActor,preparationId:string,input:unknown){
 const parsed=projectImagePreparationReferenceInput.safeParse(input);
 if(!parsed.success)fail(400,'Choose the exact prepared result and an eligible reference or generation task.','VALIDATION_ERROR');
 const data=parsed.data,initial=await getProjectImagePreparation(db,actor,id(preparationId));
 // Match worker/revocation order before locking the result; ordinary reference
 // proposal subsequently takes this same project's update lock.
 await db.query('SELECT id FROM studio_projects WHERE company_id=$1 AND id=$2 FOR NO KEY UPDATE',[actor.companyId,initial.preparation.projectId]);
 await db.query('SELECT id FROM project_image_preparations WHERE company_id=$1 AND id=$2 FOR SHARE',[actor.companyId,preparationId]);
 const {preparation:p}=await getProjectImagePreparation(db,actor,preparationId),d=p.derivation;
 if(p.status!=='ready'||p.revokedAt||!p.cleanupConfirmedAt||p.revision!==data.revision||!d||d.sourceVersionId!==p.source.versionId||d.sourceSha256!==p.source.sha256||d.sourceBytes!==p.source.bytes||d.recipeSha256!==p.recipeSha256)fail(409,'The exact prepared derivative is not ready. Refresh its saved state before creating a reference.','IMAGE_PREPARATION_NOT_READY');
 const proof=await projectImagePreparationProvenance(db,actor.companyId,p.projectId,d.outputVersionId);
 if(!proof||proof.id!==p.id||proof.receiptSha256!==d.receiptSha256||proof.sourceVersionId!==p.source.versionId)fail(409,'The stored preparation evidence changed.','IMAGE_PREPARATION_DERIVATION_CHANGED');
 const result=await proposeHiggsfieldReference(db,actor,{clientId:data.clientId,projectId:p.projectId,projectRevision:data.projectRevision,workItemId:data.workItemId,proxyVersionId:d.outputVersionId,proxySha256:d.outputSha256,proxyBytes:d.outputBytes,sourceVersionId:d.sourceVersionId,role:data.role,purpose:data.purpose});
 return {...result,reference:await currentHiggsfieldReferenceHandoff(db,actor,result.reference.id)};
}
