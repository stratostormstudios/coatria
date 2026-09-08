/**
 * One-time operator command; ordinary builds and migrations never invoke it.
 * Pipe one JSON object on stdin: {connectionString,password}. Use the database
 * owner connection and a separately generated random password (32+ characters).
 * Only direct Neon endpoints and loopback PostgreSQL test servers are accepted.
 * Credentials are never accepted as command-line arguments or printed.
 */
import {createHash} from 'node:crypto';
import {readFile,readdir} from 'node:fs/promises';
import {resolve} from 'node:path';
import {pathToFileURL} from 'node:url';
import pg from 'pg';

const {Client,escapeLiteral}=pg;
const ROLE='coatria_runtime_v1';
const databaseDirectory=new URL('../database/',import.meta.url);
const MAX_INPUT_BYTES=16*1024;
const writableTables=[
  'sessions','companies','memberships','invitations','rooms','presence','messages',
  'agents','tasks','contributions','activity','skills','skill_versions','drives',
  'drive_files','openings','applications','rate_limits','call_peers','call_signals','task_authors'
];

class ProvisionError extends Error{
  constructor(code,message){super(message);this.code=code;}
}
function refuse(code,message){throw new ProvisionError(code,message);}

/** Validate before any connection. Returned credentials must stay in memory. */
export function parseProvisionInput(value){
  if(!value||Array.isArray(value)||typeof value!=='object'||
    Object.keys(value).some(key=>!['connectionString','password'].includes(key))||
    typeof value.connectionString!=='string'||typeof value.password!=='string'){
    refuse('INVALID_INPUT','Provide exactly connectionString and password as a JSON object on stdin.');
  }
  if(!/^[\x21-\x7e]{32,256}$/.test(value.password)){
    refuse('INVALID_PASSWORD','The new role password must be a separately generated random string of 32 to 256 printable non-space ASCII characters.');
  }
  if(/^md5[a-f\d]{32}$/i.test(value.password)||value.password.startsWith('SCRAM-SHA-256$')){
    refuse('INVALID_PASSWORD','Provide a newly generated plaintext password, not a PostgreSQL password verifier.');
  }
  let url;
  try{url=new URL(value.connectionString);}catch{refuse('INVALID_CONNECTION','The owner connection must be a PostgreSQL URL.');}
  if(!['postgres:','postgresql:'].includes(url.protocol)||url.hash||!url.username||!url.password||url.pathname.length<2){
    refuse('INVALID_CONNECTION','The owner connection must include PostgreSQL credentials and a database name, without a fragment.');
  }
  const host=url.hostname.toLowerCase();
  const local=['localhost','127.0.0.1','[::1]'].includes(host);
  if(!local&&(!host.endsWith('.neon.tech')||host.split('.')[0].endsWith('-pooler'))){
    refuse('UNSUPPORTED_HOST','Use a direct Neon endpoint or a loopback PostgreSQL test server.');
  }
  for(const key of url.searchParams.keys()){
    if(!['sslmode','channel_binding'].includes(key)||url.searchParams.getAll(key).length!==1){
      refuse('UNSUPPORTED_CONNECTION_OPTION','Only sslmode and channel_binding URL options are supported.');
    }
  }
  const sslmode=url.searchParams.get('sslmode');
  if(sslmode&&!['require','verify-ca','verify-full',...(local?['disable']:[])].includes(sslmode)){
    refuse('INVALID_TLS','Remote provisioning requires verified TLS; insecure SSL modes are not accepted.');
  }
  const binding=url.searchParams.get('channel_binding');
  if(binding&&!['require','prefer'].includes(binding))refuse('INVALID_TLS','Channel binding cannot be disabled by this command.');
  let user,password,database;
  try{
    user=decodeURIComponent(url.username);
    password=decodeURIComponent(url.password);
    database=decodeURIComponent(url.pathname.slice(1));
  }catch{refuse('INVALID_CONNECTION','The owner connection contains invalid URL encoding.');}
  if([user,password,database].some(part=>!part||/[\u0000-\u001f\u007f]/.test(part))||database.includes('/')){
    refuse('INVALID_CONNECTION','The owner connection contains an unsupported credential or database name.');
  }
  const port=url.port?Number(url.port):5432;
  if(!Number.isInteger(port)||port<1||port>65535)refuse('INVALID_CONNECTION','The PostgreSQL port is invalid.');
  // Construct fields explicitly: URL parameters cannot override the validated
  // host, login, database or certificate verification through pg's URL parser.
  return{
    password:value.password,
    clientConfig:{
      host:host==='[::1]'?'::1':host,port,user,password,database,
      ssl:local&&(!sslmode||sslmode==='disable')?false:{rejectUnauthorized:true},
      enableChannelBinding:true,
      application_name:'coatria-runtime-role-provisioner',
      connectionTimeoutMillis:10000,statement_timeout:15000,query_timeout:20000
    }
  };
}

