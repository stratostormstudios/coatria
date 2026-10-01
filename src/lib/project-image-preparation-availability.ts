/** Public processor metadata only. Resolution is database-only and grants no
 * processing, storage write, provider sharing, or execution authority. */
import type {PoolClient} from 'pg';
import {fail,id} from './security';
import {IMAGE_PREPARATION_RECIPE_HASH} from './higgsfield-image-preparation';
import {projectImagePreparationProcessorSchema,type ProjectImagePreparationActor,type ProjectImagePreparationAvailability} from './project-image-preparations-protocol';
import {authorizeProjectImagePreparationReader,type ProjectImagePreparationOptions} from './project-image-preparations';

export async function projectImagePreparationAvailability(db:PoolClient,actor:ProjectImagePreparationActor,projectId:string,options:ProjectImagePreparationOptions={}):Promise<ProjectImagePreparationAvailability>{
 await authorizeProjectImagePreparationReader(db,actor);
 const project=(await db.query('SELECT production_path,ai_policy,status,gates FROM studio_projects WHERE company_id=$1 AND id=$2 FOR SHARE',[id(actor.companyId),id(projectId)])).rows[0];
 if(!project)fail(404,'Project not found.');
 if(project.production_path!=='higgsfield'||project.ai_policy!=='allowed'||project.status==='delivered'||['brief','estimate','production'].some(gate=>project.gates[gate]?.decision!=='approved'))return {enabled:false,processor:null,message:'Image preparation needs an active AI project with approved brief, estimate and production gates.'};
 if(!options.runtime)return {enabled:false,processor:null,message:'Image preparation is not available yet. A qualified processor must be connected before processing can be approved. You can save a proposal meanwhile.'};
 const result=projectImagePreparationProcessorSchema.safeParse(await options.runtime(db,actor.companyId,projectId));
 // Repeat actor authority after trusted resolution and evaluate expiry against
 // the database clock rather than a browser or process-local timestamp.
 await authorizeProjectImagePreparationReader(db,actor);
 if(!result.success||result.data.recipeSha256!==IMAGE_PREPARATION_RECIPE_HASH||!(await db.query('SELECT $1::timestamptz>clock_timestamp() AS valid',[result.data.expiresAt])).rows[0].valid)return {enabled:false,processor:null,message:'No current processor qualification matches this image preparation recipe. Review a newly qualified processor before approving processing.'};
 return {enabled:true,processor:result.data,message:'A qualified processor is available. Processing starts only after a human administrator approves this exact original, derivative destination and finite processing permission.'};
}
