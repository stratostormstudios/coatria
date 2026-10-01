/** Synthetic rows/receipts test the CI verifier itself, not host qualification.
 * The separate installed Linux job is the acceptance evidence producer. */
import test from 'node:test';
import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import {readFile,readdir} from 'node:fs/promises';
import {PGlite} from '@electric-sql/pglite';
import {createImagePreparationEnrollmentCiRegistrar,parseImagePreparationEnrollmentCiReply,imagePreparationEnrollmentCiDatabaseProof,seedImagePreparationEnrollmentCiDatabase,acceptImagePreparationEnrollmentCiQualification,readImagePreparationEnrollmentCiToken} from './qualify-image-preparation-enrollment-ci.mjs';
import {makeImagePreparationEnrollmentIntent,enrollmentBytesHash as hash} from './image-preparation-host-enrollment.mjs';
import {deriveImagePreparationRunnerConfiguration,imagePreparationRunnerConfigurationHash} from './image-preparation-runner-configuration.mjs';
import {imagePreparationEnrollmentServiceIdentity,imagePreparationEnrollmentProjectIdentity} from '../../src/lib/project-image-preparation-enrollment-contract.mjs';
import {verifiedImagePreparationGateway} from '../../src/lib/project-image-preparation-gateway-binding.ts';
import {IMAGE_PREPARATION_RECIPE_HASH} from '../../src/lib/higgsfield-image-preparation.ts';

const json=v=>Buffer.from(JSON.stringify(v,null,2)+'\n');
const rejected=error=>error instanceof Error&&error.message==='IMAGE_PREPARATION_ENROLLMENT_CI_REJECTED';
function fixture(){
 const serviceId=randomUUID(),companyId=randomUUID(),projectId=randomUUID(),bundleSha256='a'.repeat(64),release='/var/lib/coatria-image-preparation-releases/'+bundleSha256,now=Date.now();
 const host={version:1,bundleSha256,commit:'b'.repeat(40),tree:'c'.repeat(40),release,closureSha256:'d'.repeat(64),recipeSha256:IMAGE_PREPARATION_RECIPE_HASH,uid:65534,gid:65534,scope:{serviceId,companyId,projectIds:[projectId],origin:'https://coatria.com',location:'Synthetic installed registrar verifier',expiresAt:new Date(now+1800000).toISOString(),gateways:[{projectId,origin:'https://imagepreparationci1-4190.proxy.runpod.net'}]},profiles:{real:{profilePath:`/etc/coatria-image-preparation/${serviceId}/real.json`,expectedProfileSha256:'e'.repeat(64)},conformance:{profilePath:`/etc/coatria-image-preparation/${serviceId}/conformance.json`,expectedProfileSha256:'f'.repeat(64)}},worker:{path:release+'/worker/runtime.mjs',sha256:'1'.repeat(64)},qualifier:{path:release+'/qualifier/runtime.mjs',sha256:'2'.repeat(64)},node:{path:release+'/runtime/node',sha256:'3'.repeat(64)},units:Object.fromEntries(['qualify','preflight','worker'].map(mode=>[mode,{name:`coatria-image-preparation-${serviceId}-${mode}.service`,sha256:hash(mode)}]))};
 const hostBytes=json(host),configuration=deriveImagePreparationRunnerConfiguration(host,hash(hostBytes),'0'.repeat(64));
 const receipt={version:1,kind:'coatria-image-preparation-qualification-v1',serviceId,companyId,projectIds:[projectId],sourceCommit:host.commit,sourceTree:host.tree,bundleSha256,releaseSha256:host.worker.sha256,closureSha256:host.closureSha256,recipeSha256:host.recipeSha256,qualifierSha256:host.qualifier.sha256,configurationSha256:imagePreparationRunnerConfigurationHash(configuration),hostConfigurationSha256:hash(hostBytes),profileSha256:host.profiles.real.expectedProfileSha256,conformanceProfileSha256:host.profiles.conformance.expectedProfileSha256,bootId:randomUUID(),uid:host.uid,gid:host.gid,expiresAt:host.scope.expiresAt,units:host.units,qualifierInvocationId:'4'.repeat(32),serviceRoot:'/sys/fs/cgroup/system.slice/'+host.units.qualify.name,evidenceSha256:'5'.repeat(64),reportSha256:'6'.repeat(64),acceptedAt:new Date(now-1000).toISOString(),qualified:true,checks:{isolation:true,resourceLimits:true,descendantCleanup:true,imagePreparation:true}};
 const receiptBytes=json(receipt),scope={version:1,enrolledBy:randomUUID(),enroller:{role:'owner',joinedAt:new Date(now-10000).toISOString().replace(/\.(\d{3})Z$/,'.$1123Z')},projects:[{projectId,projectRevision:1,storageBindingId:randomUUID(),storageBindingRevision:1,storageConnectionId:randomUUID(),storageConnectionRevision:1,gateway:{bindingId:randomUUID(),provisionId:randomUUID(),configurationSha256:'7'.repeat(64),origin:host.scope.gateways[0].origin,expiresAt:host.scope.expiresAt}}]},registrarSha='8'.repeat(64),scopeSha=hash(json(scope)),scopePath='/var/lib/coatria-image-preparation-enrollment-ci-'+randomUUID()+'/scope.json',token='ips_'+'x'.repeat(43);
 const qualified={host,hostBytes,receipt,receiptBytes,qualificationSha256:hash(receiptBytes)},intent=makeImagePreparationEnrollmentIntent(qualified,scope,{requestId:randomUUID(),token,scopeSha256:scopeSha,registrarBundleSha256:registrarSha});
 const pending={intent,intentBytes:json(intent),token,hostBytes,receiptBytes,submission:null},request=intent.request;
 const success={requestId:request.requestId,requestHash:intent.requestHash,serviceId,status:'committed',active:true,credentialReady:true,workerEnabled:false};
 const url=new URL('postgresql://127.0.0.1:5432/coatria_image_prep_host_ci_'+randomUUID().replaceAll('-',''));url.username='coatria_image_preparation_registrar_v1';url.password='synthetic-stdin-only';
 const tokenBytes=json({version:1,serviceId,configurationSha256:imagePreparationRunnerConfigurationHash(configuration),expiresAt:host.scope.expiresAt,token});
 return {host,scope,registrarSha,scopeSha,scopePath,pending,request,success,url,tokenBytes,rows:{services:[{...imagePreparationEnrollmentServiceIdentity(request),expires_at:request.expiresAt,revoked_at:null}],projects:imagePreparationEnrollmentProjectIdentity(request),enrollments:[{service_id:serviceId,company_id:companyId,request_id:request.requestId,request_hash:intent.requestHash,identity:request}]}};
}

