import test from 'node:test';
import assert from 'node:assert/strict';
import {readFile,readdir,mkdtemp,mkdir,writeFile,chmod,realpath,rm,symlink} from 'node:fs/promises';
import {randomBytes} from 'node:crypto';
import {spawn} from 'node:child_process';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {assertHiggsfieldArchiveDatabase,assertHiggsfieldArchiveScratchRoot,HIGGSFIELD_ARCHIVE_WORKER_ROLE} from '../src/lib/higgsfield-archive-preflight';

test('archive preflight returns safe errors without exposing database diagnostics',async()=>{
 await assert.rejects(()=>assertHiggsfieldArchiveDatabase({query:async()=>{throw Error('private database diagnostic: fixture-secret-value');}}),error=>error instanceof Error&&error.message==='ARCHIVE_DB_CHECK_FAILED'&&!JSON.stringify(error).includes('secret'));
});

test('scratch preflight requires a private accessible service-owned directory without creating files',async t=>{
 const root=await mkdtemp(join(tmpdir(),'archive-preflight-')),scratch=join(root,'scratch');
 try{
  await mkdir(scratch,{mode:0o700});assert.equal(await assertHiggsfieldArchiveScratchRoot(scratch),await realpath(scratch));assert.deepEqual(await readdir(scratch),[]);
  await writeFile(join(root,'file'),'fixture');for(const path of['relative',join(root,'missing'),join(root,'file')])await assert.rejects(()=>assertHiggsfieldArchiveScratchRoot(path),{code:'ARCHIVE_SCRATCH_INVALID'});
  await t.test('Unix mode, root ownership and symlink checks',{skip:process.platform==='win32'},async()=>{
   await chmod(scratch,0o755);await assert.rejects(()=>assertHiggsfieldArchiveScratchRoot(scratch),{code:'ARCHIVE_SCRATCH_INVALID'});await chmod(scratch,0o700);
   await symlink(scratch,join(root,'alias'));await assert.rejects(()=>assertHiggsfieldArchiveScratchRoot(join(root,'alias')),{code:'ARCHIVE_SCRATCH_INVALID'});
   if(process.getuid?.()!==0)await assert.rejects(()=>assertHiggsfieldArchiveScratchRoot('/root'),{code:'ARCHIVE_SCRATCH_INVALID'});
  });
 }finally{await rm(root,{recursive:true,force:true});}
});

