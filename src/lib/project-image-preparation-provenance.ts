/** Derivation facts are read from immutable server evidence, never from a
 * caller's metadata-removal assertion. They confer no current sharing right. */
import type {PoolClient} from 'pg';
import type {HiggsfieldReference} from './higgsfield-references-protocol';

export async function projectImagePreparationProvenance(db:PoolClient,companyId:string,projectId:string,outputVersionId:string):Promise<HiggsfieldReference['preparation']|null>{
 const row=(await db.query(`SELECT d.* FROM project_image_preparation_derivations d
 JOIN project_image_preparation_allocations a ON (a.company_id,a.project_id,a.preparation_id,a.version_id,a.file_id,a.upload_id)=(d.company_id,d.project_id,d.preparation_id,d.output_version_id,d.output_file_id,d.upload_id)
 JOIN project_storage_verifications v ON (v.company_id,v.project_id,v.version_id)=(d.company_id,d.project_id,d.output_version_id)
 WHERE d.company_id=$1 AND d.project_id=$2 AND d.output_version_id=$3
 AND d.output_bytes=a.output_bytes AND d.output_sha256=a.output_sha256 AND v.bytes=d.output_bytes AND v.sha256=d.output_sha256`,[companyId,projectId,outputVersionId])).rows[0];
 return row?{id:row.preparation_id,sourceVersionId:row.source_version_id,outputVersionId:row.output_version_id,recipeSha256:row.recipe_sha256,receiptSha256:row.receipt_sha256,metadataRemoved:true,outputWidth:row.output_width,outputHeight:row.output_height}:null;
}
