import {createHash} from 'node:crypto';
import {test,expect,type Page,type Route} from '@playwright/test';
import {generatedFixture,mockGenerated,ids,uuid,date} from './studio-generated-fixture';
import type {HiggsfieldReference,HiggsfieldReferenceVersion} from '../../src/lib/higgsfield-references-protocol';

const png=Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR4nGPoXdjyHwAGIwKyeWvUQwAAAABJRU5ErkJggg==','base64'),sha256=createHash('sha256').update(png).digest('hex');
const proxy:HiggsfieldReferenceVersion={versionId:uuid(101),fileId:uuid(102),name:'approved-product.png',version:2,bytes:png.length,sha256,contentType:'image/png'};
const oldProxy={...proxy,versionId:uuid(103),version:1},source={...proxy,versionId:uuid(104),fileId:uuid(105),name:'private-original.exr',bytes:900_000_000,contentType:'image/x-exr'};
function fixture(){
 const app=generatedFixture();app.detail.workItems[0].humanId=ids.user;
 const inspection={descriptor:{kind:'image' as const,format:'png' as const,contentType:'image/png',bytes:png.length,sha256,verification:'full_decode' as const,inspectionVersion:1 as const,width:1,height:1,codec:'png',color:{space:null,primaries:null,transfer:null,range:null}},profileSha256:'d'.repeat(64),inspectionHash:'e'.repeat(64),inspectedAt:date};
 const reference:HiggsfieldReference={id:uuid(106),projectId:ids.project,workItemId:ids.work,projectRevision:7,taskRevision:1,role:'image',purpose:'Approved product shape',status:'awaiting_approval',revision:2,requestHash:'f'.repeat(64),proxy,source,storageConnectionId:ids.storage,storageConnectionRevision:1,bindingId:ids.binding,bindingRevision:1,providerConnectionId:uuid(107),providerConnectionRevision:1,inspection,proposedBy:ids.user,proposedAgentId:null,createdAt:date,approvedBy:null,approvedAt:null,expiresAt:null,approvalHash:null,revokedAt:null,diagnosticCode:null,providerConfirmed:false,originalUploaded:false,bytesSharedUnchanged:true,metadataRemoved:false};
 return {app,reference,references:[reference],enabled:true,preview:true,wrongHash:false,corruptBytes:false,reads:[] as URL[],writes:[] as {path:string;body:any}[],handler:undefined as ((route:Route,url:URL)=>Promise<boolean>)|undefined};
}
function processing(state:ReturnType<typeof fixture>){return {enabled:state.enabled,code:state.enabled?'READY':'WORKER_UNAVAILABLE',message:state.enabled?'A qualified reference worker is available.':'Reference processing is unavailable. No qualified worker is active.',expiresAt:new Date(Date.now()+600_000).toISOString(),qualificationSha256:'a'.repeat(64),catalogSha256:'b'.repeat(64)};}
async function mock(page:Page,state:ReturnType<typeof fixture>){
 const availability=()=>processing(state);
 state.app.handler=async(route,url)=>{
  const path=url.pathname,method=route.request().method();state.reads.push(url);if(method!=='GET')state.writes.push({path,body:route.request().postDataJSON()});if(await state.handler?.(route,url))return true;let data:unknown;
  if(path==='/api/reference-fixture-preview'){expect(route.request().headers().authorization).toBe('Bearer synthetic_reference_access');await route.fulfill({body:state.corruptBytes?Buffer.from(png.map((value,index)=>index===png.length-1?value^1:value)):png,headers:{'Content-Type':'image/png','Content-Length':String(png.length)}});return true;}
  if(path.endsWith('/files'))data={binding:{id:ids.binding,projectId:ids.project,revision:1,connectionId:ids.storage,connection:{id:ids.storage,status:'configured',revision:1,name:'Fixture volume'}},items:[proxy,source].map(value=>({kind:'file',id:value.fileId,name:value.name,parentId:null,createdAt:date,latestVersion:{id:value.versionId,version:value.version,bytes:value.bytes,sha256:value.sha256,contentType:value.contentType,verified:true}})),breadcrumbs:[],page:{hasMore:false,nextAfter:null},transfers:state.preview?{available:true,gatewayOrigin:url.origin,maxFileBytes:10*1024**2,partBytes:1024}:{available:false,code:'STORAGE_GATEWAY_UNAVAILABLE',message:'No authenticated preview gateway is available.'}};
  else if(path.endsWith('/references/candidates')){const original=url.searchParams.get('fileId')===source.fileId;data={versions:original?[source]:url.searchParams.has('after')?[proxy,oldProxy]:[proxy],hasMore:!original&&!url.searchParams.has('after'),nextAfter:original||url.searchParams.has('after')?null:proxy.versionId};}
  else if(path.endsWith('/higgsfield/references')){
   if(method==='POST'){const body=route.request().postDataJSON();state.reference={...state.reference,status:'proposed',revision:1,inspection:null,proxy:body.proxyVersionId===oldProxy.versionId?oldProxy:proxy,source:body.sourceVersionId?source:null,workItemId:body.workItemId,role:body.role,purpose:body.purpose};state.references=[state.reference];data={reference:state.reference,processing:availability()};}
   else data={references:state.references,hasMore:false,nextAfter:null,processing:availability()};
  }else if(path.endsWith('/references/'+state.reference.id))data={reference:state.reference,processing:availability()};
  else if(path.endsWith('/references/'+state.reference.id+'/approve')){state.reference={...state.reference,status:'queued',revision:3,approvedBy:ids.user,approvedAt:new Date().toISOString(),expiresAt:new Date(Date.now()+30*60_000).toISOString(),approvalHash:'a'.repeat(64)};state.references=[state.reference];data={reference:state.reference,processing:availability()};}
  else if(path.endsWith('/references/'+state.reference.id+'/revoke')){state.reference={...state.reference,status:'revoked',revision:state.reference.revision+1,revokedAt:new Date().toISOString()};state.references=[state.reference];data={reference:state.reference,processing:availability()};}
  else if(path.endsWith('/versions/'+proxy.versionId+'/access'))data={access:{url:url.origin+'/api/reference-fixture-preview',headers:{Authorization:'Bearer synthetic_reference_access'},expiresAt:new Date(Date.now()+60_000).toISOString(),bytes:png.length,sha256:state.wrongHash?'0'.repeat(64):sha256,contentType:'image/png',name:proxy.name}};
  else if(path.endsWith('/higgsfield/requests')&&method==='POST')data={request:{id:ids.request},replayed:false};
  else return false;
  await route.fulfill({json:data});return true;
 };
 await mockGenerated(page,state.app);
}
async function open(page:Page){await page.goto('/#studio');await page.getByRole('button').filter({has:page.getByRole('heading',{name:'Image campaign',exact:true})}).click();await page.getByRole('tab',{name:'Generations & references',exact:true}).click();return page.getByRole('region',{name:'Managed Higgsfield references',exact:true});}
test.beforeEach(({baseURL})=>test.skip(!baseURL||!['localhost','127.0.0.1'].includes(new URL(baseURL).hostname),'Use local fixture origin.'));

