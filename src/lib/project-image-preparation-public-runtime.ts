/** Public metadata/consent composition. A configured, preflighted broker is a
 * prerequisite, never a substitute for authority in the caller's transaction.
 * No token, byte grant, worker lease or provider credential is read or minted. */
import type {PoolClient} from 'pg';
import type {ProjectImagePreparationOptions} from './project-image-preparations';
import {resolveProjectImagePreparationProcessor} from './project-image-preparation-service-authority';
import {imagePreparationBrokerConfiguration,imagePreparationBrokerTransaction} from './project-image-preparation-service-runtime';

export async function publicImagePreparationProcessor(db:PoolClient,companyId:string,projectId:string,processorId?:string,dependencies:{brokerReady?:()=>Promise<unknown>}={}){
 try{
  imagePreparationBrokerConfiguration(process.env.COATRIA_IMAGE_PREPARATION_BROKER_DATABASE_URL);
  await (dependencies.brokerReady??imagePreparationBrokerTransaction)();
 }catch{return null;}
 // Never use a separately opened broker transaction to approve a stale app
 // snapshot: project/member/storage/service locks belong to this transaction.
 return resolveProjectImagePreparationProcessor(db,companyId,projectId,processorId);
}
export const publicImagePreparationOptions:ProjectImagePreparationOptions={runtime:publicImagePreparationProcessor};