test('compiled registrar invocation fixes executable/args/environment and sends synthetic credential only to stdin',()=>{
 const f=fixture(),calls=[],invoke=createImagePreparationEnrollmentCiRegistrar(f.host,f.registrarSha,f.scopePath,f.scopeSha,(file,args,options)=>{calls.push({file,args,options});return {status:0,stderr:'',stdout:JSON.stringify(f.success)};});
 assert.equal(invoke('enroll',f.url.href).ok,true);const call=calls[0];assert.equal(call.file,f.host.release+'/runtime/node');
 assert.deepEqual(call.args,['/var/lib/coatria-image-preparation-registrars/'+f.registrarSha+'/runtime.mjs','enroll','--host','/etc/coatria-image-preparation/'+f.host.scope.serviceId+'/host.json','--bundle',f.host.bundleSha256,'--registrar-bundle',f.registrarSha,'--scope',f.scopePath,'--scope-sha256',f.scopeSha]);
 assert.deepEqual(call.options.env,{PATH:'/usr/bin:/bin',LANG:'C',LC_ALL:'C'});assert.equal(call.options.shell,false);assert.deepEqual(JSON.parse(call.options.input),{connectionString:f.url.href});assert(!JSON.stringify({file:call.file,args:call.args,env:call.options.env}).includes(f.url.password));
 for(const mode of ['activate','start','preflight','--yes'])assert.throws(()=>invoke(mode,f.url.href));
 for(const change of [u=>u.hostname='remote.example',u=>u.username='postgres',u=>u.search='options=unsafe',u=>u.pathname='/production',u=>u.port='5433']){const url=new URL(f.url);change(url);assert.throws(()=>invoke('enroll',url.href));}assert.equal(calls.length,1);
 for(const change of [{release:'/tmp/unchecked'},{bundleSha256:'not-a-hash'}])assert.throws(()=>createImagePreparationEnrollmentCiRegistrar({...f.host,...change},f.registrarSha,f.scopePath,f.scopeSha));
 assert.throws(()=>createImagePreparationEnrollmentCiRegistrar(f.host,f.registrarSha,'/tmp/scope.json',f.scopeSha));
});

