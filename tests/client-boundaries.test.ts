import {test} from 'node:test';
import assert from 'node:assert/strict';
import {createServer,type Server} from 'node:http';
import {execFile} from 'node:child_process';
import {mkdtemp,mkdir,writeFile,symlink,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {resolve,join,relative,isAbsolute} from 'node:path';

async function listen(server:Server){await new Promise<void>(resolve=>server.listen(0,'127.0.0.1',resolve));const address=server.address();assert(address&&typeof address!=='string');return 'http://127.0.0.1:'+address.port;}
const close=(server:Server)=>new Promise<void>((resolve,reject)=>server.close(error=>error?reject(error):resolve()));
function cli(script:string,args:string[],environment:Record<string,string>){return new Promise<{code:number;stdout:string;stderr:string}>(resolveResult=>execFile(process.execPath,[resolve('scripts',script),...args],{env:{NODE_ENV:'test',PATH:process.env.PATH,SystemRoot:process.env.SystemRoot,...environment},timeout:15000,maxBuffer:1000000},(error,stdout,stderr)=>resolveResult({code:error?typeof error.code==='number'?error.code:1:0,stdout,stderr})));}

test('agent and storage adapters never forward scoped credentials through HTTP redirects',async()=>{
  const temporary=await mkdtemp(join(tmpdir(),'coatria-adapter-boundary-'));
  let redirectedRequests=0;const receivedTokens:string[]=[];
  const destination=createServer((_request,response)=>{redirectedRequests++;response.end('{}');});
  const destinationOrigin=await listen(destination);
  const source=createServer((request,response)=>{receivedTokens.push(request.headers.authorization||'');response.writeHead(302,{Location:destinationOrigin+'/capture'});response.end();});
  const origin=await listen(source);
  try{
    const agentToken='ca_local-adapter-security-fixture',connectorToken='cd_local-adapter-security-fixture';
    const agent=await cli('agent-client.mjs',['--url',origin],{COATRIA_AGENT_TOKEN:agentToken});
    const connector=await cli('connector.mjs',['--url',origin,'--root',temporary,'--once'],{COATRIA_CONNECTOR_TOKEN:connectorToken});
    assert.equal(agent.code,1);assert.equal(connector.code,1);
    assert.deepEqual(receivedTokens,[`Bearer ${agentToken}`,`Bearer ${connectorToken}`]);
    assert.equal(redirectedRequests,0,'A redirect target must never receive an integration request.');
    for(const result of[agent,connector])for(const token of[agentToken,connectorToken])assert.equal((result.stdout+result.stderr).includes(token),false);
  }finally{await close(source);await close(destination);const path=relative(tmpdir(),temporary);assert(path&&!path.startsWith('..')&&!isAbsolute(path));await rm(temporary,{recursive:true,force:true});}
});

test('the running connector sends only approved relative metadata, including with an outside junction present',async()=>{
  const temporary=await mkdtemp(join(tmpdir(),'coatria-manifest-boundary-')),root=join(temporary,'approved'),outside=join(temporary,'outside');
  await mkdir(root);await mkdir(outside);await mkdir(join(root,'media'));
  await writeFile(join(root,'media','clip.mov'),'CONFIDENTIAL FILE CONTENT MUST NEVER BE SENT');
  await writeFile(join(root,'.env'),'PRIVATE ENVIRONMENT CONTENT');await writeFile(join(outside,'outside-secret.mov'),'OUTSIDE SECRET CONTENT');
  await symlink(outside,join(root,'outside-link'),process.platform==='win32'?'junction':'dir');
  let received='';
  const server=createServer(async(request,response)=>{if(request.url==='/api/connector/config'){response.setHeader('Content-Type','application/json');response.end('{"mode":"metadata-only"}');return;}for await(const chunk of request)received+=chunk;response.setHeader('Content-Type','application/json');response.end('{"ok":true}');});
  const origin=await listen(server);
  try{
    const token='cd_local-manifest-security-fixture',result=await cli('connector.mjs',['--url',origin,'--root',root,'--once'],{COATRIA_CONNECTOR_TOKEN:token});
    assert.equal(result.code,0,result.stderr);
    const manifest=JSON.parse(received);assert.equal(manifest.status,'online');assert.equal(manifest.files.length,1);assert.equal(manifest.files[0].path,'media/clip.mov');assert.deepEqual(Object.keys(manifest.files[0]).sort(),['modifiedAt','path','size']);
    for(const forbidden of['CONFIDENTIAL FILE CONTENT','PRIVATE ENVIRONMENT','OUTSIDE SECRET','outside-secret','.env',root,outside,token])assert.equal(received.includes(forbidden),false,`Manifest must omit ${forbidden}.`);
    assert.equal((result.stdout+result.stderr).includes(token),false);
  }finally{await close(server);const path=relative(tmpdir(),temporary);assert(path&&!path.startsWith('..')&&!isAbsolute(path));await rm(temporary,{recursive:true,force:true});}
});
