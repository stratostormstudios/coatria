/**
 * Explicit operator-only creation of one new restricted reference broker LOGIN.
 * Pipe {connectionString,password} JSON on stdin; neither is accepted in argv.
 * Existing roles are never altered. No provider request or deployment occurs.
 */
import {createHash} from 'node:crypto';
import {readFile,readdir} from 'node:fs/promises';
import {resolve} from 'node:path';
import {pathToFileURL} from 'node:url';
import pg from 'pg';
import {parseProvisionInput} from './provision-runtime-role.mjs';
import {HIGGSFIELD_REFERENCE_BROKER_ROLE as ROLE,assertHiggsfieldReferenceDatabase} from '../src/lib/higgsfield-reference-database.mjs';

const {Client,escapeLiteral}=pg;
class ReferenceProvisionError extends Error{constructor(code,message,diagnostic){super(message);this.code=code;this.diagnostic=diagnostic;}}
const refuse=(code,message,diagnostic)=>{throw new ReferenceProvisionError(code,message,diagnostic);};
const diagnosticPhases=new Set(['connect_owner','begin','configure_transaction','acquire_lock','owner_authority','role_absence','migrations','create_role','apply_permissions','verification_memberships','grant_verification_set','assume_role','verify_permissions','reset_role','restore_membership','verify_membership_restored','commit','connect_login','verify_login']);
const diagnosticCodes=new Set(['42501','42710','42704','42P01','42703','42601','57014','55P03','57P01','08001','08003','08006','08007','08P01','28P01','28000','53200','53300','25P02','25006','2BP01','OWNER_REQUIRED','ROLE_EXISTS','MIGRATIONS_REQUIRED','VERIFICATION_ROLE_UNSUPPORTED','VERIFICATION_MEMBERSHIP_CHANGED',
 ...['REFERENCE_DB_IDENTITY','REFERENCE_DB_ROLE','REFERENCE_DB_SCHEMA','REFERENCE_DB_MIGRATIONS','REFERENCE_DB_PRIVILEGES','REFERENCE_DB_LOCK_GUARD','REFERENCE_DB_STATE_GUARD','REFERENCE_DB_CHECK_FAILED'],
 ...['REFERENCE_REGISTRAR_DB_IDENTITY','REFERENCE_REGISTRAR_DB_ROLE','REFERENCE_REGISTRAR_DB_SCHEMA','REFERENCE_REGISTRAR_DB_MIGRATIONS','REFERENCE_REGISTRAR_DB_PRIVILEGES','REFERENCE_REGISTRAR_DB_GUARD','REFERENCE_REGISTRAR_DB_CHECK_FAILED']]);
/** Never copy messages, SQL, connection fields or arbitrary error properties. */
export function referenceProvisionDiagnostic(phase,error){return{phase:diagnosticPhases.has(phase)?phase:'unknown',code:diagnosticCodes.has(error?.code)?error.code:'UNCLASSIFIED'};}

/** The caller owns the transaction and must roll it back if verification fails.
 * PG16+ gives a CREATEROLE creator ADMIN but not SET. Add only a temporary
 * self-grant, then restore the exact membership snapshot before caller COMMIT.
 * This never grants the new principal any membership or owner privilege. */
