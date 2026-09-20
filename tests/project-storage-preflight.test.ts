import test from 'node:test';
import assert from 'node:assert/strict';
import {readFile,readdir} from 'node:fs/promises';
import {randomBytes} from 'node:crypto';
import {spawn} from 'node:child_process';
import {createServer} from 'node:net';
import {assertProjectStorageGatewayDatabase,PROJECT_STORAGE_GATEWAY_ROLE} from '../src/lib/project-storage-preflight';

test('gateway preflight suppresses raw database diagnostics',async()=>{
 await assert.rejects(()=>assertProjectStorageGatewayDatabase({query:async()=>{throw Error('private connection fixture-secret');}}),error=>error instanceof Error&&error.message==='STORAGE_DB_CHECK_FAILED'&&!JSON.stringify(error).includes('secret'));
});

// Actual migration and permission SQL, but synthetic SET SESSION AUTHORIZATION.
// The separate PostgreSQL test proves a real password-authenticated LOGIN.
test('gateway startup audits the shipped effective permissions without changing state',{timeout:120000},async t=>{
 const {PGlite}=await import('@electric-sql/pglite'),pg=await PGlite.create(),role=PROJECT_STORAGE_GATEWAY_ROLE,queries:string[]=[];
 const db={query:async(sql:string,values?:unknown[])=>{queries.push(sql);return pg.query<Record<string,unknown>>(sql,values);}};
 const asGateway=async<T>(fn:()=>Promise<T>)=>{await pg.exec('SET SESSION AUTHORIZATION '+role);try{return await fn();}finally{await pg.exec('SET SESSION AUTHORIZATION postgres');}};
 const change=async(sql:string,undo:string,code='STORAGE_DB_PRIVILEGES')=>{await pg.exec(sql);try{await assert.rejects(()=>asGateway(()=>assertProjectStorageGatewayDatabase(db)),{code});}finally{await pg.exec(undo);}assert.equal((await asGateway(()=>assertProjectStorageGatewayDatabase(db))).status,'passed');};
 try{
  await pg.exec('CREATE TABLE schema_migrations(name text PRIMARY KEY,applied_at timestamptz NOT NULL DEFAULT now())');
  for(const file of(await readdir('database')).filter(file=>/^\d.*\.sql$/.test(file)).sort()){await pg.exec(await readFile('database/'+file,'utf8'));await pg.query('INSERT INTO schema_migrations(name) VALUES($1)',[file]);}
  await pg.exec(`CREATE ROLE ${role} LOGIN NOINHERIT NOSUPERUSER NOCREATEDB NOCREATEROLE NOREPLICATION NOBYPASSRLS`);
  await pg.exec(await readFile('database/storage-gateway-permissions.sql','utf8'));
  await t.test('current contract passes, including exact limited source-classification columns, using SELECT only',async()=>{
   const result=await asGateway(()=>assertProjectStorageGatewayDatabase(db));assert.equal(result.status,'passed');assert.equal(result.role,role);assert.equal(result.checkedMigrations,34);assert.equal(result.checkedMigrations,result.migrationFloor);assert(queries.length>0&&queries.every(sql=>sql.trim().startsWith('SELECT')));
  });
  await t.test('owner and SET ROLE impersonation are rejected',async()=>{
   await assert.rejects(()=>assertProjectStorageGatewayDatabase(db),{code:'STORAGE_DB_IDENTITY'});
   await pg.exec('SET ROLE '+role);try{await assert.rejects(()=>assertProjectStorageGatewayDatabase(db),{code:'STORAGE_DB_IDENTITY'});}finally{await pg.exec('SET ROLE NONE');}
  });
  await t.test('missing grants, widened columns and grant options are rejected',async()=>{
   await change(`REVOKE UPDATE(status) ON project_storage_uploads FROM ${role}`,`GRANT UPDATE(status) ON project_storage_uploads TO ${role}`);
   await change(`GRANT UPDATE(role) ON memberships TO ${role}`,`REVOKE UPDATE(role) ON memberships FROM ${role}`);
   await change(`GRANT SELECT(source_snapshot) ON studio_generated_followups TO ${role}`,`REVOKE SELECT(source_snapshot) ON studio_generated_followups FROM ${role}`);
   await change(`GRANT SELECT(sealed) ON higgsfield_output_locators TO ${role}`,`REVOKE SELECT(sealed) ON higgsfield_output_locators FROM ${role}`);
   await change(`GRANT SELECT ON schema_migrations TO ${role} WITH GRANT OPTION`,`REVOKE GRANT OPTION FOR SELECT ON schema_migrations FROM ${role}`);
  });
  await t.test('PUBLIC access and unrelated sequences or executable definer functions are rejected',async()=>{
   await change('GRANT SELECT ON sessions TO PUBLIC','REVOKE SELECT ON sessions FROM PUBLIC');
   await pg.exec('CREATE SEQUENCE gateway_extra');try{await change(`GRANT USAGE ON SEQUENCE gateway_extra TO ${role}`,`REVOKE USAGE ON SEQUENCE gateway_extra FROM ${role}`);}finally{await pg.exec('DROP SEQUENCE gateway_extra');}
   await pg.exec("CREATE FUNCTION gateway_definer() RETURNS integer LANGUAGE sql SECURITY DEFINER AS 'SELECT 1'");try{await assert.rejects(()=>asGateway(()=>assertProjectStorageGatewayDatabase(db)),{code:'STORAGE_DB_PRIVILEGES'});await pg.exec('REVOKE ALL ON FUNCTION gateway_definer() FROM PUBLIC');assert.equal((await asGateway(()=>assertProjectStorageGatewayDatabase(db))).status,'passed');}finally{await pg.exec('DROP FUNCTION gateway_definer()');}
  });
  await t.test('elevated role attributes, membership and writable schemas are rejected',async()=>{
   for(const attr of['SUPERUSER','CREATEDB','CREATEROLE','REPLICATION','BYPASSRLS'])await change(`ALTER ROLE ${role} ${attr}`,`ALTER ROLE ${role} NO${attr}`,'STORAGE_DB_ROLE');
   await pg.exec('CREATE ROLE gateway_escape NOLOGIN');try{await change(`GRANT gateway_escape TO ${role}`,`REVOKE gateway_escape FROM ${role}`,'STORAGE_DB_ROLE');}finally{await pg.exec('DROP ROLE gateway_escape');}
   await change(`GRANT CREATE ON SCHEMA public TO ${role}`,`REVOKE CREATE ON SCHEMA public FROM ${role}`,'STORAGE_DB_SCHEMA');
   await pg.exec('CREATE SCHEMA gateway_extra; CREATE TABLE gateway_extra.private_data(value text)');try{await change(`GRANT SELECT(value) ON gateway_extra.private_data TO ${role}`,`REVOKE SELECT(value) ON gateway_extra.private_data FROM ${role}`);}finally{await pg.exec('DROP SCHEMA gateway_extra CASCADE');}
  });
  await t.test('missing ledger entries fail despite the tables remaining present',async()=>{
   for(const name of['001_initial.sql','027_project_storage.sql','032_studio_generated_client_delivery.sql','033_studio_generated_revisions.sql','034_studio_coordinator_generation.sql']){await pg.query('DELETE FROM schema_migrations WHERE name=$1',[name]);try{await assert.rejects(()=>asGateway(()=>assertProjectStorageGatewayDatabase(db)),{code:'STORAGE_DB_MIGRATIONS'});}finally{await pg.query('INSERT INTO schema_migrations(name) VALUES($1)',[name]);}}
  });
  await t.test('normal startup and --preflight deny owner credentials before HTTP or queue startup and close the pool',{timeout:25000},async()=>{
   const {PGLiteSocketServer}=await import('@electric-sql/pglite-socket'),dbServer=new PGLiteSocketServer({db:pg,host:'127.0.0.1',port:0,maxConnections:1}),occupied=createServer();await dbServer.start();await new Promise<void>(resolve=>occupied.listen(0,'127.0.0.1',resolve));
   try{for(const args of[[],['--preflight']]){
    const result=await new Promise<{code:number|null;stdout:string;stderr:string}>((resolve,reject)=>{
     const child=spawn(process.execPath,['--import','tsx','scripts/storage-gateway.ts',...args],{cwd:process.cwd(),env:{...process.env,DATABASE_URL:`postgresql://postgres:postgres@${dbServer.getServerConn()}/postgres`,HOST:'127.0.0.1',PORT:String((occupied.address() as {port:number}).port),APP_URL:'https://coatria.com',COATRIA_HOSTING_KEYRING:JSON.stringify({activeKeyId:'fixture',keys:{fixture:randomBytes(32).toString('base64')}})},stdio:['ignore','pipe','pipe'],windowsHide:true});
     let stdout='',stderr='';const timer=setTimeout(()=>{child.kill();reject(Error('Gateway preflight failed to exit and close its pool'));},10000);child.stdout.on('data',data=>{stdout+=String(data);});child.stderr.on('data',data=>{stderr+=String(data);});child.on('error',error=>{clearTimeout(timer);reject(error);});child.on('close',code=>{clearTimeout(timer);resolve({code,stdout,stderr});});
    });
    assert.equal(result.code,1);assert.equal(result.stdout,'');assert.deepEqual(JSON.parse(result.stderr.trim()),{event:'storage-gateway-startup-failed',code:'STORAGE_DB_IDENTITY'});
   }
   assert.deepEqual((await pg.query('SELECT (SELECT count(*)::int FROM project_storage_uploads) AS uploads,(SELECT count(*)::int FROM project_storage_verifications) AS verifications')).rows[0],{uploads:0,verifications:0});
   }finally{await new Promise<void>((resolve,reject)=>occupied.close(error=>error?reject(error):resolve()));await dbServer.stop();}
  });
 }finally{await pg.close();}
});
