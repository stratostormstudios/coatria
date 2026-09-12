import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { readdir,readFile,stat } from 'node:fs/promises';
import { resolve } from 'node:path';
import { handleApi } from '../src/lib/api';
import { database, query } from '../src/lib/db';
import { AVATAR_CATALOG } from '../src/lib/avatar-catalog';
import { avatarAssetPath, handleAvatarRequest } from '../src/lib/avatar-assets';
import {OFFICE_CATALOG} from '../src/lib/office-catalog';
import {handleOfficeAssetRequest,officeAssetPath} from '../src/lib/office-assets';
import {hashToken} from '../src/lib/security';

const testDatabase=process.env.COATRIA_INTEGRATION_DATABASE_URL;
const useEmulator=process.env.COATRIA_TEST_EMULATOR==='1';
test('real database API: tenant isolation, invitations, independent approvals, personal vault, scoped credentials, connector metadata and talent',{skip:!testDatabase&&!useEmulator,timeout:90000},async()=>{
  process.env.DATABASE_URL=testDatabase;process.env.TRUST_PROXY='true';process.env.DATABASE_POOL_MAX='1';
  let stopEmulator:(()=>Promise<void>)|undefined;
  if(useEmulator) {
    const {PGlite}=await import('@electric-sql/pglite');const {PGLiteSocketServer}=await import('@electric-sql/pglite-socket');
    const db=await PGlite.create();for(const file of (await readdir(resolve('database'))).filter(x=>/^\d.*\.sql$/.test(x)).sort())await db.exec(await readFile(resolve('database',file),'utf8'));
    const server=new PGLiteSocketServer({db,host:'127.0.0.1',port:0,maxConnections:1});await server.start();
    process.env.DATABASE_URL=`postgresql://postgres:postgres@${server.getServerConn()}/postgres`;stopEmulator=async()=>{await server.stop();await db.close();};
  }
  const origin='http://localhost:4180';const run=randomUUID().slice(0,8);const createdUsers:string[]=[];const companies:string[]=[];
  type Client={cookie:string;userId:string;email:string;ip:string};
  let checks=0;
  async function call(client:Client|null,path:string,method='GET',data?:unknown,expected=200,token?:string,originOverride?:string) {
    const headers:Record<string,string>={Origin:originOverride??origin,'x-forwarded-for':client?.ip||`test-${run}`};
    if(client)headers.Cookie=client.cookie;if(data!==undefined)headers['Content-Type']='application/json';if(token)headers.Authorization=`Bearer ${token}`;
    const response=await handleApi(new Request(`${origin}/api/${path}`,{method,headers,...(data!==undefined?{body:JSON.stringify(data)}:{})}),path.split('/'));
    const payload=await response.json();assert.equal(response.status,expected,`${method} ${path}: ${JSON.stringify(payload)}`);checks++;return {data:payload,response};
  }
  async function signup(label:string) {
    const email=`${run}-${label}@example.test`;const value=await call(null,'auth/signup','POST',{name:label,email,password:'Integration password 123!'},201);
    const userId=value.data.user.id;createdUsers.push(userId);const cookie=value.response.headers.get('set-cookie')!.split(';')[0];
    assert(value.response.headers.get('set-cookie')!.includes('HttpOnly'));
    return {cookie,userId,email,ip:`test-${run}-${label}`};
  }
  try {
    const owner=await signup('Owner'),reviewer=await signup('Reviewer'),worker=await signup('Worker'),outsider=await signup('Outsider');
    const avatarRequest=(cookie?:string,headers:Record<string,string>={})=>new Request(`${origin}/api/avatars`,{headers:{Origin:origin,...(cookie?{Cookie:cookie}:{}),...headers}});
    const anonymousCatalog=await handleAvatarRequest(avatarRequest());assert.equal(anonymousCatalog.status,401);
    const anonymousModel=await handleAvatarRequest(avatarRequest(),AVATAR_CATALOG[0].id);assert.equal(anonymousModel.status,401);
    const anonymousPreview=await handleAvatarRequest(avatarRequest(),AVATAR_CATALOG[0].id,'preview');assert.equal(anonymousPreview.status,401);
    const catalog=await handleAvatarRequest(avatarRequest(owner.cookie));assert.equal(catalog.status,200);assert.deepEqual((await catalog.json()).avatars,AVATAR_CATALOG);
    const changedIdentity=await handleAvatarRequest(avatarRequest(owner.cookie,{'X-Coatria-User':outsider.userId}));assert.equal(changedIdentity.status,409);assert.equal((await changedIdentity.json()).code,'SESSION_CHANGED');
    for(const headers of [{'Sec-Fetch-Site':'cross-site'},{Origin:'https://outside.example'}] as Record<string,string>[])assert.equal((await handleAvatarRequest(avatarRequest(owner.cookie,headers))).status,403);
    for(const id of ['city-unlisted','../city-023','city-023/../../private','%2e%2e%2fprivate'])assert.equal((await handleAvatarRequest(avatarRequest(owner.cookie),id)).status,404);
    assert.equal((await handleAvatarRequest(avatarRequest(owner.cookie,{'X-Coatria-User':outsider.userId}),AVATAR_CATALOG[0].id,'preview')).status,409);
    assert.equal((await handleAvatarRequest(avatarRequest(owner.cookie,{'Sec-Fetch-Site':'cross-site'}),AVATAR_CATALOG[0].id,'preview')).status,403);
    assert.equal((await handleAvatarRequest(avatarRequest(owner.cookie),'../city-023','preview')).status,404);
    // CI has no licensed pack. Local imports must retain the same authenticated,
    // non-cacheable delivery contract without copying or replacing those files.
    const modelId=AVATAR_CATALOG[0].id;
    for(const kind of ['model','preview'] as const){
      let exists=false;try{exists=(await stat(avatarAssetPath(modelId,kind))).isFile();}catch(error){if((error as NodeJS.ErrnoException).code!=='ENOENT')throw error;}
      const asset=await handleAvatarRequest(avatarRequest(owner.cookie),modelId,kind);
      if(exists){assert.equal(asset.status,200);assert.equal(asset.headers.get('content-type'),kind==='preview'?'image/png':'model/gltf-binary');assert.equal(asset.headers.get('cache-control'),'private, no-store');assert.equal(asset.headers.get('cross-origin-resource-policy'),'same-origin');const bytes=Buffer.from(await asset.arrayBuffer());assert.equal(Number(asset.headers.get('content-length')),bytes.byteLength);if(kind==='model')assert.equal(bytes.readUInt32LE(0),0x46546c67);else assert.deepEqual(bytes.subarray(0,8),Buffer.from([137,80,78,71,13,10,26,10]));}
      else{assert.equal(asset.status,503);assert.equal((await asset.json()).code,'AVATAR_UNAVAILABLE');}
    }
    // Paid office objects use the same account and origin boundaries as avatars.
    assert.equal((await handleOfficeAssetRequest(avatarRequest())).status,401);
    assert.equal((await handleOfficeAssetRequest(avatarRequest(),'../private')).status,401);
    const officeCatalog=await handleOfficeAssetRequest(avatarRequest(owner.cookie));assert.equal(officeCatalog.status,200);assert.deepEqual((await officeCatalog.json()).assets,OFFICE_CATALOG);assert.equal(officeCatalog.headers.get('cache-control'),'private, no-store');
    assert.equal((await handleOfficeAssetRequest(avatarRequest(owner.cookie,{'X-Coatria-User':outsider.userId}))).status,409);
    for(const headers of [{'Sec-Fetch-Site':'cross-site'},{Origin:'https://outside.example'}] as Record<string,string>[])assert.equal((await handleOfficeAssetRequest(avatarRequest(owner.cookie,headers))).status,403);
    for(const id of ['unknown-office-object','../private','%2e%2e%2fprivate','https://example.com/object.glb'])assert.equal((await handleOfficeAssetRequest(avatarRequest(owner.cookie),id)).status,404);
    for(const kind of ['model','preview','plan'] as const){
      const id=OFFICE_CATALOG[0].id;
      assert.equal((await handleOfficeAssetRequest(avatarRequest(),id,kind)).status,401);
      assert.equal((await handleOfficeAssetRequest(avatarRequest(owner.cookie,{'X-Coatria-User':outsider.userId}),id,kind)).status,409);
      assert.equal((await handleOfficeAssetRequest(avatarRequest(owner.cookie,{'Sec-Fetch-Site':'cross-site'}),id,kind)).status,403);
      let exists=false;try{exists=(await stat(officeAssetPath(id,kind))).isFile();}catch(error){if((error as NodeJS.ErrnoException).code!=='ENOENT')throw error;}
      const asset=await handleOfficeAssetRequest(avatarRequest(owner.cookie),id,kind);
      if(exists){assert.equal(asset.status,200);assert.equal(asset.headers.get('content-type'),kind==='model'?'model/gltf-binary':'image/png');assert.equal(asset.headers.get('cache-control'),'private, no-store');assert.equal(asset.headers.get('cross-origin-resource-policy'),'same-origin');const bytes=Buffer.from(await asset.arrayBuffer());assert.equal(Number(asset.headers.get('content-length')),bytes.byteLength);assert.deepEqual(bytes,await readFile(officeAssetPath(id,kind)));assert.equal(asset.headers.get('content-disposition'),`inline; filename="${id}.${kind==='model'?'glb':kind==='plan'?'plan.png':'png'}"`);}
      else{assert.equal(asset.status,503);assert.equal((await asset.json()).code,'OFFICE_ASSET_UNAVAILABLE');}
      const key=hashToken(`office-${kind==='model'?'model':'preview'}:${owner.userId}`),limit=kind==='model'?240:360;
      await query('UPDATE rate_limits SET count=$2,expires_at=now()+interval \'1 minute\' WHERE key=$1',[key,limit]);assert.equal((await handleOfficeAssetRequest(avatarRequest(owner.cookie),id,kind)).status,429);await query('DELETE FROM rate_limits WHERE key=$1',[key]);
    }
    const companyA=(await call(owner,'companies','POST',{name:`Test ${run}`,slug:`test-${run}`,template:'studio'},201)).data.company;companies.push(companyA.id);
    const companyB=(await call(outsider,'companies','POST',{name:`Other ${run}`,slug:`other-${run}`,template:'blank'},201)).data.company;companies.push(companyB.id);
    const base=`companies/${companyA.id}`;
    // Saved identity belongs to the authenticated person and appears in every
    // membership/presence snapshot without modifying other people's profiles.
    const chosenAvatar=AVATAR_CATALOG[0].id;
    const ownerProfile={name:'Owner',roleTitle:'Director',avatarColor:'#abcdef'};
    assert.equal((await call(owner,'session')).data.user.avatarId,null);
    await call(null,'profile','PATCH',{...ownerProfile,avatarId:chosenAvatar},401);
    for(const avatarId of ['city-unlisted','../private/model','https://example.test/model.glb'])await call(owner,'profile','PATCH',{...ownerProfile,avatarId},400);
    await call(owner,'profile','PATCH',{...ownerProfile,avatarId:chosenAvatar,userId:outsider.userId},400);
    assert.equal((await call(owner,'profile','PATCH',{...ownerProfile,avatarId:chosenAvatar})).data.user.avatarId,chosenAvatar);
    assert.equal((await call(owner,'session')).data.user.avatarId,chosenAvatar);
    assert.equal((await call(null,'auth/login','POST',{email:owner.email,password:'Integration password 123!'})).data.user.avatarId,chosenAvatar);
    assert.equal((await query('SELECT avatar_id FROM users WHERE id=$1',[owner.userId])).rows[0].avatar_id,chosenAvatar);
    assert.equal((await call(outsider,'session')).data.user.avatarId,null);
    // A client that has not yet added avatar controls preserves the saved choice.
    assert.equal((await call(owner,'profile','PATCH',ownerProfile)).data.user.avatarId,chosenAvatar);
    await call(null,`${base}/workspace`,'GET',undefined,401);await call(outsider,`${base}/workspace`,'GET',undefined,404);
    const start=(await call(owner,`${base}/workspace`)).data;assert.equal(start.members.length,1);assert.equal(start.agents.length,0);assert.equal(start.tasks.length,0);assert.equal(start.rooms.length,4);assert.equal(start.layout.length,8);
    assert.equal(start.members[0].avatarId,chosenAvatar);
    const secondCompanyInvite=(await call(outsider,`companies/${companyB.id}/invitations`,'POST',{role:'member'},201)).data;
    await call(owner,'invitations/join','POST',{token:secondCompanyInvite.token});
    assert.equal((await call(outsider,`companies/${companyB.id}/workspace`)).data.members.find((m:{userId:string})=>m.userId===owner.userId).avatarId,chosenAvatar);
    const ownerPresence=(await call(owner,`${base}/presence`,'POST',{roomId:null,x:0,z:0,status:'available'})).data.presence;
    assert.equal(ownerPresence.find((p:{userId:string})=>p.userId===owner.userId).avatarId,chosenAvatar);
    await query('DELETE FROM presence WHERE company_id=$1 AND user_id=$2',[companyA.id,owner.userId]);
    assert.equal((await call(owner,'profile','PATCH',{...ownerProfile,avatarId:null})).data.user.avatarId,null);
    assert.equal((await call(owner,'session')).data.user.avatarId,null);
    await call(owner,`${base}/presence`,'POST',{roomId:null,x:0,z:0,status:'available'},403,undefined,'https://attacker.example');
    for(const [client,role]of [[reviewer,'admin'],[worker,'member']]as const) {
      const invite=(await call(owner,`${base}/invitations`,'POST',{role},201)).data;
      await call(client,'invitations/join','POST',{token:invite.token});
      await call(outsider,'invitations/join','POST',{token:invite.token},400);
    }
    await call(worker,`${base}/rooms`,'POST',{name:'Forbidden',kind:'focus',capacity:2},403);
    await call(owner,`${base}/leave`,'POST',{},409);
    const foreignRoom=(await call(outsider,`companies/${companyB.id}/rooms`,'POST',{name:'Private',kind:'focus',capacity:2},201)).data.room;
    await call(worker,`${base}/presence`,'POST',{roomId:foreignRoom.id,x:0,z:0,status:'available'},400);
    await call(worker,`${base}/presence`,'POST',{roomId:null,x:25,z:0,status:'available'},400);
    const present=(await call(worker,`${base}/presence`,'POST',{roomId:start.rooms[0].id,x:1,z:2,status:'focus'})).data.presence;assert.equal(present[0].userId,worker.userId);
    await query("UPDATE presence SET updated_at=now()-interval '46 seconds' WHERE company_id=$1",[companyA.id]);assert.equal((await call(owner,`${base}/presence`)).data.presence.length,0);
    const chat=(await call(worker,`${base}/messages`,'POST',{body:'<script>still plain text</script>'},201)).data.message;assert.equal(chat.body,'<script>still plain text</script>');
    await call(worker,`${base}/messages`,'POST',{roomId:foreignRoom.id,body:'No leak'},400);
    const task=(await call(owner,`${base}/tasks`,'POST',{title:'Review independently',description:'A real output',assigneeId:worker.userId},201)).data.task;
    await call(outsider,`companies/${companyB.id}/tasks/${task.id}`,'PATCH',{status:'doing'},404);
    await call(worker,`${base}/tasks/${task.id}`,'PATCH',{status:'review',submissionUrl:'https://example.test/output',assigneeId:worker.userId,reviewNote:''});
    await call(worker,`${base}/tasks/${task.id}`,'PATCH',{status:'done'},403);
    await call(owner,`${base}/tasks/${task.id}`,'PATCH',{status:'done',reviewNote:'Reviewed the delivered artifact.'});
    await call(owner,`${base}/tasks/${task.id}`,'PATCH',{title:'Alter accepted work'},409);
    const skill=(await call(worker,'vault','POST',{title:'Private skill',description:'Employee knowledge',content:'Personal technique only'},201)).data.skill;
    assert.equal((await call(owner,'vault')).data.skills.length,0);
    await call(owner,`vault/${skill.id}`,'PATCH',{title:'Steal',description:'',content:'No'},404);
    await call(worker,`vault/${skill.id}`,'PATCH',{title:'Private skill',description:'Version two',content:'A refined technique'});
    const exported=(await call(worker,'vault/export')).data;assert.equal(exported.skills[0].version,2);assert.equal(exported.versions.length,2);assert.equal(exported.versions[0].content,'Personal technique only');
    const agent=(await call(owner,`${base}/agents`,'POST',{name:'Test agent',harness:'custom',description:'Scoped API test'},201)).data;
    const agentTask=(await call(worker,`${base}/tasks`,'POST',{title:'Agent output',description:'Submit a report'},201)).data.task;
    await call(null,'agent/work','GET',undefined,410,agent.token);
    await call(null,'agent/report','POST',{taskId:agentTask.id,summary:'No implicit authority',tokensUsed:250},410,agent.token);
    await call(owner,`${base}/agents/${agent.agent.id}`,'PATCH',{invocationAccess:'members',capabilities:['workspace.read','tasks.write']});
    const agentRun=(await call(worker,`${base}/conversations/commons/runs`,'POST',{clientId:randomUUID(),agentId:agent.agent.id,prompt:'Submit the requested task for independent review.'},201)).data.run;
    const lease=(await call(null,'agent/runs/claim','POST',{workerId:'integration-worker',claimId:randomUUID()},200,agent.token)).data;
    assert.equal(lease.run.id,agentRun.id);
    const tool=async(name:string,args:unknown)=>(await call(null,`agent/tools/${name}`,'POST',{runId:agentRun.id,leaseToken:lease.leaseToken,requestId:randomUUID(),arguments:args},200,agent.token)).data.result;
    const agentWork=await tool('tasks_list',{});assert(agentWork.items.some((x:{id:string})=>x.id===agentTask.id));assert(!JSON.stringify(await tool('workspace_get',{})).includes('Personal technique'));
    const reserved=await tool('tasks_claim',{taskId:agentTask.id,revision:1});
    await tool('tasks_submit',{taskId:agentTask.id,revision:reserved.revision,summary:'Actual report',tokensUsed:250});
    const runDetail=(await call(worker,`${base}/agent-runs/${agentRun.id}`)).data;assert.deepEqual(runDetail.actions.map((action:{tool:string})=>action.tool),['tasks_claim','tasks_submit']);assert(runDetail.actions.every((action:Record<string,unknown>)=>Object.keys(action).sort().join(',')==='createdAt,requestId,tool'));
    await call(owner,`${base}/tasks/${agentTask.id}`,'PATCH',{status:'done'},403);
    const reported=(await call(owner,`${base}/workspace`)).data.tasks.find((x:{id:string})=>x.id===agentTask.id);assert.equal(reported.submissionSummary,'Actual report');
    await call(reviewer,`${base}/tasks/${agentTask.id}`,'PATCH',{status:'done',reviewNote:'Independent review.'});
    await call(owner,`${base}/agents/${agent.agent.id}`,'PATCH',{status:'paused'});await call(null,'agent/work','GET',undefined,401,agent.token);
    await call(owner,`${base}/agents/${agent.agent.id}`,'PATCH',{status:'revoked'});await call(owner,`${base}/agents/${agent.agent.id}`,'PATCH',{status:'active'},409);
    const drive=(await call(owner,`${base}/drives`,'POST',{name:'Local media',kind:'byo',description:'Metadata only'},201)).data;
    const config=(await call(null,'connector/config','GET',undefined,200,drive.token)).data;assert.equal(config.originalsUploaded,false);
    await call(null,'connector/heartbeat','POST',{files:[{path:'../private.mov',size:10,modifiedAt:new Date().toISOString()}],status:'online'},400,drive.token);
    await call(null,'connector/heartbeat','POST',{files:[{path:'Day 1/take.mov',size:123456789,modifiedAt:new Date().toISOString()}],status:'online'},200,drive.token);
    const files=(await call(worker,`${base}/drives/${drive.drive.id}/files`)).data.files;assert.equal(files[0].path,'Day 1/take.mov');assert.equal(files[0].size,123456789);
    await call(outsider,`companies/${companyB.id}/drives/${drive.drive.id}/files`,'GET',undefined,404);
    await call(owner,`${base}/drives/${drive.drive.id}`,'PATCH',{status:'revoked'});await call(null,'connector/config','GET',undefined,401,drive.token);
    const opening=(await call(owner,`${base}/openings`,'POST',{title:'Editor',description:'Help us edit footage',type:'human',compensation:'paid',budget:'Discuss scope'},201)).data.opening;
    assert(!(await call(null,'opportunities')).data.openings.some((x:{id:string})=>x.id===opening.id));
    await call(outsider,`opportunities/${opening.id}/apply`,'POST',{message:'I can help'},404);
    await call(owner,`${base}/openings/${opening.id}`,'PATCH',{status:'published'});
    const application=(await call(outsider,`opportunities/${opening.id}/apply`,'POST',{message:'I can help'},201)).data.application;
    await call(outsider,`opportunities/${opening.id}/apply`,'POST',{message:'Duplicate'},409);
    assert.equal((await call(worker,`${base}/workspace`)).data.applications.length,0);
    const accepted=(await call(owner,`${base}/applications/${application.id}`,'PATCH',{status:'accepted'})).data;assert(accepted.invitation.token);
    await call(outsider,`${base}/workspace`,'GET',undefined,404);
    await call(outsider,'invitations/join','POST',{token:accepted.invitation.token});
    await call(owner,`${base}/members/${worker.userId}`,'PATCH',{role:'removed'});await call(worker,`${base}/workspace`,'GET',undefined,404);
    assert.equal((await call(worker,'vault')).data.skills[0].content,'A refined technique');
    await call(reviewer,`${base}/ownership`,'POST',{userId:outsider.userId},403);
    await call(owner,`${base}/ownership`,'POST',{userId:worker.userId},400);
    await call(owner,`${base}/ownership`,'POST',{userId:reviewer.userId});
    const transfer=(await call(reviewer,`${base}/workspace`)).data;assert.equal(transfer.company.role,'owner');assert.equal(transfer.members.find((m:{userId:string})=>m.userId===owner.userId).role,'admin');
    await call(owner,`${base}/leave`,'POST',{});await call(owner,`${base}/workspace`,'GET',undefined,404);
    await call(worker,'auth/password','PATCH',{currentPassword:'wrong password',newPassword:'Replacement password 123!'},403);
    await call(worker,'auth/password','PATCH',{currentPassword:'Integration password 123!',newPassword:'short'},400);
    await call(worker,'auth/password','PATCH',{currentPassword:'Integration password 123!',newPassword:'Replacement password 123!'});
    assert.equal((await call(worker,'session')).data.user,null);
    await call(null,'auth/login','POST',{email:worker.email,password:'Integration password 123!'},401);
    const login=await call(null,'auth/login','POST',{email:worker.email,password:'Replacement password 123!'});worker.cookie=login.response.headers.get('set-cookie')!.split(';')[0];
    await call(worker,'auth/logout','POST',{});assert.equal((await call(worker,'session')).data.user,null);
    assert(checks>=65);console.log(`Validated ${checks} real database API responses.`);
  } finally {
    if(companies.length){await query('DELETE FROM applications WHERE company_id=ANY($1::uuid[])',[companies]);await query('DELETE FROM companies WHERE id=ANY($1::uuid[])',[companies]);}
    if(createdUsers.length)await query('DELETE FROM users WHERE id=ANY($1::uuid[])',[createdUsers]);
    await database().end();
    await stopEmulator?.();
  }
});