export async function withReferenceProvisionVerificationRole(owner,role,verify,onPhase){
 if(![ROLE,'coatria_higgsfield_reference_registrar_v1'].includes(role))refuse('VERIFICATION_ROLE_UNSUPPORTED','Only the reviewed reference principals may be verified.');
 onPhase('verification_memberships');
 const identity=(await owner.query("SELECT r.oid::text AS oid,r.rolsuper,current_setting('server_version_num')::integer AS version FROM pg_catalog.pg_roles r WHERE r.rolname=current_user")).rows[0];
 if(!identity||identity.version<160000)refuse('VERIFICATION_ROLE_UNSUPPORTED','PostgreSQL 16 or newer is required for bounded role verification.');
 const memberships=async()=>(await owner.query(`SELECT m.roleid::text,m.member::text,m.grantor::text,m.admin_option,m.inherit_option,m.set_option FROM pg_catalog.pg_auth_members m JOIN pg_catalog.pg_roles r ON r.oid=m.roleid WHERE r.rolname=$1 ORDER BY m.member,m.grantor`,[role])).rows;
 const before=await memberships(),canSet=(await owner.query("SELECT pg_catalog.pg_has_role(current_user,$1,'SET') AS allowed",[role])).rows[0]?.allowed;
 if(typeof canSet!=='boolean')refuse('VERIFICATION_MEMBERSHIP_CHANGED','The verification role authority could not be confirmed.');
 const own=before.find(row=>row.member===identity.oid&&row.grantor===identity.oid);
 if(!canSet){onPhase('grant_verification_set');await owner.query(`GRANT "${role}" TO CURRENT_USER WITH ${own?'':'ADMIN FALSE, INHERIT FALSE, '}SET TRUE GRANTED BY CURRENT_USER`);}
 onPhase('assume_role');await owner.query(`SET LOCAL ROLE "${role}"`);
 onPhase('verify_permissions');const result=await verify();
 onPhase('reset_role');await owner.query('RESET ROLE');
 if(!canSet){onPhase('restore_membership');await owner.query(own?`GRANT "${role}" TO CURRENT_USER WITH SET FALSE GRANTED BY CURRENT_USER`:`REVOKE "${role}" FROM CURRENT_USER GRANTED BY CURRENT_USER`);}
 onPhase('verify_membership_restored');
 if(JSON.stringify(await memberships())!==JSON.stringify(before))refuse('VERIFICATION_MEMBERSHIP_CHANGED','The original role memberships were not restored; COMMIT is prohibited.');
 return result;
}
export function parseReferenceBrokerProvisionInput(value){
 const parsed=parseProvisionInput(value);
 parsed.clientConfig.application_name='coatria-reference-broker-role-provisioner';
 return parsed;
}
export async function provisionReferenceBrokerRole(input){
 const {password,clientConfig}=parseReferenceBrokerProvisionInput(input);
 const directory=new URL('../database/',import.meta.url);
 const permissions=await readFile(new URL('reference-broker-permissions.sql',directory),'utf8');
 const migrations=(await readdir(directory)).filter(name=>/^\d.*\.sql$/.test(name)).sort();
 if(!permissions.trim()||!migrations.includes('043_higgsfield_reference_services.sql'))refuse('MISSING_REPOSITORY_FILES','The reviewed broker grants and service migration are required.');
 const owner=new Client(clientConfig);owner.on('error',()=>{});
 let transaction=false,committing=false,committed=false,broker,phase='connect_owner';
 try{
  await owner.connect();phase='begin';await owner.query('BEGIN');transaction=true;
  phase='configure_transaction';
  await owner.query("SET LOCAL search_path=pg_catalog,public; SET LOCAL lock_timeout='10s'; SET LOCAL idle_in_transaction_session_timeout='20s'; SET LOCAL password_encryption='scram-sha-256'");
  phase='acquire_lock';
  await owner.query('SELECT pg_catalog.pg_advisory_xact_lock(672938410)');
  phase='owner_authority';
  const authority=(await owner.query(`SELECT r.rolsuper,r.rolcreaterole,pg_catalog.pg_has_role(current_user,d.datdba,'USAGE') AS owns_database FROM pg_catalog.pg_roles r JOIN pg_catalog.pg_database d ON d.datname=current_database() WHERE r.rolname=current_user`)).rows[0];
  if(!authority||(!authority.rolsuper&&(!authority.rolcreaterole||!authority.owns_database)))refuse('OWNER_REQUIRED','Use the database owner with CREATEROLE authority.');
  phase='role_absence';if((await owner.query('SELECT 1 FROM pg_catalog.pg_roles WHERE rolname=$1',[ROLE])).rowCount)refuse('ROLE_EXISTS','The broker role already exists. No existing role or password was changed.');
  phase='migrations';
  const applied=new Set((await owner.query('SELECT name FROM public.schema_migrations')).rows.map(r=>r.name));
  if(migrations.some(name=>!applied.has(name)))refuse('MIGRATIONS_REQUIRED','Apply all reviewed numbered migrations before creating the broker role.');
  phase='create_role';await owner.query(`CREATE ROLE "${ROLE}" LOGIN NOINHERIT NOSUPERUSER NOCREATEROLE NOCREATEDB NOREPLICATION NOBYPASSRLS PASSWORD ${escapeLiteral(password)}`);
  phase='apply_permissions';await owner.query(permissions);
  await withReferenceProvisionVerificationRole(owner,ROLE,()=>assertHiggsfieldReferenceDatabase(owner,{provisioning:true}),value=>{phase=value;});
  phase='commit';committing=true;await owner.query('COMMIT');committed=true;transaction=false;
  broker=new Client({...clientConfig,user:ROLE,password,application_name:'coatria-reference-broker-login-verification'});broker.on('error',()=>{});
  phase='connect_login';await broker.connect();phase='verify_login';const verification=await assertHiggsfieldReferenceDatabase(broker);
  return {ok:true,role:ROLE,created:true,grantsSha256:createHash('sha256').update(permissions).digest('hex'),migrationCount:migrations.length,verification};
 }catch(error){
  const diagnostic=referenceProvisionDiagnostic(phase,error);
  if(transaction)try{await owner.query('ROLLBACK');}catch{/* Closing ends an uncommitted transaction. */}
  if(committed)refuse('ROLE_CREATED_VERIFICATION_FAILED','The role was committed but its independent LOGIN verification failed. Inspect it before any retry; no password or grants were changed afterward.',diagnostic);
  if(committing)refuse('COMMIT_OUTCOME_UNKNOWN','COMMIT was not confirmed. Inspect whether the role exists before retrying.',diagnostic);
  if(error instanceof ReferenceProvisionError){error.diagnostic=diagnostic;throw error;}
  if(error?.code==='42710')refuse('ROLE_EXISTS','The broker role already exists. No existing role was altered.',diagnostic);
  refuse('PROVISION_FAILED','Provisioning failed before confirmed COMMIT. Review owner access, migrations and grants; database details are withheld.',diagnostic);
 }finally{try{await broker?.end();}catch{}try{await owner.end();}catch{}}
}
async function input(){
 const chunks=[];let size=0;
 for await(const chunk of process.stdin){size+=Buffer.byteLength(chunk);if(size>16384)refuse('INPUT_TOO_LARGE','Input exceeds 16 KiB.');chunks.push(Buffer.from(chunk));}
 try{return JSON.parse(Buffer.concat(chunks).toString('utf8'));}catch{refuse('INVALID_JSON','Provide one JSON object on stdin.');}
}
if(process.argv[1]&&import.meta.url===pathToFileURL(resolve(process.argv[1])).href){
 if(process.argv.length!==2){console.error('Usage: pipe JSON to node scripts/provision-reference-broker-role.mjs. Credentials must not be arguments.');process.exitCode=1;}
 else try{console.log(JSON.stringify(await provisionReferenceBrokerRole(await input())));}
 catch(error){const known=error instanceof ReferenceProvisionError;console.error(JSON.stringify({ok:false,code:known?error.code:'PROVISION_FAILED',message:known?error.message:'Provisioning failed; sensitive details are withheld.',...(known&&error.diagnostic?{diagnostic:error.diagnostic}:{})}));process.exitCode=known&&['COMMIT_OUTCOME_UNKNOWN','ROLE_CREATED_VERIFICATION_FAILED'].includes(error.code)?2:1;}
}