// Emulation checks the effective grant matrix against the real migration and
// permissions SQL. Session authorization here is synthetic, not LOGIN proof;
// the PostgreSQL archive lane separately uses a real authenticated connection.
test('archive preflight audits the complete migrated ACL contract without claiming work',{timeout:90000},async t=>{
 const {PGlite}=await import('@electric-sql/pglite'),pg=await PGlite.create(),role=HIGGSFIELD_ARCHIVE_WORKER_ROLE;
 const queries:string[]=[];
 const db={query:async(sql:string,values?:unknown[])=>{queries.push(sql);return pg.query<Record<string,unknown>>(sql,values);}};
 const asWorker=async<T>(fn:()=>Promise<T>)=>{await pg.exec('SET SESSION AUTHORIZATION '+role);try{return await fn();}finally{await pg.exec('SET SESSION AUTHORIZATION postgres');}};
 try{
  await pg.exec('CREATE TABLE schema_migrations(name text PRIMARY KEY,applied_at timestamptz NOT NULL DEFAULT now())');
  const files=(await readdir('database')).filter(file=>/^\d.*\.sql$/.test(file)).sort();
  for(const file of files){await pg.exec(await readFile('database/'+file,'utf8'));await pg.query('INSERT INTO schema_migrations(name) VALUES($1)',[file]);}
  await pg.exec('CREATE ROLE '+role+' LOGIN NOINHERIT NOSUPERUSER NOCREATEDB NOCREATEROLE NOREPLICATION NOBYPASSRLS');
  const grants=await readFile('database/higgsfield-archive-worker-permissions.sql','utf8');await pg.exec(grants);
  await t.test('exact shipped grants pass and every preflight statement is SELECT',async()=>{
   const result=await asWorker(()=>assertHiggsfieldArchiveDatabase(db));assert.equal(result.status,'passed');assert.equal(result.checkedMigrations,29);assert.equal(result.role,role);
   assert(queries.length>0);assert(queries.every(sql=>sql.trim().startsWith('SELECT')));
  });
  await t.test('SET ROLE from another session identity cannot impersonate a service LOGIN',async()=>{
   await pg.exec('SET ROLE '+role);try{await assert.rejects(()=>assertHiggsfieldArchiveDatabase(db),{code:'ARCHIVE_DB_IDENTITY'});}finally{await pg.exec('SET ROLE NONE');}
  });
  await t.test('missing or widened authority is denied, including PUBLIC and grant options',async()=>{
   for(const sql of[`REVOKE UPDATE(status) ON project_storage_uploads FROM ${role}`,`GRANT SELECT(sealed) ON higgsfield_connections TO ${role}`,`GRANT UPDATE(approved_by) ON higgsfield_output_archives TO ${role}`,`GRANT SELECT(id) ON users TO ${role}`,`GRANT SELECT ON schema_migrations TO ${role} WITH GRANT OPTION`]){
    await pg.exec(sql);try{await assert.rejects(()=>asWorker(()=>assertHiggsfieldArchiveDatabase(db)),{code:'ARCHIVE_DB_PRIVILEGES'});}finally{await pg.exec(grants);}
   }
   await pg.exec('GRANT SELECT ON sessions TO PUBLIC');try{await assert.rejects(()=>asWorker(()=>assertHiggsfieldArchiveDatabase(db)),{code:'ARCHIVE_DB_PRIVILEGES'});}finally{await pg.exec('REVOKE SELECT ON sessions FROM PUBLIC');}
  });
  await t.test('elevated attributes, role escape and writable schemas are denied',async()=>{
   for(const attribute of ['SUPERUSER','CREATEDB','CREATEROLE','REPLICATION','BYPASSRLS']){
    await pg.exec(`ALTER ROLE ${role} ${attribute}`);try{await assert.rejects(()=>asWorker(()=>assertHiggsfieldArchiveDatabase(db)),{code:'ARCHIVE_DB_ROLE'});}finally{await pg.exec(`ALTER ROLE ${role} NO${attribute}`);}
   }
   await pg.exec('CREATE ROLE archive_escape NOLOGIN');await pg.exec(`GRANT archive_escape TO ${role}`);try{await assert.rejects(()=>asWorker(()=>assertHiggsfieldArchiveDatabase(db)),{code:'ARCHIVE_DB_ROLE'});}finally{await pg.exec(`REVOKE archive_escape FROM ${role}`);await pg.exec('DROP ROLE archive_escape');}
   await pg.exec(`GRANT CREATE ON SCHEMA public TO ${role}`);try{await assert.rejects(()=>asWorker(()=>assertHiggsfieldArchiveDatabase(db)),{code:'ARCHIVE_DB_SCHEMA'});}finally{await pg.exec(`REVOKE CREATE ON SCHEMA public FROM ${role}`);}
  });
  await t.test('unreviewed relations, sequences and executable definer functions are denied',async()=>{
   await pg.exec('CREATE SCHEMA unexpected; CREATE TABLE unexpected.private_data(value text)');await pg.exec(`GRANT USAGE ON SCHEMA unexpected TO ${role}; GRANT SELECT(value) ON unexpected.private_data TO ${role}`);
   try{await assert.rejects(()=>asWorker(()=>assertHiggsfieldArchiveDatabase(db)),{code:'ARCHIVE_DB_PRIVILEGES'});}finally{await pg.exec('DROP SCHEMA unexpected CASCADE');}
   await pg.exec(`CREATE SEQUENCE public.archive_extra; GRANT USAGE ON SEQUENCE public.archive_extra TO ${role}`);try{await assert.rejects(()=>asWorker(()=>assertHiggsfieldArchiveDatabase(db)),{code:'ARCHIVE_DB_PRIVILEGES'});}finally{await pg.exec('DROP SEQUENCE public.archive_extra');}
   await pg.exec("CREATE FUNCTION public.archive_definer() RETURNS integer LANGUAGE sql SECURITY DEFINER AS 'SELECT 1'");try{await assert.rejects(()=>asWorker(()=>assertHiggsfieldArchiveDatabase(db)),{code:'ARCHIVE_DB_PRIVILEGES'});await pg.exec('REVOKE ALL ON FUNCTION public.archive_definer() FROM PUBLIC');assert.equal((await asWorker(()=>assertHiggsfieldArchiveDatabase(db))).status,'passed');}finally{await pg.exec('DROP FUNCTION public.archive_definer()');}
  });
  await t.test('missing migration ledger entries are denied even if tables exist',async()=>{
   await pg.query("DELETE FROM schema_migrations WHERE name='029_higgsfield_archives.sql'");await assert.rejects(()=>asWorker(()=>assertHiggsfieldArchiveDatabase(db)),{code:'ARCHIVE_DB_MIGRATIONS'});
   await pg.query("INSERT INTO schema_migrations(name) VALUES('029_higgsfield_archives.sql')");assert.equal((await asWorker(()=>assertHiggsfieldArchiveDatabase(db))).status,'passed');
  });
  await t.test('disabled-processing CLI preflight reaches the database check and closes its pool on failure',{timeout:15000},async()=>{
   const {PGLiteSocketServer}=await import('@electric-sql/pglite-socket'),server=new PGLiteSocketServer({db:pg,host:'127.0.0.1',port:0,maxConnections:1});await server.start();
   try{
    const result=await new Promise<{code:number|null;stdout:string;stderr:string}>((resolve,reject)=>{
     const child=spawn(process.execPath,['--import','tsx','scripts/higgsfield-archive-worker.ts','--preflight'],{cwd:process.cwd(),env:{...process.env,DATABASE_URL:`postgresql://postgres:postgres@${server.getServerConn()}/postgres`,COATRIA_HOSTING_KEYRING:JSON.stringify({activeKeyId:'fixture',keys:{fixture:randomBytes(32).toString('base64')}}),COATRIA_HIGGSFIELD_ARCHIVE_ENABLED:'false'},stdio:['ignore','pipe','pipe'],windowsHide:true});
     let stdout='',stderr='';const timer=setTimeout(()=>{child.kill();reject(Error('Preflight did not close its database pool and exit promptly'));},10000);
     child.stdout.on('data',data=>{stdout+=String(data);});child.stderr.on('data',data=>{stderr+=String(data);});child.on('error',error=>{clearTimeout(timer);reject(error);});child.on('close',code=>{clearTimeout(timer);resolve({code,stdout,stderr});});
    });
    assert.equal(result.code,1);assert.equal(result.stdout,'');assert.deepEqual(JSON.parse(result.stderr.trim()),{event:'archive-worker-startup-failed',code:'ARCHIVE_DB_IDENTITY'});
    assert.equal((await pg.query<{count:number}>('SELECT count(*)::int AS count FROM higgsfield_output_archives')).rows[0].count,0);
   }finally{await server.stop();}
  });
 }finally{await pg.close();}
});
