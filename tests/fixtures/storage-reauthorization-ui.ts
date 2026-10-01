import {createServer} from 'node:http';
import {resolve} from 'node:path';
import {build} from 'esbuild';
import {projectStorageConnectionReauthorizeInput,projectStorageConnectionRevokeInput} from '../../src/lib/project-storage-protocol';

export const storageIds={company:'10000000-0000-4000-8000-000000000001',project:'20000000-0000-4000-8000-000000000002',user:'30000000-0000-4000-8000-000000000003',connection:'40000000-0000-4000-8000-000000000004',binding:'50000000-0000-4000-8000-000000000005'};
export async function storageReauthorizationFixture(){
 const i=storageIds,bundle=await build({stdin:{contents:`import React from 'react';import{createRoot}from'react-dom/client';import{ProjectFilesPanel}from'./src/components/ProjectFilesPanel';import{setClientIdentity}from'./src/lib/client';import './src/app/globals.css';setClientIdentity('${i.user}');createRoot(document.getElementById('root')!).render(<main style={{maxWidth:1100,margin:'48px auto',padding:24}}><ProjectFilesPanel userId="${i.user}" companyName="Aster Film Studio" companyId="${i.company}" projectId="${i.project}" isAdmin={new URL(location.href).searchParams.get('role')!=='member'}/></main>);`,loader:'tsx',resolveDir:process.cwd()},bundle:true,write:false,outdir:resolve('test-memory-output'),jsx:'automatic',platform:'browser',format:'esm',define:{'process.env.NODE_ENV':'"development"'}});
 const js=bundle.outputFiles.find(f=>f.path.endsWith('.js'))!.text,css=bundle.outputFiles.find(f=>f.path.endsWith('.css'))?.text??'';
 const initial=()=>({id:i.connection,name:'Production media',provider:'runpod' as const,region:'US-NC-2' as const,volumeId:'fixture-retained-volume',status:'revoked' as 'configured'|'revoked',revision:2,createdAt:'2026-09-28T10:00:00Z',credentialsConfigured:false,providerVerified:false as const});
 const state={connection:initial(),mode:'normal' as 'normal'|'lost'|'absent'|'conflict',readStatus:200,requests:[] as {path:string;method:string;body:unknown}[],receipts:new Map<string,{connectionId:string;appliedRevision:number}>(),reset(){this.connection=initial();this.mode='normal';this.readStatus=200;this.requests.length=0;this.receipts.clear();}};
 const path=`/api/companies/${i.company}/storage-connections`,files=`/api/companies/${i.company}/studio/projects/${i.project}/files`;
 const server=createServer(async(req,res)=>{
  if(req.url==='/ui.js'){res.setHeader('Content-Type','text/javascript');res.end(js);return;}if(req.url==='/ui.css'){res.setHeader('Content-Type','text/css');res.end(css);return;}
  if(!req.url?.startsWith('/api/')){res.setHeader('Content-Type','text/html');res.end('<!doctype html><html><head><meta name="viewport" content="width=device-width, initial-scale=1"><link rel="stylesheet" href="/ui.css"></head><body><div id="root"></div><script type="module" src="/ui.js"></script></body></html>');return;}
  const chunks:Buffer[]=[];for await(const part of req)chunks.push(Buffer.from(part));const raw=Buffer.concat(chunks).toString(),body=raw?JSON.parse(raw):undefined;state.requests.push({path:req.url,method:req.method!,body});res.setHeader('Content-Type','application/json');const reply=(value:unknown,status=200)=>{res.statusCode=status;res.end(JSON.stringify(value));};
  if(req.url===path&&req.method==='GET'){reply({connections:[state.connection]});return;}
  if(req.url===files){reply({binding:{id:i.binding,projectId:i.project,connectionId:i.connection,revision:4,createdAt:'2026-09-28T10:00:00Z',connection:state.connection},items:[{kind:'folder',id:'60000000-0000-4000-8000-000000000006',parentId:null,name:'01_Brief',createdAt:'2026-09-28T10:00:00Z'}],breadcrumbs:[],page:{limit:50,hasMore:false,nextAfter:null},transfers:{available:false,code:'STORAGE_GATEWAY_UNAVAILABLE',message:'Synthetic local fixture. No provider or file transfer is connected.'}});return;}
  if(req.url===files+'/folder-plans?limit=20'){reply({plans:[],page:{nextAfter:null}});return;}
  if(req.url===path+'/'+i.connection+'/reauthorize'&&req.method==='POST'){
   const parsed=projectStorageConnectionReauthorizeInput.safeParse(body);if(!parsed.success){reply({error:'Invalid fixture request'},400);return;}const data=parsed.data;
   if(state.mode==='conflict'){state.connection={...state.connection,revision:3};reply({error:'The connection changed.',code:'STORAGE_REVISION_CONFLICT'},409);return;}
   if(data.revision!==state.connection.revision){reply({error:'The connection changed.',code:'STORAGE_REVISION_CONFLICT'},409);return;}
   if(state.mode==='absent'){reply({error:'Synthetic response unavailable.'},502);return;}
   state.connection={...state.connection,revision:state.connection.revision+1,status:'configured',credentialsConfigured:true};const receipt={connectionId:i.connection,appliedRevision:state.connection.revision};state.receipts.set(data.clientId,receipt);
   if(state.mode==='lost'){reply({error:'Synthetic response unavailable.'},502);return;}reply({reauthorization:receipt,connection:state.connection,replayed:false});return;
  }
  if(req.url.startsWith(path+'/'+i.connection+'/reauthorize/')&&req.method==='GET'){if(state.readStatus!==200){reply({error:'Status access is unavailable.'},state.readStatus);return;}const receipt=state.receipts.get(req.url.split('/').at(-1)!);reply({recorded:!!receipt,...receipt?{reauthorization:receipt}:{},connection:state.connection});return;}
  if(req.url===path+'/'+i.connection&&req.method==='PATCH'){const data=projectStorageConnectionRevokeInput.parse(body);if(data.revision!==state.connection.revision){reply({error:'The connection changed.'},409);return;}state.connection={...state.connection,revision:state.connection.revision+1,status:'revoked',credentialsConfigured:false};reply({connection:state.connection});return;}
  reply({error:'Unexpected synthetic request'},404);
 });
 await new Promise<void>(done=>server.listen(0,'127.0.0.1',done));return{server,state,origin:'http://127.0.0.1:'+(server.address() as {port:number}).port,close:()=>new Promise<void>(done=>server.close(()=>done()))};
}
