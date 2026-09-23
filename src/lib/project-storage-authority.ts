import type {PoolClient} from 'pg';
import {authorizeStoredStorageAgentRun} from './agent-runs';
import {ApiError,fail} from './security';

/** Internal grant snapshots, never caller-supplied lease hashes. */
export async function authorizeStorageGrantAgent(client:PoolClient,grant:Record<string,any>){
 if(!grant.agent_id)return;
 const identity=(await client.query('SELECT id,company_id,created_by,token_hash FROM agents WHERE company_id=$1 AND id=$2',[grant.company_id,grant.agent_id])).rows[0];
 if(!identity||identity.token_hash!==grant.agent_token_hash)fail(403,'The storage agent credential changed.','STORAGE_ACCESS_DENIED');
 try{
  const context=await authorizeStoredStorageAgentRun(client,identity,grant.run_id,grant.agent_lease_hash);
  const capability=grant.operation==='upload'?'storage.write':'storage.read';
  if(context.run.requested_by!==grant.user_id||!context.capabilities.includes(capability))fail(403,'The current run does not authorize this file operation.');
 }catch(error){if(error instanceof ApiError&&error.status<500)fail(403,'The agent lease or project authorization ended.','STORAGE_ACCESS_DENIED');throw error;}
}