test('plan has no stdin credential and reconcile omits mutable scope arguments',()=>{
 const f=fixture(),calls=[],plan={mode:'plan',serviceId:f.request.serviceId,companyId:f.request.companyId,enrolledBy:f.request.enrolledBy,projects:f.request.projects,expiresAt:f.request.expiresAt,qualificationSha256:f.request.qualificationSha256,databaseAuthorityVerified:false,credentialCreated:false,workerEnabled:false};
 const invoke=createImagePreparationEnrollmentCiRegistrar(f.host,f.registrarSha,f.scopePath,f.scopeSha,(file,args,options)=>{calls.push({file,args,options});return {status:0,stderr:'',stdout:JSON.stringify(args[1]==='plan'?plan:f.success)};});
 assert.equal(invoke('plan').ok,true);assert.equal(calls[0].options.input,'');assert.throws(()=>invoke('plan',f.url.href));
 assert.equal(invoke('reconcile',f.url.href).ok,true);assert(!calls[1].args.includes('--scope'));assert(!calls[1].args.includes('--scope-sha256'));
});

test('malformed/extra child output, unsafe replies and raw errors never count as success',()=>{
 const f=fixture();
 for(const result of [{status:1,stdout:JSON.stringify(f.success),stderr:'secret diagnostics'},{status:0,stdout:JSON.stringify(f.success)+'\n{}',stderr:''},{status:0,stdout:'invalid',stderr:''},{status:0,stdout:JSON.stringify({...f.success,workerEnabled:true}),stderr:''},{status:0,stdout:JSON.stringify({...f.success,privateUrl:f.url.href}),stderr:''},{status:0,stdout:JSON.stringify(f.success),stderr:f.url.href},{status:0,error:Error(f.url.href),stdout:JSON.stringify(f.success)},{status:0,stdout:JSON.stringify({...f.success,status:'absent'}),stderr:''},{status:0,stdout:JSON.stringify({...f.success,active:false}),stderr:''},{status:0,stdout:JSON.stringify({...f.success,reason:'revoked'}),stderr:''}])assert.throws(()=>parseImagePreparationEnrollmentCiReply('enroll',result),rejected);
 assert.deepEqual(parseImagePreparationEnrollmentCiReply('enroll',{status:1,stdout:'',stderr:JSON.stringify({event:'image-preparation-host-enrollment-stopped',code:'IMAGE_PREPARATION_HOST_ENROLLMENT_REJECTED',workerEnabled:false})}),{ok:false,code:'IMAGE_PREPARATION_HOST_ENROLLMENT_REJECTED'});
 assert.throws(()=>parseImagePreparationEnrollmentCiReply('enroll',{status:1,stdout:'',stderr:JSON.stringify({event:'image-preparation-host-enrollment-stopped',code:'IMAGE_PREPARATION_HOST_ENROLLMENT_'+'SECRET'.repeat(5),workerEnabled:false})}),rejected);
 const invoke=createImagePreparationEnrollmentCiRegistrar(f.host,f.registrarSha,f.scopePath,f.scopeSha,()=>({status:0,stderr:'',stdout:JSON.stringify({...f.success,serviceId:randomUUID()})}));assert.throws(()=>invoke('reconcile',f.url.href));
});

