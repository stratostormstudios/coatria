import test from 'node:test';
import assert from 'node:assert/strict';
import {createServer} from 'node:http';
import {resolve} from 'node:path';
import {build} from 'esbuild';
import {chromium} from '@playwright/test';

const companyId='10000000-0000-4000-8000-000000000001',provisionId='20000000-0000-4000-8000-000000000002';
const base=`/api/companies/${companyId}/studio/host-provisions`,path=`${base}/${provisionId}/readiness`;
const provision=()=>({id:provisionId,revision:4,phase:'failed',plan:{installations:[{name:'Studio coordinator'}],durationMinutes:15,preset:{dataCenterId:'US-NC-2'}},submittedAt:null,podId:null,stopRequestedAt:null,expiresAt:null,providerStatus:null,errorCode:'CPU_INFERENCE_UNAVAILABLE',computeStopped:false,credentialsRevoked:false});
const planHash='a'.repeat(64),installationId='40000000-0000-4000-8000-000000000004';
const installation=()=>({id:installationId,revision:7,name:'Studio coordinator',status:'paused',runtimeConfig:{providerId:'runpod',modelId:'Reviewed model',maxSteps:8,maxOutputTokens:4096,maxTotalTokens:12000,timeoutSeconds:600},capabilities:['studio.read']});
const plannedProvision=()=>({...provision(),phase:'planned',planHash,errorCode:null,readiness:{ready:true,reasons:[]},plan:{durationMinutes:15,reviewExpiresAt:new Date(Date.now()+300_000).toISOString(),installations:[{...installation(),installationId,character:{}}],preset:{dataCenterId:'US-NC-2',volumeId:'pinned-workspace-volume',maxHourlyMicrousd:60_000,modelId:'Reviewed model'},reservation:{cpuMicrousd:15_000,companyLifetimeAllowanceMicrousd:100_000,previouslyReservedMicrousd:0}}});
const readiness=()=>({provisionId,planHash,revision:4,checkedAt:new Date().toISOString(),readOnly:true,authorizesStart:false,ready:true,providerReady:true,configuration:{state:'current'},checks:[{stage:'lifecycle',ready:true,code:'ready',httpStatus:200},{stage:'health',ready:true,code:'ready',httpStatus:200,endpointReachable:true,workerState:'reported',modelReadiness:'unverified',workerCounts:{idle:1,ready:1,initializing:0,running:0,throttled:0,unhealthy:0}}],cpuCapacity:{stage:'cpu_capacity',ready:true,code:'ready',httpStatus:200,regionReady:true}});