test('exact older proxy version and optional private original are proposed separately without sharing bytes',async({page})=>{
 const state=fixture();state.references=[];await mock(page,state);const panel=await open(page);await panel.getByRole('button',{name:'Choose prepared image',exact:true}).click();let picker=panel.getByRole('region',{name:'Choose prepared reference image',exact:true});await picker.getByRole('button',{name:'Choose version of '+proxy.name}).click();await picker.getByRole('button',{name:'Load more file versions'}).click();await expect(picker.getByRole('button',{name:'Use version 2',exact:true})).toHaveCount(1);await picker.getByRole('button',{name:'Use version 1',exact:true}).click();await panel.getByRole('button',{name:'Link original for provenance (optional)',exact:true}).click();picker=panel.getByRole('region',{name:'Link original source version',exact:true});await picker.getByRole('button',{name:'Choose version of '+source.name}).click();await picker.getByRole('button',{name:'Use version 2',exact:true}).click();await panel.getByLabel('Reference production task',{exact:true}).selectOption(ids.work);await panel.getByLabel('Reference purpose',{exact:true}).fill('Product shape only');await panel.getByRole('button',{name:'Prepare reference for inspection'}).click();await expect(panel).toContainText('Waiting for image inspection');const writes=state.writes.filter(value=>value.path.includes('/higgsfield/references'));expect(writes).toHaveLength(1);expect(writes[0].body).toMatchObject({projectId:ids.project,projectRevision:7,workItemId:ids.work,proxyVersionId:oldProxy.versionId,proxySha256:sha256,proxyBytes:png.length,sourceVersionId:source.versionId,role:'image',purpose:'Product shape only'});expect(state.writes.some(value=>value.path.endsWith('/access')||value.path.endsWith('/approve'))).toBe(false);
});