async function readInput(){
  const chunks=[];let bytes=0;
  for await(const chunk of process.stdin){
    bytes+=Buffer.byteLength(chunk);
    if(bytes>MAX_INPUT_BYTES)refuse('INPUT_TOO_LARGE','Provisioning input exceeds 16 KiB.');
    chunks.push(Buffer.from(chunk));
  }
  try{return JSON.parse(Buffer.concat(chunks).toString('utf8'));}catch{refuse('INVALID_JSON','Provisioning input must be one valid JSON object.');}
}

async function verifyRuntimePrivileges(client){
  const attributes=(await client.query(`SELECT rolcanlogin,rolinherit,rolsuper,rolcreatedb,rolcreaterole,rolreplication,rolbypassrls
    FROM pg_catalog.pg_roles WHERE rolname=$1`,[ROLE])).rows[0];
  if(!attributes||!attributes.rolcanlogin||Object.entries(attributes).some(([name,value])=>name!=='rolcanlogin'&&value)){
    refuse('UNSAFE_ROLE','The new role has unexpected role attributes.');
  }
  const memberships=(await client.query(`SELECT 1 FROM pg_catalog.pg_auth_members m JOIN pg_catalog.pg_roles r ON r.oid=m.member WHERE r.rolname=$1 LIMIT 1`,[ROLE])).rowCount;
  if(memberships)refuse('UNSAFE_ROLE','The new role unexpectedly belongs to another database role.');
  const checks=(await client.query(`SELECT
    pg_catalog.has_database_privilege($1,current_database(),'CONNECT') AS can_connect,
    pg_catalog.has_database_privilege($1,current_database(),'CREATE') AS can_create_schema,
    pg_catalog.has_schema_privilege($1,'public','USAGE') AS can_use_public,
    pg_catalog.has_schema_privilege($1,'public','CREATE') AS can_create_objects,
    pg_catalog.has_table_privilege($1,'public.users','SELECT') AS can_read_users,
    pg_catalog.has_table_privilege($1,'public.schema_migrations','SELECT') AS can_read_migrations,
    pg_catalog.has_table_privilege($1,'public.users','DELETE,TRUNCATE,TRIGGER,REFERENCES') AS can_destroy_users,
    pg_catalog.has_table_privilege($1,'public.schema_migrations','INSERT,UPDATE,DELETE,TRUNCATE,TRIGGER,REFERENCES') AS can_write_migrations,
    pg_catalog.has_column_privilege($1,'public.users','email_verified_at','INSERT,UPDATE') AS can_verify_email,
    pg_catalog.has_column_privilege($1,'public.users','email','UPDATE') AS can_change_email,
    pg_catalog.has_column_privilege($1,'public.users','id','INSERT,UPDATE') AS can_change_user_id,
    pg_catalog.has_column_privilege($1,'public.users','created_at','INSERT,UPDATE') AS can_change_creation_time`,[ROLE])).rows[0];
  if(['can_connect','can_use_public','can_read_users','can_read_migrations'].some(key=>!checks[key])){
    refuse('MISSING_RUNTIME_PRIVILEGES','The new role is missing required connection or read privileges.');
  }
  if(Object.entries(checks).some(([key,value])=>!['can_connect','can_use_public','can_read_users','can_read_migrations'].includes(key)&&value)){
    refuse('FORBIDDEN_RUNTIME_PRIVILEGES','The new role has forbidden effective privileges. Review PUBLIC and column grants before retrying.');
  }
  const allowedColumns=(await client.query(`SELECT bool_and(pg_catalog.has_column_privilege($1,'public.users',name,privilege)) AS allowed
    FROM (VALUES ('name','INSERT'),('email','INSERT'),('password_hash','INSERT'),('role_title','INSERT'),('avatar_color','INSERT'),
      ('name','UPDATE'),('password_hash','UPDATE'),('role_title','UPDATE'),('avatar_color','UPDATE')) AS required(name,privilege)`,[ROLE])).rows[0].allowed;
  const allowedTables=(await client.query(`SELECT bool_and(pg_catalog.has_table_privilege($1,'public.'||name,privilege)) AS allowed,
    bool_or(pg_catalog.has_table_privilege($1,'public.'||name,'TRUNCATE,TRIGGER,REFERENCES')) AS excessive
    FROM unnest($2::text[]) AS tables(name) CROSS JOIN unnest(ARRAY['SELECT','INSERT','UPDATE','DELETE']) AS privileges(privilege)`,[ROLE,writableTables])).rows[0];
  if(!allowedColumns||!allowedTables.allowed)refuse('MISSING_RUNTIME_PRIVILEGES','The new role is missing required application column or table privileges.');
  if(allowedTables.excessive)refuse('FORBIDDEN_RUNTIME_PRIVILEGES','The new role has unexpected table privileges. Review PUBLIC grants before retrying.');
  const sequence=(await client.query(`SELECT pg_catalog.has_sequence_privilege($1,pg_catalog.pg_get_serial_sequence('public.call_signals','id'),'USAGE') AS allowed`,[ROLE])).rows[0];
  if(!sequence.allowed)refuse('MISSING_RUNTIME_PRIVILEGES','The new role is missing the call-signaling sequence privilege.');
  return{roleAttributes:true,requiredApplicationGrants:true,restrictedIdentityColumns:true,noSchemaOrMigrationWrites:true};
}

