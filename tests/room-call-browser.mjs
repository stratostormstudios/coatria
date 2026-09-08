// Opt-in browser integration test. Uses actual RoomCall + signaling handlers +
// a disposable local database fixture, with synthetic audio/video only.
// node --env-file=.env.local --import tsx tests/room-call-browser.mjs
// Set COATRIA_PLAYWRIGHT_MODULE to Playwright's module path if not installed locally.
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { randomUUID } from 'node:crypto';
import { createRequire } from 'node:module';
import { resolve } from 'node:path';
import { readdir, readFile } from 'node:fs/promises';
import { query, database } from '../src/lib/db.ts';
import { hashToken } from '../src/lib/security.ts';
import { GET, POST } from '../src/app/api/companies/[companyId]/signals/route.ts';

const require=createRequire(import.meta.url);
const {build}=require('esbuild');
const {chromium}=require(process.env.COATRIA_PLAYWRIGHT_MODULE||'playwright');
let stopEmulator;
if(process.env.COATRIA_TEST_EMULATOR==='1'){
  const {PGlite}=await import('@electric-sql/pglite');const {PGLiteSocketServer}=await import('@electric-sql/pglite-socket');
  const db=await PGlite.create();for(const file of(await readdir(resolve('database'))).filter(name=>/^\d.*\.sql$/.test(name)).sort())await db.exec(await readFile(resolve('database',file),'utf8'));
  const socket=new PGLiteSocketServer({db,host:'127.0.0.1',port:0,maxConnections:1});await socket.start();
  process.env.DATABASE_URL=`postgresql://postgres:postgres@${socket.getServerConn()}/postgres`;process.env.DATABASE_POOL_MAX='1';
  stopEmulator=async()=>{await socket.stop();await db.close();};
}
if(!process.env.DATABASE_URL||!['localhost','127.0.0.1'].includes(new URL(process.env.DATABASE_URL).hostname))throw new Error('Browser fixtures require an explicitly configured local database.');
const company=randomUUID(),rooms=[randomUUID(),randomUUID()],people=[0,1].map(index=>({id:randomUUID(),session:randomUUID(),name:`Media QA ${index+1}`}));
const report={passed:[],audio:[],video:null};
let browser,server,fixtureCreated=false;
try{
  await query("INSERT INTO companies(id,name,slug,template) VALUES($1,'Media browser QA',$2,'blank')",[company,`media-${company}`]);
  fixtureCreated=true;
  for(const [index,room] of rooms.entries())await query("INSERT INTO rooms(id,company_id,name,kind,capacity) VALUES($1,$2,$3,'meeting',6)",[room,company,`Media test room ${index+1}`]);
  for(const person of people){
    await query("INSERT INTO users(id,name,email,password_hash) VALUES($1,$2,$3,'test-session-only')",[person.id,person.name,`${person.id}@example.invalid`]);
    await query("INSERT INTO memberships(company_id,user_id,role) VALUES($1,$2,'member')",[company,person.id]);
    await query("INSERT INTO sessions(token_hash,user_id,expires_at) VALUES($1,$2,now()+interval '1 hour')",[hashToken(person.session),person.id]);
  }
  const bundle=await build({stdin:{contents:`import React from 'react';import{createRoot}from'react-dom/client';import RoomCall from './src/components/RoomCall.tsx';function Harness(){const[room,setRoom]=React.useState(window.fixture.rooms[0]);window.switchTestRoom=()=>setRoom(window.fixture.rooms[1]);return React.createElement(RoomCall,{companyId:window.fixture.company,roomId:room,user:window.fixture.user});}createRoot(document.getElementById('root')).render(React.createElement(Harness));`,resolveDir:resolve('.'),sourcefile:'call-fixture.tsx',loader:'tsx'},bundle:true,write:false,format:'iife',platform:'browser',jsx:'automatic',define:{'process.env.NODE_ENV':'"production"'},logLevel:'silent'});
  let origin='';
  server=createServer(async(req,res)=>{
    try{
      const url=new URL(req.url,origin);
      if(url.pathname==='/bundle.js'){res.writeHead(200,{'Content-Type':'text/javascript'});res.end(bundle.outputFiles[0].text);return;}
      if(url.pathname==='/'){
        const person=people[Number(url.searchParams.get('person'))||0];
        const config={company,rooms,user:{id:person.id,name:person.name}};
        res.writeHead(200,{'Content-Type':'text/html'});res.end(`<html><head><title>Coatria media integration QA</title></head><body><div id="root"></div><script>window.fixture=${JSON.stringify(config)}</script><script src="/bundle.js"></script></body></html>`);return;
      }
      if(url.pathname!==`/api/companies/${company}/signals`){res.writeHead(404);res.end();return;}
      const chunks=[];for await(const chunk of req)chunks.push(chunk);
      const request=new Request(url,{method:req.method,headers:req.headers,body:req.method==='POST'?Buffer.concat(chunks):undefined});
      const context={params:Promise.resolve({companyId:company})};
      const response=await (req.method==='POST'?POST(request,context):GET(request,context));
      res.writeHead(response.status,Object.fromEntries(response.headers));res.end(await response.text());
    }catch{res.writeHead(500);res.end('{"error":"Fixture server failed."}');}
  });
  await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));origin=`http://127.0.0.1:${server.address().port}`;
  browser=await chromium.launch({...(process.env.COATRIA_BROWSER_PATH?{executablePath:process.env.COATRIA_BROWSER_PATH}:{}),headless:true,args:['--use-fake-device-for-media-stream','--use-fake-ui-for-media-stream','--autoplay-policy=no-user-gesture-required','--enable-unsafe-swiftshader']});
  const pages=[];
  for(let index=0;index<2;index++){
    const context=await browser.newContext({permissions:['microphone']});
    await context.addCookies([{name:'coatria_session',value:people[index].session,url:origin,httpOnly:true,sameSite:'Lax'}]);
    await context.addInitScript(()=>{
      window.testPeers=[];window.testTracks=[];window.deferScreen=false;
      const Peer=window.RTCPeerConnection;
      window.RTCPeerConnection=class extends Peer{constructor(options){super(options);window.testPeers.push(this);}};
      const original=navigator.mediaDevices.getUserMedia.bind(navigator.mediaDevices);
      navigator.mediaDevices.getUserMedia=async constraints=>{const stream=await original(constraints);window.testTracks.push(...stream.getTracks());return stream;};
      navigator.mediaDevices.getDisplayMedia=()=>{
        const canvas=document.createElement('canvas');canvas.width=320;canvas.height=180;const ctx=canvas.getContext('2d');let frame=0;
        const draw=setInterval(()=>{ctx.fillStyle=++frame%2?'#c9f16f':'#294735';ctx.fillRect(0,0,320,180);},80);
        const stream=canvas.captureStream(10);window.testTracks.push(...stream.getTracks());
        stream.getVideoTracks()[0].addEventListener('ended',()=>clearInterval(draw));
        return window.deferScreen?new Promise(resolve=>{window.resolveTestScreen=()=>resolve(stream);}):Promise.resolve(stream);
      };
    });
    const page=await context.newPage();await page.goto(`${origin}/?person=${index}`);pages.push(page);
  }
  const[a,b]=pages;
  async function waitForMediaStats(page,kind){
    const deadline=Date.now()+20000;
    while(Date.now()<deadline){
      const evidence=await page.evaluate(async kind=>{for(const peer of window.testPeers){if(peer.connectionState!=='connected')continue;for(const item of(await peer.getStats()).values())if(item.type==='inbound-rtp'&&item.kind===kind&&item.bytesReceived>0&&(kind!=='video'||item.framesDecoded>0))return{bytesReceived:item.bytesReceived,packetsReceived:item.packetsReceived,...(kind==='video'?{framesDecoded:item.framesDecoded}:{})};}return null;},kind);
      if(evidence)return evidence;
      await new Promise(resolve=>setTimeout(resolve,200));
    }
    throw new Error(`No decoded incoming ${kind} media reached the other participant.`);
  }
  await Promise.all(pages.map(page=>page.getByRole('button',{name:'Join room audio'}).click()));
  for(const page of pages)await page.waitForFunction(()=>window.testPeers.some(peer=>peer.connectionState==='connected'),{},{timeout:30000});
  for(const page of pages){
    report.audio.push(await waitForMediaStats(page,'audio'));
  }
  report.passed.push('Two isolated authenticated participants receive real WebRTC audio packets.');
  await a.getByRole('button',{name:'Share screen',exact:true}).click();
  report.video=await waitForMediaStats(b,'video');assert.ok(report.video.framesDecoded>0);
  await a.getByRole('button',{name:'Stop sharing',exact:true}).click();
  await a.waitForFunction(()=>window.testTracks.filter(track=>track.kind==='video').every(track=>track.readyState==='ended'));
  await b.waitForFunction(()=>[...document.querySelectorAll('video')].every(video=>!video.srcObject?.getVideoTracks().length),{},{timeout:15000});
  report.passed.push('Synthetic selected-screen frames cross WebRTC, and stopping removes the remote frame.');
  await a.evaluate(()=>{window.deferScreen=true;});await a.getByRole('button',{name:'Share screen',exact:true}).click();
  await a.waitForFunction(()=>typeof window.resolveTestScreen==='function');
  await a.evaluate(()=>window.switchTestRoom());
  await a.getByRole('button',{name:'Join room audio'}).click();
  await a.getByRole('button',{name:'Leave call'}).waitFor();
  await a.evaluate(()=>window.resolveTestScreen());
  await a.waitForFunction(()=>window.testTracks.filter(track=>track.kind==='video').every(track=>track.readyState==='ended'));
  assert.equal(await a.getByText('Your selected screen is visible to everyone in this room call.').count(),0);
  report.passed.push('A pending screen picker cannot attach to a different room or later call.');
  await query("UPDATE memberships SET role='removed' WHERE company_id=$1 AND user_id=$2",[company,people[1].id]);
  await b.getByRole('button',{name:'Join room audio'}).waitFor({timeout:12000});
  assert.equal(await b.evaluate(()=>window.testTracks.every(track=>track.readyState==='ended')),true);
  assert.equal(await b.evaluate(()=>window.testPeers.every(peer=>peer.connectionState==='closed')),true);
  report.passed.push('Membership revocation stops local capture and closes peer connections.');
  await a.route('**/signals*',route=>route.abort());
  await a.evaluate(()=>{window.originalTestNow=Date.now;Date.now=()=>window.originalTestNow()+60000;});
  await a.getByRole('button',{name:'Join room audio'}).waitFor({timeout:6000});
  assert.equal(await a.evaluate(()=>window.testTracks.every(track=>track.readyState==='ended')),true);
  report.passed.push('The authorization watchdog stops capture when access cannot be refreshed for 45 seconds.');
  await a.evaluate(()=>{Date.now=window.originalTestNow;});await a.unroute('**/signals*');
  await a.getByRole('button',{name:'Join room audio'}).click();await a.getByRole('button',{name:'Leave call'}).waitFor();
  await a.getByRole('button',{name:'Leave call'}).click();
  assert.equal(await a.evaluate(()=>window.testTracks.every(track=>track.readyState==='ended')),true);
  report.passed.push('Leaving stops all remaining local media.');
  console.log(JSON.stringify(report,null,2));
}finally{
  await browser?.close();
  if(server)await new Promise(resolve=>server.close(resolve));
  if(fixtureCreated){await query('DELETE FROM companies WHERE id=$1',[company]);await query('DELETE FROM users WHERE id=ANY($1::uuid[])',[people.map(person=>person.id)]);}
  await database().end();
  await stopEmulator?.();
}