test('administrator previews exact bytes then separately consents to unchanged metadata, rights and destination',async({page},testInfo)=>{
 const state=fixture();await mock(page,state);const panel=await open(page);await panel.getByRole('button',{name:'Review reference details'}).click();const review=panel.getByRole('region',{name:'Review reference sharing'}),approve=review.getByRole('button',{name:'Approve exact reference sharing'});await expect(approve).toBeDisabled();await expect(review.getByRole('checkbox').first()).toBeDisabled();await review.getByRole('button',{name:'Preview exact prepared image'}).click();await expect(review.getByRole('img')).toBeVisible();await expect(review).toContainText('Exact storage bytes checked');await review.getByLabel('Reference permission expires after',{exact:true}).selectOption('10');for(const box of await review.getByRole('checkbox').all())await box.check();await expect(approve).toBeEnabled();await page.setViewportSize({width:390,height:844});await review.scrollIntoViewIfNeeded();expect(await page.evaluate(()=>document.documentElement.scrollWidth)).toBeLessThanOrEqual(391);await review.screenshot({path:testInfo.outputPath('reference-sharing-mobile.png')});await approve.click();await expect(panel).toContainText('Approved · waiting for worker');const approval=state.writes.find(value=>value.path.endsWith('/approve'))!;expect(approval.body).toMatchObject({revision:2,requestHash:'f'.repeat(64),inspectionHash:'e'.repeat(64),expiresInMinutes:10,referenceSharingConsent:true,preparedProxyConsent:true,rightsConsent:true,allBytesConsent:true});expect(await panel.innerText()).not.toContain('synthetic_reference_access');expect(state.writes.filter(value=>value.path.endsWith('/access'))).toHaveLength(1);expect(state.writes.some(value=>value.path.includes(source.versionId))).toBe(false);
});

test('missing worker, unavailable preview and stale review never give implicit permission',async({page})=>{
 const state=fixture();state.enabled=false;await mock(page,state);const panel=await open(page);await panel.getByRole('button',{name:'Review reference details'}).click();await expect(panel).toContainText('No qualified worker is active');await expect(panel.getByRole('button',{name:'Approve exact reference sharing'})).toBeDisabled();state.enabled=true;state.preview=false;await panel.getByRole('button',{name:'Refresh references'}).click();await panel.getByRole('button',{name:'Review reference details'}).click();await panel.getByRole('button',{name:'Preview exact prepared image'}).click();await expect(panel.getByRole('alert')).toContainText('No authenticated preview gateway');await expect(panel.getByRole('checkbox').first()).toBeDisabled();state.preview=true;await panel.getByRole('button',{name:'Preview exact prepared image'}).click();await expect(panel.getByRole('img')).toBeVisible();for(const box of await panel.getByRole('checkbox').all())await box.check();state.handler=async(route,url)=>{if(!url.pathname.endsWith('/approve'))return false;await route.fulfill({status:409,json:{error:'The reviewed reference changed. Refresh before approving.'}});return true;};await panel.getByRole('button',{name:'Approve exact reference sharing'}).click();await expect(panel.getByRole('alert')).toContainText('reference changed');await expect(panel.getByRole('checkbox').first()).not.toBeChecked();await expect(panel.getByRole('button',{name:'Approve exact reference sharing'})).toBeDisabled();expect(state.writes.filter(value=>value.path.endsWith('/approve'))).toHaveLength(1);
});

test('wrong preview hash blocks access and member cannot approve or revoke sharing',async({page})=>{
 const state=fixture();state.wrongHash=true;await mock(page,state);const panel=await open(page);await panel.getByRole('button',{name:'Review reference details'}).click();await panel.getByRole('button',{name:'Preview exact prepared image'}).click();await expect(panel.getByRole('alert')).toContainText('does not match this exact version');await expect(panel.getByRole('img')).toHaveCount(0);await expect(panel.getByRole('checkbox').first()).toBeDisabled();expect(state.reads.some(url=>url.pathname==='/api/reference-fixture-preview')).toBe(false);state.app.company.role='member';await page.reload();await page.getByRole('button').filter({has:page.getByRole('heading',{name:'Image campaign',exact:true})}).click();await page.getByRole('tab',{name:'Generations & references',exact:true}).click();await panel.getByRole('button',{name:'Review reference details'}).click();await expect(panel).toContainText('A human administrator must preview and approve');await expect(panel.getByRole('button',{name:'Approve exact reference sharing'})).toHaveCount(0);await expect(panel.getByRole('button',{name:'Revoke reference permission'})).toHaveCount(0);
});