/** Provision only when explicitly invoked by an operator; never alter an existing role. */
export async function provisionRuntimeRole(input){
  const {password,clientConfig}=parseProvisionInput(input);
  const permissions=await readFile(new URL('runtime-permissions.sql',databaseDirectory),'utf8');
  const migrations=(await readdir(databaseDirectory)).filter(name=>/^\d.*\.sql$/.test(name)).sort();
  if(!permissions.trim()||!migrations.length)refuse('MISSING_REPOSITORY_FILES','Runtime permissions and numbered migrations must be present beside this script.');
  const client=new Client(clientConfig);
  // Never let a background transport error print a connection string or query.
  client.on('error',()=>{});
  let inTransaction=false,committing=false,committed=false;
  try{
    await client.connect();
    await client.query('BEGIN');inTransaction=true;
    await client.query("SET LOCAL search_path=pg_catalog,public; SET LOCAL lock_timeout='10s'; SET LOCAL idle_in_transaction_session_timeout='20s'; SET LOCAL password_encryption='scram-sha-256'");
    // Share the migration advisory lock so grants never race a numbered migration.
    await client.query('SELECT pg_catalog.pg_advisory_xact_lock(672938410)');
    const owner=(await client.query(`SELECT r.rolsuper,r.rolcreaterole,pg_catalog.pg_has_role(current_user,d.datdba,'USAGE') AS owns_database
      FROM pg_catalog.pg_roles r JOIN pg_catalog.pg_database d ON d.datname=current_database() WHERE r.rolname=current_user`)).rows[0];
    if(!owner||(!owner.rolsuper&&(!owner.rolcreaterole||!owner.owns_database))){
      refuse('OWNER_REQUIRED','Use the database owner connection with CREATEROLE authority. The runtime login cannot provision roles.');
    }
    if((await client.query('SELECT 1 FROM pg_catalog.pg_roles WHERE rolname=$1',[ROLE])).rowCount){
      refuse('ROLE_EXISTS','The runtime role already exists. No password or grants were changed; inspect it separately.');
    }
    const applied=(await client.query('SELECT name FROM public.schema_migrations')).rows.map(row=>row.name);
    if(migrations.some(name=>!applied.includes(name)))refuse('MIGRATIONS_REQUIRED','Apply all numbered repository migrations with the owner connection before provisioning.');
    // pg's tested SQL literal encoder handles quotes and backslashes. PostgreSQL
    // utility statements cannot use a bind parameter in the PASSWORD clause.
    await client.query(`CREATE ROLE "${ROLE}" LOGIN NOINHERIT NOSUPERUSER NOCREATEROLE NOCREATEDB NOREPLICATION NOBYPASSRLS PASSWORD ${escapeLiteral(password)}`);
    await client.query(permissions);
    const verification=await verifyRuntimePrivileges(client);
    committing=true;
    await client.query('COMMIT');committed=true;inTransaction=false;
    return{ok:true,role:ROLE,created:true,grantsSha256:createHash('sha256').update(permissions).digest('hex'),migrationCount:migrations.length,verification};
  }catch(error){
    if(inTransaction)try{await client.query('ROLLBACK');}catch{/* Closing the connection ends an uncommitted transaction. */}
    if(committing&&!committed)refuse('COMMIT_OUTCOME_UNKNOWN','The connection did not confirm COMMIT. Inspect whether the role exists before any retry; do not assume it was rolled back.');
    if(error instanceof ProvisionError)throw error;
    if(error?.code==='42710')refuse('ROLE_EXISTS','The runtime role already exists. No existing role was altered; inspect it separately.');
    if(error?.code==='42501')refuse('INSUFFICIENT_OWNER_PRIVILEGES','The owner connection lacks a required provisioning privilege. No transaction was committed.');
    refuse('PROVISION_FAILED','Provisioning failed before COMMIT. Check connectivity, owner privileges, migrations and grants; database error details are intentionally withheld.');
  }finally{
    try{await client.end();}catch{/* Never print transport errors or credentials. */}
  }
}

if(process.argv[1]&&import.meta.url===pathToFileURL(resolve(process.argv[1])).href){
  if(process.argv.length!==2){
    console.error('Usage: pipe JSON {connectionString,password} to node scripts/provision-runtime-role.mjs. Credentials must not be command-line arguments.');
    process.exitCode=1;
  }else{
    try{console.log(JSON.stringify(await provisionRuntimeRole(await readInput())));}
    catch(error){
      const safe=error instanceof ProvisionError?{ok:false,code:error.code,message:error.message}:{ok:false,code:'PROVISION_FAILED',message:'Provisioning failed; sensitive error details are intentionally withheld.'};
      console.error(JSON.stringify(safe));process.exitCode=safe.code==='COMMIT_OUTCOME_UNKNOWN'?2:1;
    }
  }
}