test('managed host diagnostics and failed-start closure use explicit, bounded UI actions',{timeout:90_000},async t=>{
 // Actual React component, browser fetch, and hooks; fake local HTTP server only.
 // The in-memory bundle is a test harness, not a Next application build.
 const bundle=await build({stdin:{contents:`import React,{useState} from 'react';import{createRoot}from'react-dom/client';import{StudioManagedCpu}from'./src/components/StudioManagedCpu';import{setClientIdentity}from'./src/lib/client';setClientIdentity('30000000-0000-4000-8000-000000000003');function Fixture(){const[shown,setShown]=useState(true);return <><button onClick={()=>setShown(!shown)}>Toggle host panel</button>{shown&&<StudioManagedCpu p={{company:{id:'${companyId}',role:'owner'},refresh:async()=>{},notify:()=>{}} as any} onBack={()=>{}}/>}</>;}createRoot(document.getElementById('root')!).render(<Fixture/>);`,loader:'tsx',resolveDir:process.cwd()},bundle:true,write:false,outdir:resolve('test-memory-output'),jsx:'automatic',platform:'browser',format:'esm',define:{'process.env.NODE_ENV':'"development"'}});
 const js=bundle.outputFiles.find(file=>file.path.endsWith('.js'))!.text,css=bundle.outputFiles.find(file=>file.path.endsWith('.css'))?.text??'';
 let host:Record<string,any>=provision(),reply:Record<string,any>=readiness(),status=200,wait:Promise<void>|null=null,installations:Record<string,unknown>[]=[],rejectStart=false;
 const requests:Array<{path:string;method:string;body:string;identity:string|undefined}>=[];
 const server=createServer(async(req,res)=>{
  if(req.url==='/ui.js'){res.setHeader('Content-Type','text/javascript');res.end(js);return;}
  if(req.url==='/ui.css'){res.setHeader('Content-Type','text/css');res.end(css);return;}
  if(!req.url?.startsWith('/api/')){res.setHeader('Content-Type','text/html');res.end('<!doctype html><html><head><link rel="stylesheet" href="/ui.css"></head><body><div id="root"></div><script type="module" src="/ui.js"></script></body></html>');return;}
  const chunks:Buffer[]=[];for await(const chunk of req)chunks.push(Buffer.from(chunk));
  requests.push({path:req.url,method:req.method!,body:Buffer.concat(chunks).toString(),identity:req.headers['x-coatria-user'] as string|undefined});res.setHeader('Content-Type','application/json');
  if(req.url===path){const result=reply,code=status;if(wait)await wait;if(!res.destroyed){res.statusCode=code;res.end(JSON.stringify(code===200?{readiness:result}:result));}return;}
  if(req.url===base){res.end(JSON.stringify({provisions:[host],readiness:{ready:true,reasons:[]}}));return;}
  if(req.url===`${base}/${provisionId}/stop`&&req.method==='POST'){host={...host,phase:'stopped',computeStopped:true,credentialsRevoked:true,stopRequestedAt:new Date().toISOString(),revision:5};res.end(JSON.stringify({provision:host}));return;}
  if(req.url===`${base}/${provisionId}/start`&&req.method==='POST'){if(rejectStart){res.statusCode=503;res.end('{"error":"Refresh before retrying this request."}');return;}host={...host,phase:'provisioning',revision:5,submittedAt:new Date().toISOString()};res.end(JSON.stringify({provision:host}));return;}
  if(req.url.endsWith('/plugin-installations?limit=100')){res.end(JSON.stringify({installations}));return;}
  res.statusCode=404;res.end('{"error":"Unexpected test request"}');
 });
 await new Promise<void>(done=>server.listen(0,'127.0.0.1',done));
 const origin='http://127.0.0.1:'+(server.address() as {port:number}).port,browser=await chromium.launch({headless:true});
 const errors:string[]=[];
 async function open(){requests.length=0;const page=await browser.newPage();page.setDefaultTimeout(10_000);page.on('pageerror',e=>errors.push(e.message));await page.goto(origin);await page.getByRole('button',{name:'Check provider connection',exact:true}).waitFor();return page;}
 try{
  await t.test('diagnosis never polls or mutates; one explicit GET shows only safe actionable projection',async()=>{
   host=provision();reply={...readiness(),ready:false,configuration:{state:'inactive'},rawProvider:'PRIVATE_PROVIDER_DETAIL'};let release!:()=>void;wait=new Promise<void>(done=>release=done);const page=await open();
   try{
    assert.equal(requests.filter(item=>item.path===path).length,0);
    await page.getByRole('button',{name:'Refresh managed CPU hosts'}).click();
    await page.getByRole('button',{name:'Check provider connection',exact:true}).click();
    const pending=page.getByRole('button',{name:'Checking connection…',exact:true});await pending.waitFor();assert(await pending.isDisabled());
    await pending.dispatchEvent('click');await page.getByText('Checking endpoint access, inference workers and CPU capacity…').waitFor();
    assert.equal(requests.filter(item=>item.path===path).length,1);release();wait=null;
    await page.getByText('Endpoint access: Passed',{exact:true}).waitFor();await page.getByText('Inference workers: Workers reported',{exact:true}).waitFor();await page.getByText('CPU capacity in US-NC-2: Available',{exact:true}).waitFor();
    assert.match(await page.locator('body').innerText(),/runtime configuration is inactive/);assert(!((await page.locator('body').innerText()).includes('PRIVATE_PROVIDER_DETAIL')));
    assert.deepEqual(requests.filter(item=>item.path===path).map(({method,body,identity})=>({method,body,identity})),[{method:'GET',body:'',identity:'30000000-0000-4000-8000-000000000003'}]);assert(requests.every(item=>item.method==='GET'));
   }finally{release();wait=null;await page.close();}
  });
  await t.test('stage failures use fixed messages, including unknown inherited-object names',async()=>{
   reply={...readiness(),ready:false,providerReady:false,checks:[{stage:'lifecycle',ready:false,code:'http_unauthorized',httpStatus:403,message:'PRIVATE_PROVIDER_ERROR'},{stage:'health',ready:false,code:'toString',httpStatus:null}]};const page=await open();
   try{await page.getByRole('button',{name:'Check provider connection',exact:true}).click();await page.getByText('Endpoint access: Needs attention',{exact:true}).waitFor();await page.getByText('The server credential cannot access this endpoint. Ask an administrator to check its permissions.',{exact:true}).waitFor();await page.getByText('The connection could not be verified. Ask an administrator to inspect the provider setup.',{exact:true}).waitFor();assert(!((await page.locator('body').innerText()).includes('PRIVATE_PROVIDER_ERROR')));assert(requests.every(item=>item.method==='GET'));}finally{await page.close();}
  });
  await t.test('regional capacity separates unavailable and unconfirmed from the earlier uncertain create',async()=>{
   for(const capacity of [{code:'cpu_capacity_unavailable',regionReady:false,httpStatus:200,label:'Unavailable'},{code:'cpu_capacity_unconfirmed',httpStatus:200,label:'Unconfirmed'},{code:'cpu_sku_mismatch',httpStatus:200,label:'Unconfirmed'},{code:'network_error',httpStatus:null,label:'Unconfirmed'}]){
    host={...provision(),phase:'uncertain',submittedAt:new Date().toISOString(),errorCode:'CPU_CREATE_UNCERTAIN'};reply={...readiness(),ready:false,providerReady:false,configuration:{state:'inactive'},cpuCapacity:{stage:'cpu_capacity',ready:false,...capacity,providerRegion:'PRIVATE_PROVIDER_REGION',message:'PRIVATE_PROVIDER_ERROR'}};const page=await open();
    try{await page.getByRole('button',{name:'Check provider connection',exact:true}).click();await page.getByText(`CPU capacity in US-NC-2: ${capacity.label}`,{exact:true}).waitFor();await page.getByText('Endpoint access: Passed',{exact:true}).waitFor();await page.getByText('Inference workers: Workers reported',{exact:true}).waitFor();const body=await page.locator('body').innerText();assert.match(body,/does not establish whether an earlier Pod request was accepted/);assert.match(body,/do not submit an uncertain request again/);assert.match(body,/CPU_CREATE_UNCERTAIN/);assert.match(body,/runtime configuration is inactive/);assert(!body.includes('PRIVATE_PROVIDER_'));assert.equal(await page.getByRole('button',{name:'Close failed start',exact:true}).count(),0);assert.equal(requests.filter(item=>item.path===path).length,1);assert(requests.every(item=>item.method==='GET'));}finally{await page.close();}
   }
   host=provision();
  });
  await t.test('older HTTP-only health responses leave model readiness and CPU capacity unconfirmed',async()=>{
   const {cpuCapacity:unused,...legacy}=readiness();reply={...legacy,checks:[legacy.checks[0],{stage:'health',ready:true,code:'ready',httpStatus:200,workerCounts:{idle:0,ready:0,initializing:0,running:0,throttled:0,unhealthy:null}}]};const page=await open();
   try{await page.getByRole('button',{name:'Check provider connection',exact:true}).click();await page.getByText('Endpoint access: Passed',{exact:true}).waitFor();await page.getByText('Inference workers: Unconfirmed',{exact:true}).waitFor();await page.getByText('CPU capacity in US-NC-2: Not checked',{exact:true}).waitFor();assert.match(await page.locator('body').innerText(),/endpoint access and worker observations do not establish CPU availability/);assert.equal(await page.getByText('CPU capacity in US-NC-2: Available',{exact:true}).count(),0);assert.equal(requests.filter(item=>item.path===path).length,1);assert(requests.every(item=>item.method==='GET'));}finally{await page.close();}
  });
  await t.test('duplicate stages, misplaced CPU facts and contradictory capacity never appear as passed',async()=>{
   const cases=[{checks:[...readiness().checks,readiness().cpuCapacity]},{checks:[readiness().checks[1],readiness().checks[1]]},{cpuCapacity:{stage:'health',ready:true,code:'ready',httpStatus:200,regionReady:true}},{cpuCapacity:{stage:'cpu_capacity',ready:true,code:'ready',httpStatus:200}},{cpuCapacity:{stage:'cpu_capacity',ready:false,code:'cpu_capacity_unavailable',httpStatus:200,regionReady:true}},{cpuCapacity:{stage:'cpu_capacity',ready:true,code:'cpu_capacity_unconfirmed',httpStatus:200,regionReady:true}},{cpuCapacity:{stage:'cpu_capacity',ready:false,code:'cpu_capacity_unconfirmed',httpStatus:200,regionReady:'PRIVATE_PROVIDER_DETAIL'}}];
   for(const patch of cases){reply={...readiness(),...patch};const page=await open();try{await page.getByRole('button',{name:'Check provider connection',exact:true}).click();await page.getByRole('alert').waitFor();assert.equal(await page.getByText('CPU capacity in US-NC-2: Available',{exact:true}).count(),0);assert(!((await page.locator('body').innerText()).includes('PRIVATE_PROVIDER_DETAIL')));assert.equal(requests.filter(item=>item.path===path).length,1);assert(requests.every(item=>item.method==='GET'));}finally{await page.close();}}
  });
  await t.test('cached, scheduled, idle and zero-worker snapshots never claim model readiness or submit warmup',async()=>{
   for(const counter of ['ready','running','idle','initializing','none','unknown']){
    const workerCounts={idle:0,ready:0,initializing:0,running:0,throttled:0,unhealthy:0} as Record<string,number|null>;
    if(counter==='unknown')workerCounts.idle=null;else if(counter!=='none')workerCounts[counter]=1;
    const state=counter==='none'?'none_reported':counter==='unknown'?'unconfirmed':'reported',label=state==='reported'?'Workers reported':state==='none_reported'?'No workers reported':'Unconfirmed';
    reply={...readiness(),checks:[readiness().checks[0],{stage:'health',ready:true,code:'ready',httpStatus:200,endpointReachable:true,workerState:state,modelReadiness:'unverified',workerCounts,raw:'PRIVATE_HEALTH'}]};const page=await open();
    try{await page.getByRole('button',{name:'Check provider connection',exact:true}).click();await page.getByText(`Inference workers: ${label}`,{exact:true}).waitFor();await page.getByText('Health endpoint reachable.',{exact:true}).waitFor();await page.getByText('Model readiness: Not verified',{exact:true}).waitFor();const body=await page.locator('body').innerText();assert.match(body,/operator must prepare inference capacity separately/);assert.match(body,/cold starts consume each task.s unchanged deadline/);assert.match(body,/sends no warmup request/);if(state==='reported')assert.match(body,/ready worker may be cached; a running worker may still be starting/);assert.match(body,new RegExp(`Worker counts: idle ${workerCounts.idle??'unknown'}`));assert(!body.includes('PRIVATE_HEALTH'));assert(!body.includes('Warm worker'));assert(!body.includes('Inference health: Passed'));assert.equal(requests.filter(item=>item.path===path).length,1);assert(requests.every(item=>item.method==='GET'));}finally{await page.close();}
   }
  });
  await t.test('contradictory observations and invented model-ready proof are rejected without reflecting provider values',async()=>{
   const observed=readiness().checks[1];
   for(const patch of [{workerState:'PRIVATE_STATE'},{workerState:'none_reported'},{workerCounts:{...observed.workerCounts,idle:-1}},{workerCounts:{...observed.workerCounts,idle:0,ready:0}},{workerCounts:{ready:1}},{endpointReachable:false},{httpStatus:403},{modelReadiness:'ready'}]){
    reply={...readiness(),checks:[readiness().checks[0],{...observed,...patch}]};const page=await open();
    try{await page.getByRole('button',{name:'Check provider connection',exact:true}).click();await page.getByRole('alert').waitFor();assert.equal(await page.getByText('Inference workers: Workers reported',{exact:true}).count(),0);assert(!((await page.locator('body').innerText()).includes('PRIVATE_STATE')));assert(requests.every(item=>item.method==='GET'));}finally{await page.close();}
   }
  });
  await t.test('HTTP errors and mismatched capability claims display no raw response or automatic retry',async()=>{
   status=403;reply={error:'PRIVATE_ACCESS_DETAIL'};const page=await open();
   try{await page.getByRole('button',{name:'Check provider connection',exact:true}).click();await page.getByRole('alert').waitFor();assert.match(await page.getByRole('alert').innerText(),/Refresh this workspace and check your access/);assert(!((await page.locator('body').innerText()).includes('PRIVATE_ACCESS_DETAIL')));assert.equal(requests.filter(item=>item.path===path).length,1);
    status=200;reply={...readiness(),authorizesStart:true};await page.getByRole('button',{name:'Check provider connection',exact:true}).click();await page.getByRole('alert').waitFor();assert.equal(await page.getByText('Endpoint access: Passed',{exact:true}).count(),0);assert.equal(requests.filter(item=>item.path===path).length,2);
    status=429;reply={error:'PRIVATE_RATE_LIMIT_DETAIL'};await page.getByRole('button',{name:'Check provider connection',exact:true}).click();await page.getByText('Too many connection checks. Wait one minute before checking again.',{exact:true}).waitFor();assert.equal(requests.filter(item=>item.path===path).length,3);assert(!((await page.locator('body').innerText()).includes('PRIVATE_RATE_LIMIT_DETAIL')));
   }finally{status=200;await page.close();}
  });
  await t.test('unmount discards an in-flight diagnostic and remount does not repeat it',async()=>{
   reply=readiness();let release!:()=>void;wait=new Promise<void>(done=>release=done);const page=await open();
   try{await page.getByRole('button',{name:'Check provider connection',exact:true}).click();await page.getByRole('button',{name:'Checking connection…',exact:true}).waitFor();await page.getByRole('button',{name:'Toggle host panel',exact:true}).click();release();wait=null;await page.getByRole('button',{name:'Toggle host panel',exact:true}).click();await page.getByRole('button',{name:'Check provider connection',exact:true}).waitFor();assert.equal(await page.getByText('Endpoint access: Passed',{exact:true}).count(),0);assert.equal(requests.filter(item=>item.path===path).length,1);}finally{release();wait=null;await page.close();}
  });
  await t.test('failed unsubmitted closure sends current revision and displays confirmed credential revocation',async()=>{
   host=provision();const page=await open();
   try{await page.getByRole('button',{name:'Close failed start',exact:true}).click();await page.getByText('Failed start closed before any Pod was submitted. This host’s credentials are revoked.',{exact:true}).waitFor();const writes=requests.filter(item=>item.method!=='GET');assert.equal(writes.length,1);assert.equal(writes[0].path,`${base}/${provisionId}/stop`);const body=JSON.parse(writes[0].body);assert.equal(body.revision,4);assert.match(body.clientId,/^[a-f0-9-]{36}$/);assert.deepEqual(Object.keys(body).sort(),['clientId','revision']);assert.equal(await page.getByRole('button',{name:'Close failed start',exact:true}).count(),0);}finally{await page.close();}
  });
  await t.test('submitted, uncertain, stopped and already-requested records cannot use unused-host closure',async()=>{
   for(const override of[{submittedAt:new Date().toISOString()},{podId:'provider-pod'},{phase:'uncertain'},{phase:'stopped',computeStopped:true,credentialsRevoked:false},{stopRequestedAt:new Date().toISOString()}]){
    host={...provision(),...override};const page=await open();
    try{assert.equal(await page.getByRole('button',{name:'Close failed start',exact:true}).count(),0);if(override.stopRequestedAt)assert(await page.getByRole('button',{name:'Closure requested',exact:true}).isDisabled());if(override.phase==='stopped')await page.getByText(/Credential revocation is a separate host action/).waitFor();assert(requests.every(item=>item.method==='GET'));}finally{await page.close();}
   }
  });
  await t.test('the plan checks CPU before paid inference and keeps Start blocked until both are available',async()=>{
   host=plannedProvision();installations=[installation()];reply={...readiness(),checks:[{stage:'lifecycle',ready:false,code:'endpoint_disabled',httpStatus:200},readiness().checks[1]],cpuCapacity:{stage:'cpu_capacity',ready:false,code:'cpu_capacity_unavailable',httpStatus:200,regionReady:false}};const page=await open();
   try{
    await page.getByRole('button',{name:'Review this plan',exact:true}).click();const start=page.getByRole('button',{name:'Start reviewed CPU host',exact:true});await page.getByRole('checkbox',{name:/I reviewed this plan/}).check();assert(await start.isDisabled());
    const review=page.getByRole('region',{name:'Capacity for this host plan'});await review.getByText('pinned-workspace-volume',{exact:true}).waitFor();assert.match(await review.innerText(),/pins the host to US-NC-2/);assert.match(await review.innerText(),/while inference is off/);assert.equal(await page.getByRole('button',{name:'Check provider connection',exact:true}).count(),1);assert.equal(requests.filter(item=>item.path===path).length,0);
    await review.getByRole('button',{name:'Check provider connection',exact:true}).click();await review.getByText('CPU capacity in US-NC-2: Unavailable',{exact:true}).waitFor();assert(await start.isDisabled());
    reply={...reply,cpuCapacity:readiness().cpuCapacity};await review.getByRole('button',{name:'Check provider connection',exact:true}).click();await review.getByText('CPU capacity is available. An operator must prepare the separate inference connection, then check again before starting.',{exact:true}).waitFor();assert(await start.isDisabled());assert(requests.every(item=>item.method==='GET'));
    reply=readiness();await review.getByRole('button',{name:'Check provider connection',exact:true}).click();await review.getByText(/The server checks capacity again before activating agents/).waitFor();assert(!(await start.isDisabled()));await start.click();await page.getByText('provisioning',{exact:true}).waitFor();
    const writes=requests.filter(item=>item.method!=='GET');assert.equal(writes.length,1);assert.equal(writes[0].path,`${base}/${provisionId}/start`);const body=JSON.parse(writes[0].body);assert.deepEqual({...body,clientId:'request-id'},{revision:4,planHash,acknowledgeCharges:true,activateAgents:true,clientId:'request-id'});assert.match(body.clientId,/^[a-f0-9-]{36}$/);
   }finally{installations=[];await page.close();}
  });
  await t.test('missing, unconfirmed, stale, mismatched and inactive observations cannot unlock Start',async()=>{
   const cases=[{cpuCapacity:undefined},{cpuCapacity:{stage:'cpu_capacity',ready:false,code:'cpu_capacity_unconfirmed',httpStatus:200}},{checkedAt:undefined},{checkedAt:'not-a-date'},{checkedAt:new Date(Date.now()-120_000).toISOString()},{checkedAt:'2999-01-01T00:00:00.000Z'},{planHash:undefined},{planHash:'b'.repeat(64)},{revision:3},{configuration:{state:'inactive'}}];
   for(const patch of cases){host=plannedProvision();installations=[installation()];reply={...readiness(),...patch};const page=await open();
    try{
     await page.getByRole('button',{name:'Review this plan',exact:true}).click();await page.getByRole('checkbox',{name:/I reviewed this plan/}).check();await page.getByRole('button',{name:'Check provider connection',exact:true}).click();
     if('planHash'in patch||'revision'in patch)await page.getByRole('alert').waitFor();else if('cpuCapacity'in patch)await page.getByText(`CPU capacity in US-NC-2: ${patch.cpuCapacity?'Unconfirmed':'Not checked'}`,{exact:true}).waitFor();else if('configuration'in patch)await page.getByText('The runtime configuration is no longer current. Prepare a new plan before starting.',{exact:true}).waitFor();else await page.getByText('This capacity observation is stale or its time could not be verified. Check this plan again before starting.',{exact:true}).waitFor();
     assert(await page.getByRole('button',{name:'Start reviewed CPU host',exact:true}).isDisabled());assert.equal(requests.filter(item=>item.path===path).length,1);assert(requests.every(item=>item.method==='GET'));
    }finally{installations=[];await page.close();}
   }
  });
  await t.test('small clock skew permits a check, which expires locally without polling or surviving a changed plan',async()=>{
   host=plannedProvision();installations=[installation()];reply={...readiness(),checkedAt:new Date(Date.now()+1_000).toISOString()};const page=await open();
   try{
    await page.clock.install({time:new Date()});await page.getByRole('button',{name:'Review this plan',exact:true}).click();await page.getByRole('checkbox',{name:/I reviewed this plan/}).check();await page.getByRole('button',{name:'Check provider connection',exact:true}).click();await page.getByText(/The server checks capacity again before activating agents/).waitFor();const start=page.getByRole('button',{name:'Start reviewed CPU host',exact:true});assert(!(await start.isDisabled()));
    await page.clock.fastForward(61_000);await page.getByText('This capacity observation is stale or its time could not be verified. Check this plan again before starting.',{exact:true}).waitFor();assert(await start.isDisabled());assert.equal(requests.filter(item=>item.path===path).length,1);
    host={...host,revision:5,planHash:'b'.repeat(64)};await page.getByRole('button',{name:'Refresh managed CPU hosts'}).click();await page.getByText('Check this exact plan before starting. The result is valid for 60 seconds.',{exact:true}).waitFor();assert(await start.isDisabled());assert(!(await page.getByRole('checkbox',{name:/I reviewed this plan/}).isChecked()));assert(requests.every(item=>item.method==='GET'));
   }finally{installations=[];await page.close();}
  });
  await t.test('a recheck clears prior success and an uncertain start preserves the same explicit retry identity',async()=>{
   host=plannedProvision();installations=[installation()];reply=readiness();const page=await open();
   try{
    await page.getByRole('button',{name:'Review this plan',exact:true}).click();await page.getByRole('checkbox',{name:/I reviewed this plan/}).check();await page.getByRole('button',{name:'Check provider connection',exact:true}).click();await page.getByText(/The server checks capacity again before activating agents/).waitFor();const start=page.getByRole('button',{name:'Start reviewed CPU host',exact:true});assert(!(await start.isDisabled()));
    status=503;reply={error:'PRIVATE_PROVIDER_DETAIL'};await page.getByRole('button',{name:'Check provider connection',exact:true}).click();await page.getByRole('alert').waitFor();assert(await start.isDisabled());assert(!((await page.locator('body').innerText()).includes('PRIVATE_PROVIDER_DETAIL')));
    status=200;reply=readiness();await page.getByRole('button',{name:'Check provider connection',exact:true}).click();await page.getByText(/The server checks capacity again before activating agents/).waitFor();rejectStart=true;await start.click();await page.getByRole('alert').waitFor();assert(!(await start.isDisabled()));rejectStart=false;await start.click();await page.getByText('provisioning',{exact:true}).waitFor();const writes=requests.filter(item=>item.method!=='GET');assert.equal(writes.length,2);assert.deepEqual(writes[1],writes[0]);
   }finally{status=200;rejectStart=false;installations=[];await page.close();}
  });
  assert.deepEqual(errors,[]);
 }finally{await browser.close();server.closeAllConnections();await new Promise<void>((done,reject)=>server.close(error=>error?reject(error):done()));}
});
