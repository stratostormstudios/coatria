import test from 'node:test';
import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import type {Pool,PoolClient} from 'pg';
import {createImagePreparationBrokerTransaction,imagePreparationBrokerConfiguration,imagePreparationServiceRequest} from '../src/lib/project-image-preparation-service-runtime';

test('broker configuration cannot fall back to ordinary or privileged application identities',()=>{
 assert.throws(()=>imagePreparationBrokerConfiguration(undefined));
 for(const username of ['postgres','coatria_runtime_v1','coatria_image_preparation_registrar_v1']){
  const url=new URL('postgresql://localhost/database');url.username=username;url.password='synthetic';assert.throws(()=>imagePreparationBrokerConfiguration(url.href));
 }
 const url=new URL('postgresql://localhost/database');url.username='coatria_image_preparation_broker_v1';url.password='synthetic';assert.equal(imagePreparationBrokerConfiguration(url.href),url.href);
});

test('unknown commit is surfaced once and an unconfirmed rollback destroys the connection',async()=>{
 const calls:string[]=[],failure=Error('synthetic lost commit');let runs=0,released:Error|undefined;
 const pool={async connect(){return {async query(sql:string){calls.push(sql);if(sql==='COMMIT'||sql==='ROLLBACK')throw failure;return {rows:[]};},release(error?:Error){released=error;}} as unknown as PoolClient;}} as Pick<Pool,'connect'>;
 await assert.rejects(createImagePreparationBrokerTransaction(pool)(async()=>{runs++;return 'value';}),error=>error===failure);
 assert.equal(runs,1);assert.deepEqual(calls,['BEGIN','COMMIT','ROLLBACK']);assert(released);
});

test('route composition fails closed without the dedicated broker and hides environment values',async()=>{
 const previous={url:process.env.APP_URL,broker:process.env.COATRIA_IMAGE_PREPARATION_BROKER_DATABASE_URL};
 try{
  process.env.APP_URL='https://coatria.com';delete process.env.COATRIA_IMAGE_PREPARATION_BROKER_DATABASE_URL;
  const request=new Request('https://coatria.com/api/internal/image-preparation-services/'+randomUUID()+'/readiness',{method:'POST',headers:{authorization:'Bearer ips_'+'x'.repeat(43),accept:'application/json','content-type':'application/json'},body:JSON.stringify({requestId:randomUUID(),deadlineAt:new Date(Date.now()+5000).toISOString()})});
  const result=await imagePreparationServiceRequest(request);assert.equal(result.status,503);assert.doesNotMatch(await result.text(),/DATABASE_URL|postgres|ips_/);
 }finally{if(previous.url===undefined)delete process.env.APP_URL;else process.env.APP_URL=previous.url;if(previous.broker===undefined)delete process.env.COATRIA_IMAGE_PREPARATION_BROKER_DATABASE_URL;else process.env.COATRIA_IMAGE_PREPARATION_BROKER_DATABASE_URL=previous.broker;}
});
