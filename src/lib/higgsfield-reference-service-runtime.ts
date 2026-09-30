/** Server-only composition. The ordinary application pool never gains worker
 * privileges. No service is enrolled, qualified or started by configuration. */
import {Pool} from 'pg';
import {createHiggsfieldReferenceService} from './higgsfield-reference-service';
import {createHiggsfieldReferenceTransaction} from './higgsfield-reference-transaction';
import {assertHiggsfieldReferenceDatabase,HIGGSFIELD_REFERENCE_BROKER_ROLE} from './higgsfield-reference-database.mjs';
import {errorResponse,fail} from './security';
const state=globalThis as unknown as {coatriaReferenceBroker?:{connectionString:string;pool:Pool;ready:Promise<void>}};
export async function referenceBrokerTransaction(){
  const connectionString=process.env.COATRIA_REFERENCE_BROKER_DATABASE_URL;
  if(!connectionString)fail(503,'The reference broker is not configured.','REFERENCE_SERVICE_UNAVAILABLE');
  let url:URL;try{url=new URL(connectionString);}catch{fail(503,'The reference broker configuration is invalid.','REFERENCE_SERVICE_UNAVAILABLE');}
  if(!['postgres:','postgresql:'].includes(url.protocol)||decodeURIComponent(url.username)!==HIGGSFIELD_REFERENCE_BROKER_ROLE)fail(503,'The reference broker requires its dedicated database identity.','REFERENCE_SERVICE_UNAVAILABLE');
  if(state.coatriaReferenceBroker&&state.coatriaReferenceBroker.connectionString!==connectionString)fail(503,'Restart the service after changing its database configuration.','REFERENCE_SERVICE_UNAVAILABLE');
  if(!state.coatriaReferenceBroker){
   const pool=new Pool({connectionString,max:2,idleTimeoutMillis:20000,connectionTimeoutMillis:5000,statement_timeout:10000});
   const ready=(async()=>{const db=await pool.connect();try{await assertHiggsfieldReferenceDatabase(db);}finally{db.release();}})();
   state.coatriaReferenceBroker={connectionString,pool,ready};
  }
  await state.coatriaReferenceBroker.ready;
  return createHiggsfieldReferenceTransaction(state.coatriaReferenceBroker.pool);
}
export async function referenceServiceRequest(request:Request,serviceId:string,operation:string){
 try{
  const transaction=await referenceBrokerTransaction();
  return createHiggsfieldReferenceService({transaction})(request,serviceId,operation);
 }catch(error){return errorResponse(error);}
}
