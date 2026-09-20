import test from 'node:test';
import assert from 'node:assert/strict';
import {randomBytes} from 'node:crypto';
import {GET} from '../src/app/api/internal/higgsfield-jobs/reconcile/route';

test('job cron requires its independent secret and explicit enablement before any database/provider work',async()=>{
 const previous={secret:process.env.CRON_SECRET,enabled:process.env.HIGGSFIELD_JOB_RECONCILER_ENABLED};
 const token=randomBytes(32).toString('base64url');
 const call=(authorization?:string)=>GET(new Request('https://coatria.com/api/internal/higgsfield-jobs/reconcile',{headers:authorization?{authorization}:{}}));
 try{
  delete process.env.CRON_SECRET;process.env.HIGGSFIELD_JOB_RECONCILER_ENABLED='1';assert.equal((await call('Bearer '+token)).status,401);
  process.env.CRON_SECRET=token;
  for(const value of [undefined,'Bearer wrong','coatria_session='+token,'Bearer '+'x'.repeat(4097)])assert.equal((await call(value)).status,401);
  process.env.HIGGSFIELD_JOB_RECONCILER_ENABLED='0';const disabled=await call('Bearer '+token);assert.equal(disabled.status,200);assert.deepEqual(await disabled.json(),{enabled:false,checked:0,providerGenerationsSubmitted:0});
 }finally{for(const[key,value]of [['CRON_SECRET',previous.secret],['HIGGSFIELD_JOB_RECONCILER_ENABLED',previous.enabled]]){if(value===undefined)delete process.env[key!];else process.env[key!]=value;}}
});
