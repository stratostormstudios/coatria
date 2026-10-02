import test from 'node:test';
import assert from 'node:assert/strict';
import {createServer} from 'node:http';
import {resolve} from 'node:path';
import {build} from 'esbuild';
import {chromium} from '@playwright/test';

const companyId='10000000-0000-4000-8000-000000000001',hostId='20000000-0000-4000-8000-000000000002';
const base=`/api/companies/${companyId}/studio/hosts`,detail=`${base}/${hostId}`;
const fixtureHost=()=>({id:hostId,companyId,name:'Expired fixture host',status:'active',revision:7,maxAgents:3,providerIds:['runpod'],expiresAt:'2000-01-01T00:00:00.000Z',leaseExpiresAt:null,bindingCount:3});

test('expired host access can be explicitly revoked without reopening enrollment',{timeout:60_000},async t=>{
 // Actual component, hooks, browser fetch and local HTTP. No external service.
 const bundle=await build({stdin:{contents:`import React from 'react';import{createRoot}from'react-dom/client';import{StudioHosts}from'./src/components/StudioHosts';import{setClientIdentity}from'./src/lib/client';setClientIdentity('30000000-0000-4000-8000-000000000003');createRoot(document.getElementById('root')!).render(<StudioHosts p={{company:{id:'${companyId}',role:'owner'},refresh:async()=>{},notify:()=>{}} as any} onClose={()=>{}}/>);`,loader:'tsx',resolveDir:process.cwd()},bundle:true,write:false,outdir:resolve('test-memory-output'),jsx:'automatic',platform:'browser',format:'esm',define:{'process.env.NODE_ENV':'"development"'}});
 const js=bundle.outputFiles.find(file=>file.path.endsWith('.js'))!.text,css=bundle.outputFiles.find(file=>file.path.endsWith('.css'))?.text??'';
 let host=fixtureHost(),rejectMutation=false;
 const writes:Array<{path:string;body:Record<string,unknown>;identity:string|undefined}>=[],errors:string[]=[];
 const server=createServer(async(req,res)=>{
  if(req.url==='/ui.js'){res.setHeader('Content-Type','text/javascript');res.end(js);return;}
  if(req.url==='/ui.css'){res.setHeader('Content-Type','text/css');res.end(css);return;}
  if(!req.url?.startsWith('/api/')){res.setHeader('Content-Type','text/html');res.end('<!doctype html><html><head><link rel="stylesheet" href="/ui.css"></head><body><div id="root"></div><script type="module" src="/ui.js"></script></body></html>');return;}
  res.setHeader('Content-Type','application/json');
  if(req.method!=='GET'){
   const chunks:Buffer[]=[];for await(const chunk of req)chunks.push(Buffer.from(chunk));
   writes.push({path:req.url,body:JSON.parse(Buffer.concat(chunks).toString()),identity:req.headers['x-coatria-user'] as string|undefined});
   if(req.url===detail+'/revoke'&&req.method==='POST'){
    if(rejectMutation){res.statusCode=503;res.end('{"error":"Reconciliation required."}');return;}
    host={...host,status:'revoked',revision:host.revision+1,bindingCount:0};res.end(JSON.stringify({host,invalidatedAgentCount:3,replayed:false}));return;
   }
  }
  if(req.url===base){res.end(JSON.stringify({hosts:[host],encryptionConfigured:true}));return;}
  if(req.url===detail){res.end(JSON.stringify({host,bindings:[1,2,3].map(index=>({agentId:`agent-${index}`,name:`Specialist ${index}`,credentialState:host.status==='revoked'?'revoked':'expired',credentialVersion:1,installationRevision:2,capabilities:['studio.read']}))}));return;}
  if(req.url.endsWith('/plugin-installations?limit=100')){res.end('{"installations":[]}');return;}
  res.statusCode=404;res.end('{"error":"Unexpected test request"}');
 });
 await new Promise<void>(done=>server.listen(0,'127.0.0.1',done));
 const origin='http://127.0.0.1:'+(server.address() as {port:number}).port,browser=await chromium.launch({headless:true});
 async function open(){writes.length=0;const page=await browser.newPage();page.setDefaultTimeout(10_000);page.on('pageerror',error=>errors.push(error.message));await page.goto(origin);await page.getByRole('button',{name:/Expired fixture host/}).click();await page.getByRole('heading',{name:'Enrolled specialists',exact:true}).waitFor();return page;}
 try{
  await t.test('expiry hides enrollment but leaves a confirmed, exact-revision revoke',async()=>{
   host=fixtureHost();const page=await open();
   try{
    assert.equal(await page.getByText('expired',{exact:true}).count(),1);assert.equal(await page.getByRole('button',{name:'Enroll selected specialists',exact:true}).count(),0);assert.equal(await page.getByText(/expired .*credential v1/).count(),3);
    await page.getByRole('button',{name:'Revoke host',exact:true}).click();await page.getByRole('button',{name:'Revoke host access',exact:true}).waitFor();assert.equal(writes.length,0);
    await page.getByRole('button',{name:'Keep host',exact:true}).click();assert.equal(writes.length,0);await page.getByRole('button',{name:'Revoke host',exact:true}).click();await page.getByRole('button',{name:'Revoke host access',exact:true}).click();
    await page.getByText('revoked',{exact:true}).waitFor();assert.equal(writes.length,1);assert.equal(writes[0].path,detail+'/revoke');assert.equal(writes[0].identity,'30000000-0000-4000-8000-000000000003');assert.equal(writes[0].body.revision,7);assert.match(String(writes[0].body.clientId),/^[a-f0-9-]{36}$/);assert.deepEqual(Object.keys(writes[0].body).sort(),['clientId','revision']);assert.equal(await page.getByRole('button',{name:'Revoke host',exact:true}).count(),0);assert.equal(await page.getByRole('button',{name:'Enroll selected specialists',exact:true}).count(),0);assert.equal(await page.getByText(/revoked .*credential v1/).count(),3);
   }finally{await page.close();}
  });
  await t.test('an uncertain response keeps the same request identity on explicit retry',async()=>{
   host=fixtureHost();rejectMutation=true;const page=await open();
   try{
    await page.getByRole('button',{name:'Revoke host',exact:true}).click();await page.getByRole('button',{name:'Revoke host access',exact:true}).click();await page.getByRole('alert').waitFor();assert.equal(writes.length,1);assert.equal(await page.getByText('revoked',{exact:true}).count(),0);assert.equal(await page.getByRole('button',{name:'Enroll selected specialists',exact:true}).count(),0);
    rejectMutation=false;await page.getByRole('button',{name:'Revoke host access',exact:true}).click();await page.getByText('revoked',{exact:true}).waitFor();assert.equal(writes.length,2);assert.deepEqual(writes[1],writes[0]);
   }finally{rejectMutation=false;await page.close();}
  });
  await t.test('live enrollment remains available and an already revoked host has neither action',async()=>{
   for(const state of ['live','revoked']){
    host={...fixtureHost(),...(state==='live'?{expiresAt:'2999-01-01T00:00:00.000Z'}:{status:'revoked',bindingCount:0})};const page=await open();
    try{assert.equal(await page.getByRole('button',{name:'Enroll selected specialists',exact:true}).count(),state==='live'?1:0);assert.equal(await page.getByRole('button',{name:'Revoke host',exact:true}).count(),state==='live'?1:0);assert.equal(writes.length,0);}finally{await page.close();}
   }
  });
  assert.deepEqual(errors,[]);
 }finally{await browser.close();server.closeAllConnections();await new Promise<void>((done,reject)=>server.close(error=>error?reject(error):done()));}
});