test('only current confirmed internal references enter a new generation, and revocation clears selection',async({page})=>{
 const state=fixture();state.reference={...state.reference,status:'confirmed',providerConfirmed:true,expiresAt:new Date(Date.now()+60_000).toISOString()};state.references=[state.reference,{...state.reference,id:uuid(109),status:'uncertain',providerConfirmed:false,proxy:{...proxy,name:'uncertain.png'}},{...state.reference,id:uuid(110),expiresAt:new Date(Date.now()-60_000).toISOString(),proxy:{...proxy,name:'expired.png'}}];await mock(page,state);const panel=await open(page);await page.getByLabel('Generation task',{exact:true}).selectOption(ids.work);await expect(panel.getByRole('checkbox')).toHaveCount(1);await expect(panel).toContainText('Do not create a replacement');await panel.getByRole('checkbox').check();await page.getByLabel('Production purpose',{exact:true}).fill('Approved test');await page.getByLabel('Exact tool arguments',{exact:true}).fill(JSON.stringify({params:{model:'fixture',prompt:'Approved test'}}));await page.getByRole('button',{name:'Prepare request',exact:true}).click();expect(state.writes.find(value=>value.path.endsWith('/higgsfield/requests'))?.body).toMatchObject({referenceIds:[state.reference.id],arguments:{params:{model:'fixture',prompt:'Approved test'}}});await panel.getByRole('article',{name:'Reference '+proxy.name,exact:true}).getByRole('button',{name:'Revoke reference permission'}).click();await expect(panel).toContainText('Bytes already disclosed may remain');await expect(panel.getByRole('checkbox')).toHaveCount(0);expect(state.writes.some(value=>value.path.endsWith('/execute'))).toBe(false);
});

test('the complete preview hash is checked and a body mismatch cannot authorize sharing',async({page})=>{
 const state=fixture();state.corruptBytes=true;await mock(page,state);const panel=await open(page);await panel.getByRole('button',{name:'Review reference details'}).click();await panel.getByRole('button',{name:'Preview exact prepared image'}).click();await expect(panel.getByRole('alert')).toContainText('preview bytes differ');await expect(panel.getByRole('img')).toHaveCount(0);await expect(panel.getByRole('checkbox').first()).toBeDisabled();expect(state.reads.filter(url=>url.pathname==='/api/reference-fixture-preview')).toHaveLength(1);expect(state.writes.filter(value=>value.path.endsWith('/approve'))).toHaveLength(0);
});

test('selected reference expiry clears the generation selection without a provider request',async({page})=>{
 await page.clock.install();const state=fixture();state.reference={...state.reference,status:'confirmed',providerConfirmed:true,expiresAt:new Date(Date.now()+60_000).toISOString()};state.references=[state.reference];await mock(page,state);const panel=await open(page);await page.getByLabel('Generation task',{exact:true}).selectOption(ids.work);await panel.getByRole('checkbox').check();await expect(page.getByText('1 confirmed managed reference selected for this new request. Saved requests are unchanged.',{exact:true})).toBeVisible();await page.clock.fastForward(61_000);await expect(panel.getByRole('checkbox')).toHaveCount(0);await expect(page.getByText('1 confirmed managed reference selected for this new request. Saved requests are unchanged.',{exact:true})).toHaveCount(0);expect(state.writes.filter(value=>value.path.includes('/higgsfield/'))).toHaveLength(0);
});

