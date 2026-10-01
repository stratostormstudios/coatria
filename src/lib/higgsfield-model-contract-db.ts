import type {PoolClient} from 'pg';
import {fail} from './security';
import {checkHiggsfieldModelContract,higgsfieldModelDigest,normalizeHiggsfieldModelContract,type HiggsfieldModelContract} from './higgsfield-model-contract';

type Connection={id:string;revision:number;tools:unknown};
export type HiggsfieldModelSnapshot={version:1;companyId:string;connectionId:string;connectionRevision:number;catalogSha256:string;descriptorSha256:string;descriptor:HiggsfieldModelContract};
const object=(v:unknown):v is Record<string,unknown>=>!!v&&typeof v==='object'&&!Array.isArray(v);
const identifier=(v:unknown):v is string=>typeof v==='string'&&/^[a-zA-Z0-9][a-zA-Z0-9_.-]{0,127}$/.test(v);
function changed():never{fail(409,'The selected model metadata is missing, stale or changed. Refresh Available models (or models_get) in this company connection, then review the generation again.','HIGGSFIELD_MODEL_CONTRACT_CHANGED');}
/** Only explicit catalog list/get reads can update model constraints. Discovery
 * search/recommend output and an omitted models_explore action are not evidence. */
export function classifyHiggsfieldModelRead(tool:string,args:Record<string,unknown>):'list'|'get'|null{
 if(tool==='models_list')return 'list';
 if(tool==='models_get')return 'get';
 return tool==='models_explore'&&(args.action==='list'||args.action==='get')?args.action:null;
}
/** Called only after the authenticated official read and a current connection
 * recheck. No browser or agent request can directly supply cached descriptors. */
export async function recordHiggsfieldModelContracts(db:PoolClient,companyId:string,connection:Connection,tool:string,args:Record<string,unknown>,result:unknown){
 const kind=classifyHiggsfieldModelRead(tool,args);if(!kind)return;
 if(!object(result)||result.isError===true||!object(result.structuredContent))changed();
 const value=result.structuredContent;
 const entries=kind==='get'?[value]:value.items;
 if(!Array.isArray(entries)||entries.length>100||kind==='get'&&(!identifier(args.model_id)||value.id!==args.model_id))changed();
 const ids=entries.map(e=>object(e)?e.id:null);if(ids.some(v=>!identifier(v))||new Set(ids).size!==ids.length)changed();
 for(const entry of entries){
  let descriptor:HiggsfieldModelContract|null=null;try{descriptor=normalizeHiggsfieldModelContract(entry);}catch{/* Retire any formerly supported observation for this exact ID. */}
  await db.query(`INSERT INTO higgsfield_model_contracts(company_id,model_id,connection_id,connection_revision,catalog_sha256,descriptor,descriptor_sha256,observed_at,expires_at) VALUES($1,$2,$3,$4,$5,$6,$7,statement_timestamp(),statement_timestamp()+interval '15 minutes') ON CONFLICT(company_id,model_id) DO UPDATE SET connection_id=EXCLUDED.connection_id,connection_revision=EXCLUDED.connection_revision,catalog_sha256=EXCLUDED.catalog_sha256,descriptor=EXCLUDED.descriptor,descriptor_sha256=EXCLUDED.descriptor_sha256,observed_at=EXCLUDED.observed_at,expires_at=EXCLUDED.expires_at`,[companyId,entry.id,connection.id,connection.revision,higgsfieldModelDigest(connection.tools),descriptor?JSON.stringify(descriptor):null,descriptor?higgsfieldModelDigest(descriptor):null]);
 }
}
export async function getHiggsfieldModelContract(db:PoolClient,companyId:string,connection:Connection,modelId:unknown):Promise<HiggsfieldModelSnapshot>{
 if(!identifier(modelId))changed();
 const row=(await db.query('SELECT * FROM higgsfield_model_contracts WHERE company_id=$1 AND model_id=$2 AND expires_at>clock_timestamp() FOR SHARE',[companyId,modelId])).rows[0];
 if(!row||row.connection_id!==connection.id||row.connection_revision!==connection.revision||row.catalog_sha256!==higgsfieldModelDigest(connection.tools)||!row.descriptor||row.descriptor_sha256!==higgsfieldModelDigest(row.descriptor)||row.descriptor.modelId!==modelId)changed();
 const descriptor=checkHiggsfieldModelContract(row.descriptor);
 if(!(await db.query('SELECT expires_at>clock_timestamp() AS valid FROM higgsfield_model_contracts WHERE company_id=$1 AND model_id=$2',[companyId,modelId])).rows[0]?.valid)changed();
 return {version:1,companyId,connectionId:connection.id,connectionRevision:connection.revision,catalogSha256:row.catalog_sha256,descriptorSha256:row.descriptor_sha256,descriptor};
}
export async function revalidateHiggsfieldModelContract(db:PoolClient,companyId:string,connection:Connection,snapshot:HiggsfieldModelSnapshot){
 if(!snapshot||snapshot.version!==1||snapshot.companyId!==companyId)changed();
 const current=await getHiggsfieldModelContract(db,companyId,connection,snapshot.descriptor?.modelId);
 if(higgsfieldModelDigest(current)!==higgsfieldModelDigest(snapshot))changed();return current;
}
export async function listHiggsfieldModelContracts(db:PoolClient,companyId:string,connection:Connection){
 const rows=(await db.query(`SELECT model_id AS "modelId",descriptor->>'outputType' AS "outputType",expires_at AS "expiresAt" FROM higgsfield_model_contracts WHERE company_id=$1 AND connection_id=$2 AND connection_revision=$3 AND catalog_sha256=$4 AND descriptor IS NOT NULL AND expires_at>clock_timestamp() ORDER BY model_id LIMIT 51`,[companyId,connection.id,connection.revision,higgsfieldModelDigest(connection.tools)])).rows;
 return {models:rows.slice(0,50),hasMore:rows.length>50,refreshRequired:rows.length===0};
}
