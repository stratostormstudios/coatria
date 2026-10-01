/**
 * Explicit operator-only creation of one new restricted reference registrar LOGIN.
 * Pipe {connectionString,password} JSON on stdin; neither is accepted in argv.
 * Existing roles are never altered. No provider request or deployment occurs.
 */
import {createHash} from 'node:crypto';
import {readFile,readdir} from 'node:fs/promises';
import {resolve} from 'node:path';
import {pathToFileURL} from 'node:url';
import pg from 'pg';
import {parseProvisionInput} from './provision-runtime-role.mjs';
import {withReferenceProvisionVerificationRole,referenceProvisionDiagnostic} from './provision-reference-broker-role.mjs';
import {HIGGSFIELD_REFERENCE_REGISTRAR_ROLE as ROLE,assertHiggsfieldReferenceRegistrarDatabase} from '../src/lib/higgsfield-reference-registrar-database.mjs';

const {Client,escapeLiteral}=pg;
class ReferenceProvisionError extends Error{constructor(code,message,diagnostic){super(message);this.code=code;this.diagnostic=diagnostic;}}
const refuse=(code,message,diagnostic)=>{throw new ReferenceProvisionError(code,message,diagnostic);};
export function parseReferenceRegistrarProvisionInput(value){
 const parsed=parseProvisionInput(value);
 parsed.clientConfig.application_name='coatria-reference-registrar-role-provisioner';
 return parsed;
}
export async function provisionReferenceRegistrarRole(input){
 const {password,clientConfig}=parseReferenceRegistrarProvisionInput(input);
 const directory=new URL('../database/',import.meta.url);
 const permissions=await readFile(new URL('reference-registrar-permissions.sql',directory),'utf8');
 const migrations=(await readdir(directory)).filter(name=>/^\d.*\.sql$/.test(name)).sort();
 if(!permissions.trim()||!migrations.includes('044_higgsfield_reference_enrollments.sql'))refuse('MISSING_REPOSITORY_FILES','The reviewed registrar grants and enrollment migration are required.');
 const owner=new Client(clientConfig);owner.on('error',()=>{});
 let transaction=false,committing=false,committed=false,registrar,phase='connect_owner';
 try{
  await owner.connect();phase='begin';await owner.query('BEGIN');transaction=true;
  phase='configure_transaction';
  await owner.query("SET LOCAL search_path=pg_catalog,public; SET LOCAL lock_timeout='10s'; SET LOCAL idle_in_transaction_session_timeout='20s'; SET LOCAL password_encryption='scram-sha-256'");
  phase='acquire_lock';
  await owner.query('SELECT pg_catalog.pg_advisory_xact_lock(672938410)');
  phase='owner_authority';
  const authority=(await owner.query(`SELECT r.rolsuper,r.rolcreaterole,pg_catalog.pg_has_role(current_user,d.datdba,'USAGE') AS owns_database FROM pg_catalog.pg_roles r JOIN pg_catalog.pg_database d ON d.datname=current_database() WHERE r.rolname=current_user`)).rows[0];
  if(!authority||(!authority.rolsuper&&(!authority.rolcreaterole||!authority.owns_database)))refuse('OWNER_REQUIRED','Use the database owner with CREATEROLE authority.');
  phase='role_absence';if((await owner.query('SELECT 1 FROM pg_catalog.pg_roles WHERE rolname=$1',[ROLE])).rowCount)refuse('ROLE_EXISTS','The registrar role already exists. No existing role or password was changed.');
  phase='migrations';
  const applied=new Set((await owner.query('SELECT name FROM public.schema_migrations')).rows.map(r=>r.name));
  if(migrations.some(name=>!applied.has(name)))refuse('MIGRATIONS_REQUIRED','Apply all reviewed numbered migrations before creating the registrar role.');
  phase='create_role';await owner.query(`CREATE ROLE "${ROLE}" LOGIN NOINHERIT NOSUPERUSER NOCREATEROLE NOCREATEDB NOREPLICATION NOBYPASSRLS PASSWORD ${escapeLiteral(password)}`);
  phase='apply_permissions';await owner.query(permissions);
  await withReferenceProvisionVerificationRole(owner,ROLE,()=>assertHiggsfieldReferenceRegistrarDatabase(owner,{provisioning:true}),value=>{phase=value;});
  phase='commit';committing=true;await owner.query('COMMIT');committed=true;transaction=false;
  registrar=new Client({...clientConfig,user:ROLE,password,application_name:'coatria-reference-registrar-login-verification'});registrar.on('error',()=>{});
  phase='connect_login';await registrar.connect();phase='verify_login';const verification=await assertHiggsfieldReferenceRegistrarDatabase(registrar);
  return {ok:true,role:ROLE,created:true,grantsSha256:createHash('sha256').update(permissions).digest('hex'),migrationCount:migrations.length,verification};
 }catch(error){
  const diagnostic=referenceProvisionDiagnostic(phase,error);
  if(transaction)try{await owner.query('ROLLBACK');}catch{/* Closing ends an uncommitted transaction. */}
  if(committed)refuse('ROLE_CREATED_VERIFICATION_FAILED','The role was committed but its independent LOGIN verification failed. Inspect it before any retry; no password or grants were changed afterward.',diagnostic);
  if(committing)refuse('COMMIT_OUTCOME_UNKNOWN','COMMIT was not confirmed. Inspect whether the role exists before retrying.',diagnostic);
  if(error instanceof ReferenceProvisionError){error.diagnostic=diagnostic;throw error;}
  if(error?.code==='42710')refuse('ROLE_EXISTS','The registrar role already exists. No existing role was altered.',diagnostic);
  refuse('PROVISION_FAILED','Provisioning failed before confirmed COMMIT. Review owner access, migrations and grants; database details are withheld.',diagnostic);
 }finally{try{await registrar?.end();}catch{}try{await owner.end();}catch{}}
}
async function input(){
 const chunks=[];let size=0;
 for await(const chunk of process.stdin){size+=Buffer.byteLength(chunk);if(size>16384)refuse('INPUT_TOO_LARGE','Input exceeds 16 KiB.');chunks.push(Buffer.from(chunk));}
 try{return JSON.parse(Buffer.concat(chunks).toString('utf8'));}catch{refuse('INVALID_JSON','Provide one JSON object on stdin.');}
}
if(process.argv[1]&&import.meta.url===pathToFileURL(resolve(process.argv[1])).href){
 if(process.argv.length!==2){console.error('Usage: pipe JSON to node scripts/provision-reference-registrar-role.mjs. Credentials must not be arguments.');process.exitCode=1;}
 else try{console.log(JSON.stringify(await provisionReferenceRegistrarRole(await input())));}
 catch(error){const known=error instanceof ReferenceProvisionError;console.error(JSON.stringify({ok:false,code:known?error.code:'PROVISION_FAILED',message:known?error.message:'Provisioning failed; sensitive details are withheld.',...(known&&error.diagnostic?{diagnostic:error.diagnostic}:{})}));process.exitCode=known&&['COMMIT_OUTCOME_UNKNOWN','ROLE_CREATED_VERIFICATION_FAILED'].includes(error.code)?2:1;}
}
