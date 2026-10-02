import test from 'node:test';
import assert from 'node:assert/strict';
import {createServer} from 'node:http';
import {resolve} from 'node:path';
import {build} from 'esbuild';
import {chromium} from '@playwright/test';

const companyId='10000000-0000-4000-8000-000000000001',provisionId='20000000-0000-4000-8000-000000000002';
const base=`/api/companies/${companyId}/studio/host-provisions`,path=`${base}/${provisionId}/readiness`;
const provision=()=>({id:provisionId,revision:4,phase:'failed',plan:{installations:[{name:'Studio coordinator'}],durationMinutes:15,preset:{dataCenterId:'US-NC-2'}},submittedAt:null,podId:null,stopRequestedAt:null,expiresAt:null,providerStatus:null,errorCode:'CPU_INFERENCE_UNAVAILABLE',computeStopped:false,credentialsRevoked:false});
const readiness=()=>({provisionId,checkedAt:new Date().toISOString(),readOnly:true,authorizesStart:false,ready:true,providerReady:true,configuration:{state:'current'},checks:[{stage:'lifecycle',ready:true,code:'ready',httpStatus:200},{stage:'health',ready:true,code:'ready',httpStatus:200,endpointReachable:true,workerState:'reported',modelReadiness:'unverified',workerCounts:{idle:1,ready:1,initializing:0,running:0,throttled:0,unhealthy:0}}],cpuCapacity:{stage:'cpu_capacity',ready:true,code:'ready',httpStatus:200,regionReady:true}});

test('managed host diagnostics and failed-start closure use explicit, bounded UI actions',{timeout:90_000},async t=>{
 // Actual React component, browser fetch, and hooks; fake local HTTP server only.
 // The in-memory bundle is a test harness, not a Next application build.
 const bundle=await build({stdin:{contents:`import React,{useState} from 'react';import{createRoot}from'react-dom/client';import{StudioManagedCpu}from'./src/components/StudioManagedCpu';import{setClientIdentity}from'./src/lib/client';setClientIdentity('30000000-0000-4000-8000-000000000003');function Fixture(){const[shown,setShown]=useState(true);return <><button onClick={()=>setShown(!shown)}>Toggle host panel</button>{shown&&<StudioManagedCpu p={{company:{id:'${companyId}',role:'owner'},refresh:async()=>{},notify:()=>{}} as any} onBack={()=>{}}/>}</>;}createRoot(document.getElementById('root')!).render(<Fixture/>);`,loader:'tsx',resolveDir:process.cwd()},bundle:true,write:false,outdir:resolve('test-memory-output'),jsx:'automatic',platform:'browser',format:'esm',define:{'process.env.NODE_ENV':'"development"'}});
 const js=bundle.outputFiles.find(file=>file.path.endsWith('.js'))!.text,css=bundle.outputFiles.find(file=>file.path.endsWith('.css'))?.text??'';
 let host:Record<string,unknown>=provision(),reply:Record<string,any>=readiness(),status=200,wait:Promise<void>|null=null;
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
  if(req.url.endsWith('/plugin-installations?limit=100')){res.end('{"installations":[]}');return;}
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
  assert.deepEqual(errors,[]);
 }finally{await browser.close();server.closeAllConnections();await new Promise<void>((done,reject)=>server.close(error=>error?reject(error):done()));}
});
