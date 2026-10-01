import test from 'node:test';
import assert from 'node:assert/strict';
import {readFile,readdir} from 'node:fs/promises';
import {randomBytes,randomUUID} from 'node:crypto';
import {spawn} from 'node:child_process';
import {createServer} from 'node:net';
import {setTimeout as delay} from 'node:timers/promises';
import {Pool} from 'pg';
import {assertProjectStorageGatewayDatabase,PROJECT_STORAGE_GATEWAY_ROLE} from '../src/lib/project-storage-preflight';

const integration=process.env.COATRIA_INTEGRATION_DATABASE_URL;
const localPostgres=(()=>{try{return !!integration&&['localhost','127.0.0.1'].includes(new URL(integration).hostname)&&process.env.COATRIA_TEST_EMULATOR!=='1';}catch{return false;}})();

// Only disposable localhost CI PostgreSQL. Real LOGINs, current migrations and
// shipped ACLs; no existing database, company rows, remote providers or secrets.
test('PostgreSQL gateway preflight requires the actual dedicated restricted LOGIN',{skip:!localPostgres,timeout:120000},async t=>{
 const suffix=randomUUID().replaceAll('-',''),dbName='coatria_gateway_preflight_'+suffix,role=PROJECT_STORAGE_GATEWAY_ROLE,appRole='gateway_api_'+suffix;
 const control=new Pool({connectionString:integration,max:1,connectionTimeoutMillis:10000}),ownerUrl=new URL(integration!);ownerUrl.pathname='/'+dbName;
 let created=false,owner:Pool|undefined,gateway:Pool|undefined,application:Pool|undefined,gatewayUrl:string|undefined;
 const createdRoles:string[]=[];
 async function change(sql:string,undo:string,code='STORAGE_DB_PRIVILEGES'){
  await owner!.query(sql);try{await assert.rejects(()=>assertProjectStorageGatewayDatabase(gateway!),{code});}finally{await owner!.query(undo);}assert.equal((await assertProjectStorageGatewayDatabase(gateway!)).status,'passed');
 }
 try{
  await control.query('CREATE DATABASE '+dbName);created=true;owner=new Pool({connectionString:ownerUrl.href,max:2,connectionTimeoutMillis:10000});
  await owner.query('CREATE TABLE schema_migrations(name text PRIMARY KEY,applied_at timestamptz NOT NULL DEFAULT now())');
  for(const file of(await readdir('database')).filter(file=>/^\d.*\.sql$/.test(file)).sort()){await owner.query(await readFile('database/'+file,'utf8'));await owner.query('INSERT INTO schema_migrations(name) VALUES($1)',[file]);}
  for(const [name,file]of [[role,'storage-gateway-permissions.sql'],[appRole,'runtime-permissions.sql']]){
   const password=randomBytes(32).toString('hex');await control.query(`CREATE ROLE ${name} LOGIN PASSWORD '${password}' NOINHERIT NOSUPERUSER NOCREATEDB NOCREATEROLE NOREPLICATION NOBYPASSRLS`);createdRoles.push(name);
   await owner.query((await readFile('database/'+file,'utf8')).replaceAll(name===role?role:'coatria_runtime_v1',name));
   const url=new URL(ownerUrl);url.username=name;url.password=password;const pool=new Pool({connectionString:url.href,max:1,connectionTimeoutMillis:10000});if(name===role){gateway=pool;gatewayUrl=url.href;}else application=pool;
   const identity=(await pool.query('SELECT current_user,session_user')).rows[0];assert.deepEqual(identity,{current_user:name,session_user:name});
  }
  await t.test('exact shipped gateway LOGIN passes while owner, application and owner SET ROLE fail',async()=>{
   const result=await assertProjectStorageGatewayDatabase(gateway!);assert.equal(result.status,'passed');assert.equal(result.role,role);assert.equal(result.checkedMigrations,37);assert.equal(result.migrationFloor,37);assert.equal(result.contractVersion,2);
   for(const pool of[owner!,application!])await assert.rejects(()=>assertProjectStorageGatewayDatabase(pool),{code:'STORAGE_DB_IDENTITY'});
   const client=await owner!.connect();try{await client.query('SET ROLE '+role);await assert.rejects(()=>assertProjectStorageGatewayDatabase(client),{code:'STORAGE_DB_IDENTITY'});}finally{await client.query('RESET ROLE');client.release();}
  });
  await t.test('missing, widened, PUBLIC and grant-option authority is rejected on real PostgreSQL',async()=>{
   for(const [sql,undo]of [
    [`REVOKE UPDATE(status) ON project_storage_uploads FROM ${role}`,`GRANT UPDATE(status) ON project_storage_uploads TO ${role}`],
    [`GRANT UPDATE(role) ON memberships TO ${role}`,`REVOKE UPDATE(role) ON memberships FROM ${role}`],
    [`GRANT SELECT(source_snapshot,claim_request_id) ON studio_generated_followups TO ${role}`,`REVOKE SELECT(source_snapshot,claim_request_id) ON studio_generated_followups FROM ${role}`],
    [`GRANT SELECT(sealed) ON higgsfield_output_locators TO ${role}`,`REVOKE SELECT(sealed) ON higgsfield_output_locators FROM ${role}`],
    ['GRANT SELECT ON sessions TO PUBLIC','REVOKE SELECT ON sessions FROM PUBLIC'],
    [`GRANT SELECT ON schema_migrations TO ${role} WITH GRANT OPTION`,`REVOKE GRANT OPTION FOR SELECT ON schema_migrations FROM ${role}`],
   ])await change(sql,undo);
   for(const attribute of['SUPERUSER','CREATEDB','CREATEROLE','REPLICATION','BYPASSRLS'])await change(`ALTER ROLE ${role} ${attribute}`,`ALTER ROLE ${role} NO${attribute}`,'STORAGE_DB_ROLE');
   await change(`GRANT ${appRole} TO ${role}`,`REVOKE ${appRole} FROM ${role}`,'STORAGE_DB_ROLE');
   await change(`GRANT CREATE ON SCHEMA public TO ${role}`,`REVOKE CREATE ON SCHEMA public FROM ${role}`,'STORAGE_DB_SCHEMA');
  });
  await t.test('unrelated sequence and SECURITY DEFINER access, ownership and missing schema ledger are denied',async()=>{
   await owner!.query('CREATE SEQUENCE gateway_preflight_extra');try{await change(`GRANT USAGE ON SEQUENCE gateway_preflight_extra TO ${role}`,`REVOKE USAGE ON SEQUENCE gateway_preflight_extra FROM ${role}`);}finally{await owner!.query('DROP SEQUENCE gateway_preflight_extra');}
   await owner!.query("CREATE FUNCTION gateway_preflight_definer() RETURNS integer LANGUAGE sql SECURITY DEFINER AS 'SELECT 1'");try{await assert.rejects(()=>assertProjectStorageGatewayDatabase(gateway!),{code:'STORAGE_DB_PRIVILEGES'});await owner!.query('REVOKE ALL ON FUNCTION gateway_preflight_definer() FROM PUBLIC');assert.equal((await assertProjectStorageGatewayDatabase(gateway!)).status,'passed');}finally{await owner!.query('DROP FUNCTION gateway_preflight_definer()');}
   await owner!.query(`CREATE TABLE gateway_owned_fixture(value integer); ALTER TABLE gateway_owned_fixture OWNER TO ${role}`);try{await assert.rejects(()=>assertProjectStorageGatewayDatabase(gateway!),{code:'STORAGE_DB_PRIVILEGES'});}finally{await owner!.query('DROP TABLE gateway_owned_fixture');}
   const last='037_project_gateway_bindings.sql';
   await owner!.query('DELETE FROM schema_migrations WHERE name=$1',[last]);try{await assert.rejects(()=>assertProjectStorageGatewayDatabase(gateway!),{code:'STORAGE_DB_MIGRATIONS'});}finally{await owner!.query('INSERT INTO schema_migrations(name) VALUES($1)',[last]);}
  });
  await t.test('actual CLI preflight passes with no HTTP listener, worker claim or provider work',{timeout:15000},async()=>{
   const occupied=createServer();await new Promise<void>(resolve=>occupied.listen(0,'127.0.0.1',resolve));
   try{
    const result=await new Promise<{code:number|null;stdout:string;stderr:string}>((resolve,reject)=>{
     const child=spawn(process.execPath,['--import','tsx','scripts/storage-gateway.ts','--preflight'],{cwd:process.cwd(),env:{...process.env,DATABASE_URL:gatewayUrl,HOST:'127.0.0.1',PORT:String((occupied.address() as {port:number}).port),APP_URL:'https://coatria.com',COATRIA_HOSTING_KEYRING:JSON.stringify({activeKeyId:'fixture',keys:{fixture:randomBytes(32).toString('base64')}})},stdio:['ignore','pipe','pipe'],windowsHide:true});
     let stdout='',stderr='';const timer=setTimeout(()=>{child.kill();reject(Error('Gateway preflight did not exit promptly'));},10000);child.stdout.on('data',data=>{stdout+=String(data);});child.stderr.on('data',data=>{stderr+=String(data);});child.on('error',error=>{clearTimeout(timer);reject(error);});child.on('close',code=>{clearTimeout(timer);resolve({code,stdout,stderr});});
    });
    assert.equal(result.code,0);assert.equal(result.stderr,'');const value=JSON.parse(result.stdout.trim());assert.equal(value.event,'storage-gateway-preflight-passed');assert.equal(value.database.role,role);assert.equal(value.listening,false);assert.equal(value.workClaimed,false);assert(!result.stdout.includes(gatewayUrl!));
    assert.deepEqual((await owner!.query('SELECT (SELECT count(*)::int FROM project_storage_uploads) AS uploads,(SELECT count(*)::int FROM project_storage_verifications) AS verifications')).rows[0],{uploads:0,verifications:0});
   }finally{await new Promise<void>((resolve,reject)=>occupied.close(error=>error?reject(error):resolve()));}
  });
 }finally{
  await Promise.all([gateway?.end(),application?.end(),owner?.end()]);
  if(created){const deadline=Date.now()+10000;while(Number((await control.query('SELECT count(*)::int n FROM pg_stat_activity WHERE datname=$1',[dbName])).rows[0].n)>0){if(Date.now()>deadline)throw Error('Disposable gateway preflight database did not drain');await delay(100);}await control.query('DROP DATABASE '+dbName);}
  for(const roleName of createdRoles.reverse())await control.query('DROP ROLE '+roleName);await control.end();
 }
});