test('independent SQL/file proof rejects mismatched request, epoch, scope, token and accepted receipt',()=>{
 const f=fixture(),proof=imagePreparationEnrollmentCiDatabaseProof(f.pending,f.rows,f.tokenBytes);assert.equal(proof.tokenHashMatches,true);assert.equal(proof.requestHash,f.success.requestHash);assert(!JSON.stringify(proof).includes(f.pending.token));
 for(const change of [r=>r.services[0].token_hash='0'.repeat(64),r=>r.services[0].company_id=randomUUID(),r=>r.services[0].sponsor_joined_at=r.services[0].sponsor_joined_at.replace(/123Z$/,'124Z'),r=>r.services[0].sponsor_role='admin',r=>r.services[0].revoked_at=new Date(),r=>r.projects[0].storage_binding_revision++,r=>r.projects[0].gateway_origin='https://other.example',r=>r.enrollments[0].request_hash='0'.repeat(64),r=>r.enrollments[0].identity.qualificationSha256='0'.repeat(64),r=>r.services.push(r.services[0]),r=>r.projects=[]]){const rows=structuredClone(f.rows);change(rows);assert.throws(()=>imagePreparationEnrollmentCiDatabaseProof(f.pending,rows,f.tokenBytes));}
 for(const change of [v=>v.token='ips_'+'y'.repeat(43),v=>v.configurationSha256='0'.repeat(64),v=>v.serviceId=randomUUID(),v=>v.expiresAt=new Date(Date.now()+100000).toISOString(),v=>v.extra=true]){const value=JSON.parse(f.tokenBytes);change(value);assert.throws(()=>imagePreparationEnrollmentCiDatabaseProof(f.pending,f.rows,json(value)));}
 assert.throws(()=>imagePreparationEnrollmentCiDatabaseProof({...f.pending,receiptBytes:Buffer.concat([f.pending.receiptBytes,Buffer.from(' ')])},f.rows,f.tokenBytes));
});

test('actual all-migrations seed agrees with the real gateway resolver, epoch and installed project order',async()=>{
 const db=await PGlite.create(),f=fixture();
 // Deliberately non-sorted host scope; the reviewed scope must retain that order.
 f.host.scope.projectIds=[randomUUID(),randomUUID()].sort().reverse();f.host.scope.gateways=f.host.scope.projectIds.map(projectId=>({projectId,origin:'https://imagepreparationci1-4190.proxy.runpod.net'}));
 try{
  for(const name of(await readdir('database')).filter(name=>/^\d.*\.sql$/.test(name)).sort())await db.exec(await readFile('database/'+name,'utf8'));
  const scope=await seedImagePreparationEnrollmentCiDatabase(db,f.host);assert.deepEqual(scope.projects.map(p=>p.projectId),f.host.scope.projectIds);
  const enroller=(await db.query(`SELECT role,to_char(joined_at AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS.US"Z"') AS epoch FROM memberships WHERE company_id=$1 AND user_id=$2`,[f.host.scope.companyId,scope.enrolledBy])).rows[0];
  assert.deepEqual(scope.enroller,{role:enroller.role,joinedAt:enroller.epoch});assert.equal(enroller.role,'owner');assert.match(scope.enroller.joinedAt,/\.\d{6}Z$/);
  const wrapped={query:async(sql,args)=>{const result=await db.query(sql,args);return {...result,rowCount:result.rows.length||result.affectedRows};}};
  for(const project of scope.projects){
   const gateway=await verifiedImagePreparationGateway(wrapped,f.host.scope.companyId,project.projectId);assert(gateway,'Synthetic gateway must pass the actual current resolver');
   assert.deepEqual(gateway,{origin:project.gateway.origin,expiresAt:project.gateway.expiresAt,bindingId:project.gateway.bindingId,provisionId:project.gateway.provisionId,configurationHash:project.gateway.configurationSha256});
   assert(Date.parse(project.gateway.expiresAt)>=Date.parse(f.host.scope.expiresAt));
   const storage=(await db.query('SELECT c.secret_envelope,b.revision,b.connection_id,c.revision AS connection_revision FROM project_storage_bindings b JOIN project_storage_connections c ON c.company_id=b.company_id AND c.id=b.connection_id WHERE b.company_id=$1 AND b.project_id=$2',[f.host.scope.companyId,project.projectId])).rows[0];
   assert.deepEqual(storage,{secret_envelope:{},revision:project.storageBindingRevision,connection_id:project.storageConnectionId,connection_revision:project.storageConnectionRevision});
  }
  assert.equal((await db.query('SELECT count(*)::int AS n FROM project_image_preparation_services')).rows[0].n,0);
  const project=scope.projects[0];await db.query("UPDATE trusted_service_provisions SET last_reconciled_at=clock_timestamp()-interval '121 seconds' WHERE id=$1",[project.gateway.provisionId]);assert.equal(await verifiedImagePreparationGateway(wrapped,f.host.scope.companyId,project.projectId),null);
 }finally{await db.close();}
});

