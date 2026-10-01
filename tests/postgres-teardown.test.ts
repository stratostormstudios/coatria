import test from 'node:test';
import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import {Pool} from 'pg';
import {dropFixtureDatabase} from './fixtures/postgres-teardown';

const fixtureName=()=> 'coatria_teardown_'+randomUUID().replaceAll('-','');
test('fixture teardown waits for all owned database sessions and uses an ordinary drop',async()=>{
 const dbName=fixtureName(),counts=[2,1,0],queries:{text:string;values?:unknown[];query_timeout:number}[]=[];
 await dropFixtureDatabase({query:async config=>{
  queries.push(config);
  if(config.text.includes('current_database'))return {rows:[{name:'postgres'}]};
  if(config.text.includes('pg_stat_activity'))return {rows:[{sessions:counts.shift()}]};
  assert.equal(counts.length,0);return {rows:[]};
 }},dbName,{pollMs:1});
 assert.equal(queries.length,5);
 assert.deepEqual(queries.filter(q=>q.text.includes('pg_stat_activity')).map(q=>q.values),[[dbName],[dbName],[dbName]]);
 assert.equal(queries.at(-1)!.text,'DROP DATABASE '+dbName);
 assert(queries.every(q=>q.query_timeout>0&&q.query_timeout<=10000));
});

test('fixture teardown refuses foreign or control names, times out without dropping, and preserves query errors',async()=>{
 const dbName=fixtureName();let calls=0,drops=0;
 const control={query:async(config:{text:string})=>{calls++;if(config.text.startsWith('DROP'))drops++;return {rows:config.text.includes('current_database')?[{name:'postgres'}]:[{sessions:1}]};}};
 for(const name of ['postgres','production',dbName+';DROP DATABASE postgres',dbName.toUpperCase()])await assert.rejects(dropFixtureDatabase(control,name),/non-fixture database/);
 assert.equal(calls,0);
 await assert.rejects(dropFixtureDatabase({query:async()=>({rows:[{name:dbName}]})},dbName),/separate control database/);
 await assert.rejects(dropFixtureDatabase(control,dbName,{timeoutMs:20,pollMs:1}),/teardown deadline/);
 assert.equal(drops,0);assert(calls>1);
 const failure=new Error('Synthetic control query failure');
 await assert.rejects(dropFixtureDatabase({query:async()=>{throw failure;}},dbName),error=>error===failure);
});

const integration=process.env.COATRIA_INTEGRATION_DATABASE_URL;
const local=(()=>{try{return !!integration&&['localhost','127.0.0.1'].includes(new URL(integration).hostname);}catch{return false;}})();
test('real PostgreSQL teardown retains a live backend until its pool disconnects',{skip:!local,timeout:20000},async()=>{
 const dbName=fixtureName(),control=new Pool({connectionString:integration,max:1,connectionTimeoutMillis:5000});
 let app:Pool|undefined,created=false,dropped=false,pending:Promise<void>|undefined,observedResolve:(()=>void)|undefined;
 const observed=new Promise<void>(resolve=>{observedResolve=resolve;});
 try{
  await control.query('CREATE DATABASE '+dbName);created=true;
  const url=new URL(integration!);url.pathname='/'+dbName;
  app=new Pool({connectionString:url.href,max:1,connectionTimeoutMillis:5000});
  const backend=(await app.query('SELECT pg_backend_pid() AS pid')).rows[0].pid as number;
  const queries:string[]=[];
  pending=dropFixtureDatabase({query:async config=>{
   queries.push(config.text);const result=await control.query(config);
   if(config.text.includes('pg_stat_activity')&&result.rows[0]?.sessions>0)observedResolve!();
   if(config.text.startsWith('DROP DATABASE'))dropped=true;
   return result;
  }},dbName);
  // Observe a live backend through the helper, without leaving a rejected promise unhandled.
  await Promise.race([observed,pending.then(()=>{throw new Error('Database dropped before the held backend disconnected');})]);
  assert.equal(queries.some(sql=>sql.startsWith('DROP DATABASE')),false);
  assert.equal((await app.query('SELECT pg_backend_pid() AS pid')).rows[0].pid,backend);
  await app.end();app=undefined;
  await pending;
  assert.equal(dropped,true);
  assert.equal((await control.query('SELECT 1 FROM pg_database WHERE datname=$1',[dbName])).rowCount,0);
  assert.equal(queries.filter(sql=>sql.startsWith('DROP DATABASE')).length,1);
 }finally{
  try{await app?.end();}finally{
   try{await pending;}finally{
    try{if(created&&!dropped)await dropFixtureDatabase(control,dbName);}finally{await control.end();}
   }
  }
 }
});