test('a revision bump blocks old sharing approval while confirmed selections require server revalidation',async({page})=>{
 const state=fixture();state.app.detail.project.revision=8;const confirmed={...state.reference,id:uuid(111),status:'confirmed' as const,providerConfirmed:true,expiresAt:new Date(Date.now()+60_000).toISOString(),proxy:{...proxy,name:'old-approved.png'}};state.references=[state.reference,confirmed];
 state.handler=async(route,url)=>{if(!url.pathname.endsWith('/higgsfield/requests')||route.request().method()!=='POST')return false;await route.fulfill({status:409,json:{error:'The project content changed after this reference was approved. Prepare a new reference.'}});return true;};
 await mock(page,state);const panel=await open(page);await page.getByLabel('Generation task',{exact:true}).selectOption(ids.work);await panel.getByRole('article',{name:'Reference '+proxy.name,exact:true}).getByRole('button',{name:'Review reference details'}).click();const review=panel.getByRole('region',{name:'Review reference sharing'});await expect(review).toContainText('project changed after this reference');await expect(review.getByRole('button',{name:'Approve exact reference sharing'})).toBeDisabled();for(const box of await review.getByRole('checkbox').all())await expect(box).toBeDisabled();
 await expect(panel).toContainText('Selection does not confirm compatibility');const selection=panel.getByRole('checkbox',{name:/Use old-approved/});await expect(selection).toBeEnabled();await selection.check();await page.getByLabel('Production purpose',{exact:true}).fill('Reuse accepted reference');await page.getByLabel('Exact tool arguments',{exact:true}).fill(JSON.stringify({params:{model:'fixture',prompt:'Reuse accepted reference'}}));await page.getByRole('button',{name:'Prepare request',exact:true}).click();await expect(page.getByRole('alert').filter({hasText:'project content changed'})).toBeVisible();expect(state.writes.find(value=>value.path.endsWith('/higgsfield/requests'))?.body.referenceIds).toEqual([confirmed.id]);expect(state.writes.filter(value=>value.path.endsWith('/approve')||value.path.endsWith('/execute'))).toHaveLength(0);
});

// Synthetic metadata fixtures exercise consent and request identity only. They do
// not inspect media, grant a worker lease or make a provider request.
function inspectionFixture(){
 const state=fixture();
 state.reference={...state.reference,status:'proposed',revision:1,inspection:null,proposedAgentId:uuid(120),referenceGenerationHandoff:{id:uuid(121),handoffSha256:'7'.repeat(64),inspectionAdoption:null}};
 state.references=[state.reference];
 return state;
}
function inspectionResponse(state:ReturnType<typeof fixture>,expiresInMinutes=30){
 const handoff=state.reference.referenceGenerationHandoff!;
 return {reference:{...state.reference,referenceGenerationHandoff:{...handoff,inspectionAdoption:{id:uuid(122),approvedBy:ids.user,approvedAt:new Date().toISOString(),expiresAt:new Date(Date.now()+expiresInMinutes*60_000).toISOString(),approvalHash:'8'.repeat(64),maximumAttempts:1 as const}}},processing:processing(state)};
}
async function openInspection(page:Page){
 const panel=await open(page);
 await panel.getByRole('button',{name:'Review reference details'}).click();
 const consent=panel.getByRole('region',{name:'Generation reference inspection consent',exact:true});
 await expect(consent).toBeVisible();
 return {panel,consent,authorize:consent.getByRole('button',{name:'Authorize one image inspection',exact:true}),checkbox:consent.getByRole('checkbox')};
}
const referenceWrites=(state:ReturnType<typeof fixture>)=>state.writes.filter(value=>value.path.includes('/higgsfield/')||value.path.endsWith('/access'));

test('generation inspection adoption requires explicit finite consent and sends only one exact adoption request',async({page})=>{
 const state=inspectionFixture();
 state.handler=async(route,url)=>{
  if(!url.pathname.endsWith('/adopt-generation-inspection'))return false;
  const response=inspectionResponse(state,route.request().postDataJSON().expiresInMinutes);
  state.reference=response.reference;state.references=[state.reference];
  await route.fulfill({json:response});return true;
 };
 await mock(page,state);
 const {panel,consent,authorize,checkbox}=await openInspection(page);
 await expect(checkbox).toHaveCount(1);
 await expect(checkbox).not.toBeChecked();await expect(authorize).toBeDisabled();
 expect(referenceWrites(state)).toHaveLength(0);
 await checkbox.check();await expect(authorize).toBeEnabled();
 await consent.getByLabel('Generation reference inspection permission',{exact:true}).selectOption('10');
 await expect(checkbox).not.toBeChecked();await expect(authorize).toBeDisabled();
 await checkbox.check();await authorize.click();
 await expect(consent).toContainText('Inspection permission recorded');
 await expect(panel).toContainText('Sharing and generation still require their own approvals.');
 await expect(authorize).toHaveCount(0);
 await expect(panel.getByRole('button',{name:'Approve exact reference sharing'})).toHaveCount(0);
 const writes=referenceWrites(state);expect(writes).toHaveLength(1);
 expect(writes[0].path).toBe(`/api/companies/${ids.company}/higgsfield/references/${state.reference.id}/adopt-generation-inspection`);
 expect(writes[0].body).toEqual({referenceRevision:1,requestHash:'f'.repeat(64),handoffSha256:'7'.repeat(64),expiresInMinutes:10,inspectionConsent:true,clientId:expect.stringMatching(/^[0-9a-f-]{36}$/)});
 expect(state.reads.some(url=>url.pathname==='/api/reference-fixture-preview')).toBe(false);
 expect(state.app.unexpected).toEqual([]);
});

