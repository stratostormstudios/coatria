import test from 'node:test';
import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import {readFile} from 'node:fs/promises';
import {Pool} from 'pg';

const url=process.env.COATRIA_INTEGRATION_DATABASE_URL;
const local=Boolean(url&&['localhost','127.0.0.1'].includes(new URL(url).hostname));
test('runtime role supports accounts but cannot change verification, schema, roles or migrations',{skip:!local||process.env.COATRIA_TEST_EMULATOR==='1'},async()=>{
  const pool=new Pool({connectionString:url,max:1}),client=await pool.connect();
  const role='coatria_privilege_test_'+randomUUID().replaceAll('-','');
  try{
    await client.query('BEGIN');
    await client.query(`CREATE ROLE ${role} NOLOGIN NOINHERIT NOSUPERUSER NOCREATEDB NOCREATEROLE NOBYPASSRLS`);
    await client.query((await readFile('database/runtime-permissions.sql','utf8')).replaceAll('coatria_runtime_v1',role));
    await client.query(`SET LOCAL ROLE ${role}`);
    const user=(await client.query("INSERT INTO users(name,email,password_hash) VALUES('Privilege test',$1,'test only') RETURNING id",[role+'@example.invalid'])).rows[0];
    await client.query('SELECT id FROM users WHERE id=$1 FOR UPDATE',[user.id]);
    await client.query('SELECT id FROM users WHERE id=$1 FOR SHARE',[user.id]);
    await client.query("UPDATE users SET name='Updated test',password_hash='replacement test only' WHERE id=$1",[user.id]);
    await client.query('SELECT name FROM schema_migrations');
    const options=(await client.query('SELECT rolcreaterole,rolcreatedb,rolbypassrls FROM pg_roles WHERE rolname=current_user')).rows[0];
    assert.deepEqual(options,{rolcreaterole:false,rolcreatedb:false,rolbypassrls:false});
    for(const [sql,values] of [
      ['UPDATE users SET email_verified_at=now() WHERE id=$1',[user.id]],
      ["INSERT INTO users(name,email,password_hash,email_verified_at) VALUES('Forbidden','forbidden@example.invalid','test',now())",[]],
      ['CREATE TABLE public.unauthorized_test(id int)',[]],
      ['TRUNCATE users CASCADE',[]],
      ["UPDATE schema_migrations SET applied_at=now()",[]],
      [`CREATE ROLE ${role}_escalated NOLOGIN`,[]]
    ] as Array<[string,unknown[]]>){
      await client.query('SAVEPOINT denied_operation');
      await assert.rejects(()=>client.query(sql,values),{code:'42501'});
      await client.query('ROLLBACK TO SAVEPOINT denied_operation');
    }
  }finally{await client.query('ROLLBACK');client.release();await pool.end();}
});
