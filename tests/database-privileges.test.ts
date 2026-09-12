import test from 'node:test';
import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import {readFile} from 'node:fs/promises';
import {Pool} from 'pg';

const url=process.env.COATRIA_INTEGRATION_DATABASE_URL;
const local=Boolean(url&&['localhost','127.0.0.1'].includes(new URL(url).hostname));
test('runtime role supports accounts and durable conversations without verification, schema or role privileges',{skip:!local||process.env.COATRIA_TEST_EMULATOR==='1'},async()=>{
  const pool=new Pool({connectionString:url,max:1}),client=await pool.connect();
  const role='coatria_privilege_test_'+randomUUID().replaceAll('-','');
  try{
    await client.query('BEGIN');
    await client.query(`CREATE ROLE ${role} NOLOGIN NOINHERIT NOSUPERUSER NOCREATEDB NOCREATEROLE NOBYPASSRLS`);
    await client.query((await readFile('database/runtime-permissions.sql','utf8')).replaceAll('coatria_runtime_v1',role));
    await client.query(`SET LOCAL ROLE ${role}`);
    const user=(await client.query("INSERT INTO users(name,email,password_hash,avatar_id) VALUES('Privilege test',$1,'test only','city-023') RETURNING id,avatar_id",[role+'@example.invalid'])).rows[0];
    assert.equal(user.avatar_id,'city-023');
    await client.query('SELECT id FROM users WHERE id=$1 FOR UPDATE',[user.id]);
    await client.query('SELECT id FROM users WHERE id=$1 FOR SHARE',[user.id]);
    await client.query("UPDATE users SET name='Updated test',password_hash='replacement test only',avatar_id='city-024' WHERE id=$1",[user.id]);
    assert.equal((await client.query('SELECT avatar_id FROM users WHERE id=$1',[user.id])).rows[0].avatar_id,'city-024');
    await client.query('SELECT name FROM schema_migrations');
    const company=(await client.query("INSERT INTO companies(name,slug,template) VALUES('Privilege fixture',$1,'blank') RETURNING id",[role])).rows[0];
    await client.query("INSERT INTO presence(company_id,user_id,status,motion_mode,interaction_id,interaction_type,interaction_value,interaction_at) VALUES($1,$2,'available','run',gen_random_uuid(),'reaction','heart',clock_timestamp())",[company.id,user.id]);
    await client.query("UPDATE presence SET state_updated_at=clock_timestamp(),motion_mode='walk' WHERE company_id=$1 AND user_id=$2",[company.id,user.id]);
    assert.equal((await client.query('SELECT motion_mode,interaction_value FROM presence WHERE company_id=$1 AND user_id=$2',[company.id,user.id])).rows[0].interaction_value,'heart');
    // Exercise the previous deployment's INSERT while actually assuming the
    // restricted role. Its invoker trigger must create a stream and an event.
    const legacy=(await client.query("INSERT INTO messages(company_id,user_id,body) VALUES($1,$2,'Legacy writer') RETURNING id,conversation_id,sequence,last_event_sequence",[company.id,user.id])).rows[0];
    assert.equal(legacy.sequence,'1');
    assert.equal(legacy.last_event_sequence,'1');
    const legacyEvent=(await client.query('SELECT message_id,sequence FROM conversation_events WHERE conversation_id=$1',[legacy.conversation_id])).rows[0];
    assert.deepEqual(legacyEvent,{message_id:legacy.id,sequence:'1'});
    // ROLLBACK alone would not run the deferred legacy-event FK validation.
    await client.query('SET CONSTRAINTS ALL IMMEDIATE');
    assert.equal((await client.query("SELECT prosecdef FROM pg_proc WHERE oid='public.coatria_legacy_message_insert()'::regprocedure")).rows[0].prosecdef,false);
    await client.query('SELECT id FROM conversations WHERE id=$1 FOR SHARE',[legacy.conversation_id]);
    await client.query('SELECT id FROM conversations WHERE id=$1 FOR UPDATE',[legacy.conversation_id]);
    const next=(await client.query('UPDATE conversations SET last_sequence=last_sequence+1 WHERE id=$1 RETURNING last_sequence',[legacy.conversation_id])).rows[0].last_sequence;
    assert.equal(next,'2');
    const clientId=randomUUID();
    const modern=(await client.query("INSERT INTO messages(company_id,user_id,conversation_id,sequence,last_event_sequence,client_id,body) VALUES($1,$2,$3,$4,$4,$5,'Durable writer') RETURNING id",[company.id,user.id,legacy.conversation_id,next,clientId])).rows[0];
    await client.query("INSERT INTO conversation_events(company_id,conversation_id,sequence,kind,message_id,actor_kind,actor_id) VALUES($1,$2,$3,'message.created',$4,'human',$5)",[company.id,legacy.conversation_id,next,modern.id,user.id]);
    await client.query("INSERT INTO conversation_requests(company_id,actor_kind,actor_id,client_id,payload_hash,conversation_id,message_id) VALUES($1,'human',$2,$3,$4,$5,$6)",[company.id,user.id,clientId,'0'.repeat(64),legacy.conversation_id,modern.id]);
    assert.equal((await client.query('SELECT message_id FROM conversation_requests WHERE company_id=$1 AND client_id=$2',[company.id,clientId])).rows[0].message_id,modern.id);
    await client.query("INSERT INTO conversation_reads(company_id,conversation_id,actor_kind,actor_id,sequence) VALUES($1,$2,'human',$3,1)",[company.id,legacy.conversation_id,user.id]);
    await client.query("UPDATE conversation_reads SET sequence=$4,updated_at=clock_timestamp() WHERE company_id=$1 AND conversation_id=$2 AND actor_kind='human' AND actor_id=$3",[company.id,legacy.conversation_id,user.id,next]);
    assert.equal((await client.query('SELECT sequence FROM conversation_reads WHERE conversation_id=$1 AND actor_id=$2',[legacy.conversation_id,user.id])).rows[0].sequence,'2');
    await client.query("INSERT INTO message_reactions(company_id,conversation_id,message_id,actor_kind,actor_id,emoji) VALUES($1,$2,$3,'human',$4,'heart')",[company.id,legacy.conversation_id,modern.id,user.id]);
    assert.equal((await client.query('SELECT emoji FROM message_reactions WHERE message_id=$1',[modern.id])).rows[0].emoji,'heart');
    assert.equal((await client.query('DELETE FROM message_reactions WHERE message_id=$1 AND actor_id=$2',[modern.id,user.id])).rowCount,1);
    assert.equal((await client.query('SELECT count(*)::int AS count FROM conversation_events WHERE conversation_id=$1',[legacy.conversation_id])).rows[0].count,2);
    // A restricted deployment must support all durable worker records while
    // retaining default-deny invocation grants on existing/new credentials.
    const agent=(await client.query("INSERT INTO agents(company_id,name,harness,created_by,token_hash) VALUES($1,'Runtime agent','custom',$2,$3) RETURNING id,invocation_access,capabilities,expires_at",[company.id,user.id,randomUUID()])).rows[0];
    assert.equal(agent.invocation_access,'none');assert.deepEqual(agent.capabilities,[]);assert(agent.expires_at);
    await client.query("UPDATE agents SET invocation_access='members',capabilities='[\"workspace.read\"]' WHERE id=$1",[agent.id]);
    const run=(await client.query("INSERT INTO agent_runs(company_id,agent_id,requested_by,conversation_id,client_id,payload_hash,prompt) VALUES($1,$2,$3,$4,$5,$6,'Runtime request') RETURNING id",[company.id,agent.id,user.id,legacy.conversation_id,randomUUID(),'0'.repeat(64)])).rows[0];
    await client.query('SELECT id FROM agent_runs WHERE id=$1 FOR UPDATE',[run.id]);
    await client.query("UPDATE agent_runs SET status='running',attempts=1,worker_id='runtime-worker',lease_token_hash=$2,lease_expires_at=clock_timestamp()+interval '60 seconds',started_at=clock_timestamp() WHERE id=$1",[run.id,'0'.repeat(64)]);
    await client.query("INSERT INTO agent_run_claims(company_id,agent_id,claim_id,worker_id,run_id,attempt) VALUES($1,$2,$3,'runtime-worker',$4,1)",[company.id,agent.id,randomUUID(),run.id]);
    await client.query("INSERT INTO agent_run_receipts(company_id,run_id,client_id,kind,payload_hash,lease_token_hash,response) VALUES($1,$2,$3,'complete',$4,$4,'{}')",[company.id,run.id,randomUUID(),'0'.repeat(64)]);
    await client.query("INSERT INTO agent_tool_receipts(company_id,agent_id,run_id,request_id,tool,request_hash,response) VALUES($1,$2,$3,$4,'office_presence',$5,'{}')",[company.id,agent.id,run.id,randomUUID(),'0'.repeat(64)]);
    await client.query("INSERT INTO agent_proposals(company_id,agent_id,run_id,requested_by,kind,data) VALUES($1,$2,$3,$4,'room','{}')",[company.id,agent.id,run.id,user.id]);
    await client.query("INSERT INTO agent_presence(company_id,agent_id,x,z,status) VALUES($1,$2,0,0,'available')",[company.id,agent.id]);
    for(const table of['agent_runs','agent_run_claims','agent_run_receipts','agent_tool_receipts','agent_proposals','agent_presence'])assert.equal((await client.query(`SELECT count(*)::int AS count FROM ${table} WHERE company_id=$1`,[company.id])).rows[0].count,1);
    const options=(await client.query('SELECT rolcreaterole,rolcreatedb,rolbypassrls FROM pg_roles WHERE rolname=current_user')).rows[0];
    assert.deepEqual(options,{rolcreaterole:false,rolcreatedb:false,rolbypassrls:false});
    for(const [sql,values] of [
      ['UPDATE users SET email_verified_at=now() WHERE id=$1',[user.id]],
      ["INSERT INTO users(name,email,password_hash,email_verified_at) VALUES('Forbidden','forbidden@example.invalid','test',now())",[]],
      ['CREATE TABLE public.unauthorized_test(id int)',[]],
      ['TRUNCATE users CASCADE',[]],
      ['TRUNCATE conversation_events',[]],
      ['TRUNCATE agent_run_receipts',[]],
      ['ALTER TABLE agent_runs DISABLE TRIGGER ALL',[]],
      ['ALTER FUNCTION public.coatria_legacy_message_insert() SECURITY DEFINER',[]],
      ["UPDATE schema_migrations SET applied_at=now()",[]],
      [`CREATE ROLE ${role}_escalated NOLOGIN`,[]]
    ] as Array<[string,unknown[]]>){
      await client.query('SAVEPOINT denied_operation');
      await assert.rejects(()=>client.query(sql,values),{code:'42501'});
      await client.query('ROLLBACK TO SAVEPOINT denied_operation');
    }
  }finally{await client.query('ROLLBACK');client.release();await pool.end();}
});