test('generation inspection adoption retries an uncertain HTTP result with the same exact client ID',async({page})=>{
 const state=inspectionFixture();let attempts=0;
 const saved=inspectionResponse(state);
 state.handler=async(route,url)=>{
  if(!url.pathname.endsWith('/adopt-generation-inspection'))return false;
  // Model a committed adoption whose HTTP response was lost. The second request
  // returns that same receipt; it must not represent another inspection attempt.
  if(++attempts===1){await route.fulfill({status:503,json:{error:'The inspection response was not confirmed. Retry the same request.'}});return true;}
  await route.fulfill({json:saved});return true;
 };
 await mock(page,state);
 const {panel,consent,authorize,checkbox}=await openInspection(page);
 await expect(checkbox).toHaveCount(1);await checkbox.check();await authorize.click();
 await expect(panel.getByRole('alert')).toContainText('response was not confirmed');
 await expect(checkbox).not.toBeChecked();await expect(authorize).toBeDisabled();
 await checkbox.check();await authorize.click();
 await expect(consent).toContainText('Inspection permission recorded');
 const writes=referenceWrites(state);expect(writes).toHaveLength(2);
 expect(writes.every(value=>value.path.endsWith('/adopt-generation-inspection'))).toBe(true);
 expect(writes[1].body).toEqual(writes[0].body);
 expect(writes[0].body.clientId).toMatch(/^[0-9a-f-]{36}$/);
 expect(state.app.unexpected).toEqual([]);
});

for(const changed of ['id','handoffSha256'] as const)test(`generation inspection adoption rejects a changed handoff ${changed} in the response`,async({page})=>{
 const state=inspectionFixture();
 state.handler=async(route,url)=>{
  if(!url.pathname.endsWith('/adopt-generation-inspection'))return false;
  const response=inspectionResponse(state);
  response.reference.referenceGenerationHandoff[changed]=changed==='id'?uuid(123):'9'.repeat(64);
  await route.fulfill({json:response});return true;
 };
 await mock(page,state);
 const {panel,consent,authorize,checkbox}=await openInspection(page);
 await expect(checkbox).toHaveCount(1);await checkbox.check();await authorize.click();
 await expect(panel.getByRole('alert')).toContainText('does not match the reviewed handoff');
 await expect(consent).not.toContainText('Inspection permission recorded');
 await expect(checkbox).not.toBeChecked();await expect(authorize).toBeDisabled();
 await expect(panel.getByRole('button',{name:'Approve exact reference sharing'})).toHaveCount(0);
 expect(referenceWrites(state)).toHaveLength(1);
 expect(referenceWrites(state)[0].path).toMatch(/\/adopt-generation-inspection$/);
 expect(state.app.unexpected).toEqual([]);
});

for(const blocked of ['member','worker unavailable'] as const)test(`generation inspection adoption remains unavailable for ${blocked}`,async({page})=>{
 const state=inspectionFixture();
 if(blocked==='member')state.app.company.role='member';else state.enabled=false;
 await mock(page,state);
 const {panel,consent,authorize,checkbox}=await openInspection(page);
 if(blocked==='member'){
  await expect(consent).toContainText('A current administrator can authorize inspection');
  await expect(authorize).toHaveCount(0);await expect(checkbox).toHaveCount(0);
 }else{
  await expect(panel).toContainText('No qualified worker is active');
  await expect(checkbox).toHaveCount(1);await expect(checkbox).toBeDisabled();await expect(authorize).toBeDisabled();
 }
 expect(referenceWrites(state)).toHaveLength(0);
 expect(state.app.unexpected).toEqual([]);
});
