import type {PoolClient} from 'pg';
import {fail,id} from './security';
import type {StudioGeneratedRevisionBase} from './studio-generated-revision-protocol';

export type GeneratedRoundFinal={unitId:string;generationWorkItemId:string;qcWorkItemId:string;carry:null|Pick<StudioGeneratedRevisionBase,'artifactId'|'reviewId'|'storageVersionId'|'manifestSha256'|'fileSha256'>};
export type GeneratedRoundScope={roundId:string|null;number:number;planSha256:string|null;workItemIds:string[];finals:GeneratedRoundFinal[]};
const invalid=():never=>fail(409,'The generated revision work scope is unavailable.','STUDIO_REVISION_SCOPE_INVALID');

/** Metadata-only. Callers own company/actor authority and project locks. An
 * absent delivery mapping denotes the original graph, never the active round. */
export async function generatedRoundScope(db:PoolClient,companyId:string,projectId:string,selector:{deliveryId?:string;roundId?:string|null}={}):Promise<GeneratedRoundScope>{
 [companyId,projectId].forEach(id);if(selector.deliveryId&&selector.roundId!==undefined)invalid();
 let roundId=selector.roundId;
 if(selector.deliveryId){id(selector.deliveryId);if(!(await db.query('SELECT id FROM studio_deliveries WHERE company_id=$1 AND project_id=$2 AND id=$3',[companyId,projectId,selector.deliveryId])).rowCount)invalid();roundId=(await db.query('SELECT round_id FROM studio_generated_delivery_rounds WHERE company_id=$1 AND project_id=$2 AND delivery_id=$3',[companyId,projectId,selector.deliveryId])).rows[0]?.round_id??null;}
 else if(roundId===undefined)roundId=(await db.query('SELECT id FROM studio_generated_revision_rounds WHERE company_id=$1 AND project_id=$2 ORDER BY number DESC LIMIT 1',[companyId,projectId])).rows[0]?.id??null;
 if(roundId){
  id(roundId);const round=(await db.query('SELECT number,plan_sha256 FROM studio_generated_revision_rounds WHERE company_id=$1 AND project_id=$2 AND id=$3',[companyId,projectId,roundId])).rows[0];if(!round)invalid();
  const work=(await db.query('SELECT work_item_id FROM studio_generated_revision_work WHERE company_id=$1 AND project_id=$2 AND round_id=$3 ORDER BY work_item_id',[companyId,projectId,roundId])).rows;
  const items=(await db.query('SELECT unit_id,generation_work_item_id,qc_work_item_id,action,artifact_id,review_id,storage_version_id,manifest_sha256,file_sha256 FROM studio_generated_revision_items WHERE company_id=$1 AND project_id=$2 AND round_id=$3 ORDER BY unit_id',[companyId,projectId,roundId])).rows;
  if(!items.length||!work.length)invalid();
  return {roundId,number:round.number,planSha256:round.plan_sha256,workItemIds:work.map(row=>row.work_item_id),finals:items.map(row=>({unitId:row.unit_id,generationWorkItemId:row.generation_work_item_id,qcWorkItemId:row.qc_work_item_id,carry:row.action==='carry'?{artifactId:row.artifact_id,reviewId:row.review_id,storageVersionId:row.storage_version_id,manifestSha256:row.manifest_sha256,fileSha256:row.file_sha256}:null}))};
 }
 const work=(await db.query(`SELECT w.id,w.shot_id,w.stage,w.execution,
 COALESCE((SELECT jsonb_agg(d.predecessor_id) FROM studio_dependencies d WHERE d.company_id=w.company_id AND d.project_id=w.project_id AND d.work_item_id=w.id),'[]') AS dependencies
 FROM studio_work_items w WHERE w.company_id=$1 AND w.project_id=$2 AND NOT EXISTS(SELECT 1 FROM studio_generated_revision_work r WHERE r.company_id=w.company_id AND r.project_id=w.project_id AND r.work_item_id=w.id) ORDER BY w.id`,[companyId,projectId])).rows;
 const units=(await db.query('SELECT id FROM studio_shots WHERE company_id=$1 AND project_id=$2 ORDER BY id',[companyId,projectId])).rows,finals:GeneratedRoundFinal[]=[];
 for(const unit of units){const qc=work.filter(row=>row.shot_id===unit.id&&row.stage==='qc');if(qc.length!==1||qc[0].dependencies.length!==1)invalid();const final=work.find(row=>row.id===qc[0].dependencies[0]);if(!final||final.shot_id!==unit.id||final.stage!=='generation'||final.execution!=='creative')invalid();finals.push({unitId:unit.id,generationWorkItemId:final.id,qcWorkItemId:qc[0].id,carry:null});}
 if(!finals.length)invalid();return {roundId:null,number:0,planSha256:null,workItemIds:work.map(row=>row.id),finals};
}

export async function assertGeneratedWorkCurrent(db:PoolClient,companyId:string,projectId:string,workItemId:string){
 const roundId=(await db.query('SELECT id FROM studio_generated_revision_rounds WHERE company_id=$1 AND project_id=$2 ORDER BY number DESC LIMIT 1',[companyId,projectId])).rows[0]?.id??null;
 const work=(await db.query('SELECT w.id,rw.round_id FROM studio_work_items w LEFT JOIN studio_generated_revision_work rw ON rw.company_id=w.company_id AND rw.project_id=w.project_id AND rw.work_item_id=w.id WHERE w.company_id=$1 AND w.project_id=$2 AND w.id=$3',[companyId,projectId,workItemId])).rows[0];
 if(!work||(work.round_id??null)!==roundId)fail(409,'This work belongs to an earlier accepted production round. Use the current revision work.','STUDIO_REVISION_WORK_SUPERSEDED');return {roundId};
}
export async function assertGeneratedDeliveryCurrent(db:PoolClient,companyId:string,projectId:string,deliveryId:string){
 const current=await generatedRoundScope(db,companyId,projectId),prepared=await generatedRoundScope(db,companyId,projectId,{deliveryId});if(current.roundId!==prepared.roundId)fail(409,'This package belongs to an earlier production round. Use the current revision delivery.','CLIENT_PACKAGE_SUPERSEDED');return prepared;
}
export async function pinGeneratedDeliveryRound(db:PoolClient,companyId:string,projectId:string,deliveryId:string){
 const scope=await generatedRoundScope(db,companyId,projectId);if(scope.roundId)await db.query('INSERT INTO studio_generated_delivery_rounds(company_id,project_id,delivery_id,round_id) VALUES($1,$2,$3,$4)',[companyId,projectId,deliveryId,scope.roundId]);return scope;
}