test('compiled qualifier acceptance binds exact evidence and prior receipt CAS without credentials',()=>{
 const f=fixture(),path='/var/lib/coatria-image-preparation-worker/'+f.host.scope.serviceId+'/evidence/qualification-'+randomUUID()+'/host-evidence.json',evidence='d'.repeat(64),previous='e'.repeat(64),calls=[];
 const result={workerEnabled:false,enrolled:false,replayed:false,receipt:JSON.parse(f.pending.receiptBytes)};
 const run=(file,args,options)=>{calls.push({file,args,options});return {status:0,stderr:'',stdout:JSON.stringify(result)};};
 assert.deepEqual(acceptImagePreparationEnrollmentCiQualification(f.host,path,evidence,previous,run),result);const call=calls[0];
 assert.equal(call.file,f.host.release+'/runtime/node');assert.deepEqual(call.args,[f.host.release+'/qualifier/runtime.mjs','--accept-qualification','--host','/etc/coatria-image-preparation/'+f.host.scope.serviceId+'/host.json','--bundle',f.host.bundleSha256,'--evidence',path,'--sha256',evidence,'--previous',previous]);assert.equal(call.options.shell,false);assert.equal(call.options.input,undefined);assert.deepEqual(call.options.env,{PATH:'/usr/bin:/bin',LANG:'C',LC_ALL:'C'});
 for(const bad of [undefined,'not-a-hash'])assert.throws(()=>acceptImagePreparationEnrollmentCiQualification(f.host,path,evidence,bad,run));
 assert.throws(()=>acceptImagePreparationEnrollmentCiQualification(f.host,path.replace(f.host.scope.serviceId,randomUUID()),evidence,previous,run));assert.equal(calls.length,1);
 for(const value of [{...result,workerEnabled:true},{...result,replayed:true},{...result,enrolled:true},{...result,receipt:{kind:'coatria-reference-worker-qualification'}}])assert.throws(()=>acceptImagePreparationEnrollmentCiQualification(f.host,path,evidence,previous,()=>({status:0,stderr:'',stdout:JSON.stringify(value)})),rejected);
});

test('token witness delegates to installed worker reader only after clearing groups and dropping identity',()=>{
 const f=fixture(),calls=[],configurationSha256=f.pending.intent.configurationSha256;
 const reply={readable:true,uid:f.host.uid,gid:f.host.gid,tokenHashMatches:true,configurationSha256};
 const run=(file,args,options)=>{calls.push({file,args,options});return {status:0,stderr:'',stdout:JSON.stringify(reply)};};
 assert.deepEqual(readImagePreparationEnrollmentCiToken(f.host,f.pending,run),reply);const call=calls[0],payload=JSON.parse(call.options.input),code=call.args[2];
 assert.equal(call.file,f.host.release+'/runtime/node');assert.deepEqual(call.args.slice(0,2),['--input-type=module','-e']);assert.equal(call.options.shell,false);assert.deepEqual(call.options.env,{PATH:'/usr/bin:/bin',LANG:'C',LC_ALL:'C'});
 assert.deepEqual(Object.keys(payload).sort(),['configuration','configurationSha256','tokenHash']);assert.equal(payload.tokenHash,f.request.tokenHash);assert.equal(payload.configurationSha256,configurationSha256);assert.equal(payload.configuration.runtimePath,f.host.worker.path);assert(!JSON.stringify(call).includes(f.pending.token));
 // Inspect the executed fixed seam; the actual Linux job independently exercises this child.
 assert(code.indexOf('process.setgroups([])')<code.indexOf('process.setgid('));assert(code.indexOf('process.setgid(')<code.indexOf('process.setuid('));assert(code.indexOf('process.setuid(')<code.indexOf('await import('));assert(code.includes('module.readImagePreparationRunnerToken(i.configuration)'));
 for(const change of [{uid:0},{gid:0},{uid:f.host.uid+1},{tokenHashMatches:false},{configurationSha256:'0'.repeat(64)},{rawToken:f.pending.token}])assert.throws(()=>readImagePreparationEnrollmentCiToken(f.host,f.pending,()=>({status:0,stderr:'',stdout:JSON.stringify({...reply,...change})})),rejected);
 assert.throws(()=>readImagePreparationEnrollmentCiToken(f.host,f.pending,()=>({status:0,stderr:f.pending.token,stdout:JSON.stringify(reply)})),rejected);
});
