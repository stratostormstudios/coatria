/** Vercel metadata composition. The dedicated broker identity must pass its
 * effective-privilege/guard preflight; ordinary DATABASE_URL is never a fallback.
 * Configuration does not enroll a processor, approve a job or start a host. */
import {Pool,type PoolClient} from 'pg';
import {IMAGE_PREPARATION_BROKER_ROLE,assertImagePreparationBrokerDatabase} from './project-image-preparation-database.mjs';
import {createImagePreparationControlService} from './project-image-preparation-service';
import {createProjectImagePreparationServiceHttpHandler} from './project-image-preparation-service-http';
import {preparationServiceOrigin} from './project-image-preparation-service-protocol';

type BrokerState={connectionString:string;pool:Pool;ready:Promise<void>};
const state=globalThis as unknown as {coatriaImagePreparationBroker?:BrokerState};
export function imagePreparationBrokerConfiguration(value:string|undefined){
 if(!value)throw Error('IMAGE_PREPARATION_BROKER_UNAVAILABLE');
 let url:URL;try{url=new URL(value);}catch{throw Error('IMAGE_PREPARATION_BROKER_CONFIGURATION_INVALID');}
 if(!['postgres:','postgresql:'].includes(url.protocol)||decodeURIComponent(url.username)!==IMAGE_PREPARATION_BROKER_ROLE||!url.hostname||!url.password||url.hash)throw Error('IMAGE_PREPARATION_BROKER_CONFIGURATION_INVALID');
 return value;
}
export function createImagePreparationBrokerTransaction(pool:Pick<Pool,'connect'>){
 return async<T>(run:(db:PoolClient)=>Promise<T>):Promise<T>=>{
  const db=await pool.connect();let releaseError:Error|undefined;
  try{await db.query('BEGIN');const result=await run(db);await db.query('COMMIT');return result;}
  catch(error){try{await db.query('ROLLBACK');}catch{releaseError=Error('IMAGE_PREPARATION_BROKER_CONNECTION_UNCERTAIN');}throw error;}
  finally{db.release(releaseError);}
 };
}
export async function imagePreparationBrokerTransaction(){
 const connectionString=imagePreparationBrokerConfiguration(process.env.COATRIA_IMAGE_PREPARATION_BROKER_DATABASE_URL);
 if(state.coatriaImagePreparationBroker&&state.coatriaImagePreparationBroker.connectionString!==connectionString)throw Error('IMAGE_PREPARATION_BROKER_RESTART_REQUIRED');
 if(!state.coatriaImagePreparationBroker){
  const pool=new Pool({connectionString,max:2,idleTimeoutMillis:20000,connectionTimeoutMillis:5000,statement_timeout:10000});
  const ready=(async()=>{const db=await pool.connect();try{await assertImagePreparationBrokerDatabase(db);}finally{db.release();}})();
  state.coatriaImagePreparationBroker={connectionString,pool,ready};
 }
 await state.coatriaImagePreparationBroker.ready;
 return createImagePreparationBrokerTransaction(state.coatriaImagePreparationBroker.pool);
}
export async function imagePreparationServiceRequest(request:Request){
 const origin=preparationServiceOrigin.safeParse(process.env.APP_URL);
 if(!origin.success)return Response.json({error:'The preparation service is not configured.',code:'PREPARATION_SERVICE_UNAVAILABLE'},{status:503,headers:{'cache-control':'private, no-store','x-content-type-options':'nosniff'}});
 return createProjectImagePreparationServiceHttpHandler({origin:origin.data,execute:async(serviceId,token,operation,input,options)=>{
  const transaction=await imagePreparationBrokerTransaction();
  return createImagePreparationControlService({transaction}).execute(serviceId,token,operation,input,options);
 }})(request);
}
