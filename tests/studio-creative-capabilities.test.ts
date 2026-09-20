import test from 'node:test';
import assert from 'node:assert/strict';
import {readFile,readdir} from 'node:fs/promises';
import {randomUUID} from 'node:crypto';
import {PGlite} from '@electric-sql/pglite';
import {AGENT_CAPABILITIES} from '../src/lib/agent-policy';

test('creative capability migration permits explicit opt-in without rewriting existing agent or run snapshots', {timeout:120000},async()=>{
 const db=await PGlite.create();
 try{
  for(const file of(await readdir('database')).filter(file=>/^\d.*\.sql$/.test(file)&&Number(file.slice(0,3))<=23).sort())await db.exec(await readFile('database/'+file,'utf8'));
  const user=randomUUID(),company=randomUUID(),agent=randomUUID(),conversation=randomUUID(),run=randomUUID(),old=['workspace.read','studio.read','studio.write'];
  await db.query("INSERT INTO users(id,name,email,password_hash) VALUES($1,'Capability fixture','creative-capabilities@example.invalid','fixture')",[user]);
  await db.query("INSERT INTO companies(id,name,slug,template) VALUES($1,'Capability fixture','creative-capabilities','blank')",[company]);
  await db.query("INSERT INTO agents(id,company_id,name,harness,token_hash,created_by,capabilities) VALUES($1,$2,'Fixture','custom',$3,$4,$5)",[agent,company,'c'.repeat(64),user,JSON.stringify(old)]);
  await db.query('INSERT INTO conversations(id,company_id) VALUES($1,$2)',[conversation,company]);
  await db.query("INSERT INTO agent_runs(id,company_id,agent_id,requested_by,conversation_id,client_id,payload_hash,prompt,capabilities) VALUES($1,$2,$3,$4,$5,$6,$7,'Fixture',$8)",[run,company,agent,user,conversation,randomUUID(),'d'.repeat(64),JSON.stringify(old)]);
  const beforeAgent=(await db.query('SELECT * FROM agents WHERE id=$1',[agent])).rows,beforeRun=(await db.query('SELECT * FROM agent_runs WHERE id=$1',[run])).rows;
  await assert.rejects(db.query('UPDATE agents SET capabilities=$2 WHERE id=$1',[agent,JSON.stringify(['creative.read'])]),(error:any)=>error.code==='23514');
  await db.exec(await readFile('database/024_higgsfield_connections.sql','utf8'));
  assert.deepEqual((await db.query('SELECT * FROM agents WHERE id=$1',[agent])).rows,beforeAgent);
  assert.deepEqual((await db.query('SELECT * FROM agent_runs WHERE id=$1',[run])).rows,beforeRun);
  for(const capability of AGENT_CAPABILITIES.filter(capability=>!capability.startsWith('storage.')))await db.query('UPDATE agents SET capabilities=$2 WHERE id=$1',[agent,JSON.stringify([capability])]);
  await db.query('UPDATE agents SET capabilities=$2 WHERE id=$1',[agent,JSON.stringify(old)]);
  for(const capability of AGENT_CAPABILITIES.filter(capability=>capability.startsWith('storage.')))await assert.rejects(db.query('UPDATE agents SET capabilities=$2 WHERE id=$1',[agent,JSON.stringify([capability])]),(error:any)=>error.code==='23514');
  for(const file of(await readdir('database')).filter(file=>/^\d.*\.sql$/.test(file)&&Number(file.slice(0,3))>24).sort())await db.exec(await readFile('database/'+file,'utf8'));
  assert.deepEqual((await db.query('SELECT * FROM agents WHERE id=$1',[agent])).rows,beforeAgent);
  assert.deepEqual((await db.query('SELECT * FROM agent_runs WHERE id=$1',[run])).rows,beforeRun);
  for(const capability of AGENT_CAPABILITIES)await db.query('UPDATE agents SET capabilities=$2 WHERE id=$1',[agent,JSON.stringify([capability])]);
  await db.query('UPDATE agents SET capabilities=$2 WHERE id=$1',[agent,JSON.stringify(AGENT_CAPABILITIES)]);
  for(const forbidden of[['creative.admin'],['creative.write','provider.unbounded'],{creative:true},'creative.read',null])await assert.rejects(db.query('UPDATE agents SET capabilities=$2 WHERE id=$1',[agent,JSON.stringify(forbidden)]),(error:any)=>error.code==='23514');
  assert.deepEqual((await db.query('SELECT * FROM agent_runs WHERE id=$1',[run])).rows,beforeRun,'Administrator grant edits must not change an existing run snapshot');
 }finally{await db.close();}
});
