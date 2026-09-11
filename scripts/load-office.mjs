/** Isolated loopback HTTP test. Existing app databases and remote targets are refused. */
import {randomBytes,randomUUID,createHash} from 'node:crypto';
import {createServer} from 'node:net';
import {readFile,readdir,mkdir,writeFile,cp,lstat,realpath,symlink,unlink} from 'node:fs/promises';
import {resolve,dirname,basename} from 'node:path';
import {pathToFileURL} from 'node:url';
import {spawn} from 'node:child_process';
import {setTimeout as delay} from 'node:timers/promises';
import {require as tsxRequire} from 'tsx/cjs/api';

// Only public TypeScript furniture metadata is imported, never purchased files.
const {OFFICE_50_PRESET}=tsxRequire('../src/lib/office-presets.ts',import.meta.url);
export function loadFloorDocument(){return {version:1,items:structuredClone(OFFICE_50_PRESET.layout),floor:{...OFFICE_50_PRESET.floor},revision:0};}
export function loadOfficeMetadata(){return {floor:{...OFFICE_50_PRESET.floor},layoutItems:OFFICE_50_PRESET.layout.length,uniqueAssetCount:new Set(OFFICE_50_PRESET.layout.map(item=>item.assetId).filter(Boolean)).size};}
export const OFFICE_LOAD_POLICY=Object.freeze({workspaceMs:5000,presencePollMs:2000,movementMs:1000,sessionMs:15000,noOverlap:true});

const hash=value=>createHash('sha256').update(value).digest('hex');
export function parseLoadOptions(args){
 const options={clients:50,duration:30,port:4196,mode:'development',report:resolve('..','output','coatria-load',`connections-${Date.now()}.json`)};
 const allowed=new Set(['clients','duration','port','report','mode']);
 for(let i=0;i<args.length;i+=2){const key=args[i]?.replace(/^--/,'');if(!args[i]?.startsWith('--')||!allowed.has(key)||!args[i+1]||args[i+1].startsWith('--'))throw new Error('Use --clients, --duration, --port, --mode and --report only. Remote targets and existing app databases are not supported.');options[key]=key==='report'?resolve(args[i+1]):key==='mode'?args[i+1]:Number(args[i+1]);}
 for(const [key,min,max] of [['clients',2,50],['duration',10,60],['port',1024,65535]])if(!Number.isInteger(options[key])||options[key]<min||options[key]>max)throw new Error(`${key} must be an integer from ${min} to ${max}.`);
 if(!['development','production'].includes(options.mode))throw new Error('mode must be development or production.');
 if(!options.report.endsWith('.json'))throw new Error('The report must be a .json file.');return options;
}
export function validateLoadDatabaseUrl(value){
 let url;try{url=new URL(value);}catch{throw new Error('The load database URL is invalid.');}
 if(!['postgres:','postgresql:'].includes(url.protocol)||!['127.0.0.1','localhost'].includes(url.hostname)||!/^\/coatria_load_[a-z0-9_]{4,50}$/.test(url.pathname)||url.search||url.hash||url.port&&(!/^\d+$/.test(url.port)||Number(url.port)<1024))throw new Error('Use a loopback-only, empty coatria_load_<suffix> PostgreSQL database without query options.');
 return url.href;
}
export async function assertEmptyLoadDatabase(connection){
 const count=Number((await connection.query("SELECT count(*) FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace WHERE n.nspname='public'")).rows[0].count);
 if(count!==0)throw new Error('The dedicated load database is not empty. No migrations or fixture writes were performed.');
}
async function createLoadDatabase(){
 if(process.env.COATRIA_LOAD_DATABASE_URL){
  const url=validateLoadDatabaseUrl(process.env.COATRIA_LOAD_DATABASE_URL),{Pool}=await import('pg'),pool=new Pool({connectionString:url,max:1,connectionTimeoutMillis:5000,statement_timeout:15000});
  try{
   await assertEmptyLoadDatabase(pool);
   const version=(await pool.query("SELECT current_setting('server_version') AS version")).rows[0].version;
   return {db:{query:pool.query.bind(pool),exec:pool.query.bind(pool),close:pool.end.bind(pool)},url,database:'PostgreSQL',version,poolMax:5};
  }catch(error){await pool.end();throw error;}
 }
 const {PGlite}=await import('@electric-sql/pglite');return {db:await PGlite.create(),database:'PGlite',version:'embedded',poolMax:1};
}
export function summarizeRequests(records){
 const times=records.map(record=>record.ms).sort((a,b)=>a-b),quantile=q=>times.length?Math.round(times[Math.ceil(times.length*q)-1]*100)/100:0;
 const unexpectedErrors=records.filter(record=>!record.ok).length;
 return {requests:records.length,unexpectedErrors,errorRate:records.length?unexpectedErrors/records.length:0,p50Ms:quantile(.5),p95Ms:quantile(.95),maxMs:times.length?Math.round(times.at(-1)*100)/100:0,bytesReceived:records.reduce((sum,record)=>sum+record.bytes,0)};
}
export async function readLoadResponse(response,expected){
 let bytes=0,value=null;
 try{
  const text=await response.text();bytes=Buffer.byteLength(text);value=JSON.parse(text);
  return {status:response.status,bytes,value,ok:response.status===expected&&value!==null&&typeof value==='object'&&!Array.isArray(value)};
 }catch{return {status:response.status,bytes,value:null,ok:false};}
}
export function meetsLoadBudget(summary){return summary.requests>0&&summary.unexpectedErrors===0&&Number.isFinite(summary.p95Ms)&&summary.p95Ms<=1000;}
export function loadPosition(index,clients,step=0){
 if(!Number.isInteger(clients)||clients<2||clients>50||!Number.isInteger(index)||index<0||index>=clients||!Number.isInteger(step)||step<0)throw new Error('Movement must use an active test client and a bounded cycle step.');
 return {...OFFICE_50_PRESET.workstations[(index+step)%OFFICE_50_PRESET.workstations.length].approach};
}
export async function assertUnusedPort(port){
 const server=createServer();await new Promise((yes,no)=>{server.once('error',()=>no(new Error('The requested loopback port is already in use. Choose another test port.')));server.listen(port,'127.0.0.1',yes);});await new Promise(yes=>server.close(yes));
}
export async function prepareLoadCheckout(sourceDirectory,runId){
 if(!/^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/.test(runId))throw new Error('An owned random load directory is required.');
 const source=await realpath(sourceDirectory),parent=resolve(source,'.devdata');await mkdir(parent,{recursive:true});
 if((await lstat(parent)).isSymbolicLink()||await realpath(parent)!==parent)throw new Error('The load source directory must stay inside this checkout.');
 const directory=resolve(parent,'load-'+runId);await mkdir(directory);
 const safeCopy=async name=>cp(resolve(source,name),resolve(directory,name),{recursive:true,errorOnExist:true,force:false,filter:async file=>{if((await lstat(file)).isSymbolicLink())throw new Error('Load source copies cannot include source symlinks.');return true;}});
 // Explicit allowlist excludes environment/deployment state and paid files.
 for(const name of ['src','public','package.json','package-lock.json','next.config.ts','tsconfig.json','next-env.d.ts'])await safeCopy(name);
 const dependencyTarget=await realpath(resolve(source,'node_modules')),dependencyLink=resolve(directory,'node_modules');
 await symlink(dependencyTarget,dependencyLink,process.platform==='win32'?'junction':'dir');
 return {directory,parent,dependencyTarget,dependencyLink};
}
export async function releaseLoadCheckoutDependencies(checkout){
 if(dirname(checkout.directory)!==checkout.parent||!/^load-[a-f0-9-]{36}$/.test(basename(checkout.directory))||await realpath(checkout.directory)!==checkout.directory||checkout.dependencyLink!==resolve(checkout.directory,'node_modules'))throw new Error('The owned dependency link could not be verified.');
 const info=await lstat(checkout.dependencyLink);
 if(!info.isSymbolicLink()||await realpath(checkout.dependencyLink)!==checkout.dependencyTarget)throw new Error('The owned dependency link changed.');
 // unlink removes this link only. Never recursively remove node_modules.
 await unlink(checkout.dependencyLink);
}
async function stopChild(child){
 if(!child||child.exitCode!==null)return;
 if(process.platform==='win32')await new Promise(yes=>{const kill=spawn('taskkill',['/PID',String(child.pid),'/T','/F'],{windowsHide:true,stdio:'ignore'});kill.once('exit',yes);kill.once('error',yes);});
 else {child.kill('SIGTERM');await Promise.race([new Promise(yes=>child.once('exit',yes)),delay(5000)]);if(child.exitCode===null)child.kill('SIGKILL');}
}
export async function runOfficeLoad(options){
 if(process.env.VERCEL||process.env.NODE_ENV==='production')throw new Error('Run this isolated local harness from a development checkout, never a production process.');
 await assertUnusedPort(options.port);
 const fixture=await createLoadDatabase(),{db}=fixture,companyId=randomUUID(),otherCompanyId=randomUUID(),run=randomUUID();
 const clients=Array.from({length:options.clients},(_,index)=>({id:randomUUID(),token:randomBytes(32).toString('base64url'),taskId:randomUUID(),messageClientId:randomUUID(),index}));
 const outsider={id:randomUUID(),token:randomBytes(32).toString('base64url'),index:-1},expired={id:randomUUID(),token:randomBytes(32).toString('base64url'),index:-2};
 const identities=[...clients,outsider,expired],companyIds=[companyId,otherCompanyId],userIds=identities.map(client=>client.id);
 const origin=`http://127.0.0.1:${options.port}`,policy={...OFFICE_LOAD_POLICY,conversationPollMs:2000,conversationPageLimit:100,conversationPagesPerCycle:8};
 const records=[],checks=[],positions=new Map(),conversations=new Map(clients.map(client=>[client.id,{cursor:'0',messages:new Map(),events:0}])),conversationErrors=[];let socket,child,checkout,serverFailure=false,phase='check',warm=false,start=0,loadDuration=0;
 const cleanup={verified:false,remainingUsers:identities.length,remainingCompanies:2};
 let fatal='';
 const check=(id,label,passed,detail)=>{checks.push({id,label,passed:Boolean(passed),detail});if(!passed)console.log(`Check failed: ${label}`);};
 async function request(client,path,method='GET',data,operation='verification',expected=200,extraHeaders={}){
  const began=performance.now();let status=0,bytes=0,value=null,ok=false;
  try{
   const response=await fetch(origin+path,{method,headers:{Origin:origin,Cookie:`coatria_session=${client.token}`,'X-Coatria-User':client.id,...(data?{'Content-Type':'application/json'}:{}),...extraHeaders},...(data?{body:JSON.stringify(data)}:{}),redirect:'error',signal:AbortSignal.timeout(10000)});
   ({status,bytes,value,ok}=await readLoadResponse(response,expected));
  }catch{/* Connection errors and timeouts receive status 0. */}
  const record={operation,phase,ms:performance.now()-began,status,ok,bytes};if(warm)records.push(record);
  return {status,value,ok:record.ok};
 }
 const path=resource=>`/api/companies/${companyId}/${resource}`;
 const conversationPath=resource=>path('conversations/commons/'+resource);
 const sequence=value=>typeof value==='string'&&/^(0|[1-9]\d{0,18})$/.test(value)&&BigInt(value)<=9223372036854775807n;
 function mergeMessage(state,message){
  if(!message||typeof message.id!=='string'||!sequence(message.sequence)||!sequence(message.lastEventSequence)||BigInt(message.lastEventSequence)<BigInt(message.sequence))return false;
  const current=state.messages.get(message.id);if(!current||BigInt(message.lastEventSequence)>=BigInt(current.lastEventSequence))state.messages.set(message.id,message);return true;
 }
 async function bootstrapConversation(client){
  const result=await request(client,conversationPath('messages?limit=100'),'GET',undefined,'conversation-history'),state=conversations.get(client.id);
  if(!result.ok||!sequence(result.value?.conversation?.lastSequence)||!Array.isArray(result.value.messages)||result.value.hasMore){conversationErrors.push('Initial history was not a complete valid fixture snapshot.');return false;}
  state.cursor=result.value.conversation.lastSequence;for(const message of result.value.messages)if(!mergeMessage(state,message)){conversationErrors.push('Initial history contained an invalid message projection.');return false;}return true;
 }
 async function pollConversation(client){
  const state=conversations.get(client.id);
  for(let pageIndex=0;pageIndex<policy.conversationPagesPerCycle;pageIndex++){
   const result=await request(client,conversationPath(`events?after=${state.cursor}&limit=${policy.conversationPageLimit}`),'GET',undefined,'conversation-events'),page=result.value;
   if(!result.ok)return false;
   if(!page||page.resetRequired!==false||!Array.isArray(page.events)||page.events.length>policy.conversationPageLimit||!sequence(page.cursor)||!sequence(page.lastSequence)||typeof page.hasMore!=='boolean'){conversationErrors.push('An event page violated the durable stream contract.');return false;}
   let next=BigInt(state.cursor);
   for(const event of page.events){
    if(!sequence(event.sequence)||BigInt(event.sequence)!==next+1n||!['message.created','message.edited','message.deleted','reaction.changed','read.updated'].includes(event.type)||event.message&&!mergeMessage(state,event.message)||event.parentMessage&&!mergeMessage(state,event.parentMessage)){conversationErrors.push('An event page had a sequence gap or invalid projection.');return false;}
    next=BigInt(event.sequence);state.events++;
   }
   if(BigInt(page.cursor)!==next||next>BigInt(page.lastSequence)||page.hasMore&&(!page.events.length||next>=BigInt(page.lastSequence))||!page.hasMore&&next!==BigInt(page.lastSequence)){conversationErrors.push('An event page advanced an invalid cursor.');return false;}
   state.cursor=page.cursor;if(!page.hasMore)return true;
  }
  // The next cadence resumes at this exact cursor; bounded work never skips events.
  return true;
 }
 const move=async(client,step=0)=>{
  const {x,z}=loadPosition(client.index,options.clients,step);
  const data={roomId:null,x,z,status:'available'},result=await request(client,path('presence'),'POST',data,'presence-write');
  if(result.ok)positions.set(client.id,{x,z});return result;
 };
 try{
  checkout=await prepareLoadCheckout(process.cwd(),run);
  await db.exec('CREATE TABLE schema_migrations(name text PRIMARY KEY,applied_at timestamptz NOT NULL DEFAULT now())');
  for(const name of (await readdir(resolve('database'))).filter(name=>/^\d.*\.sql$/.test(name)).sort()){await db.exec(await readFile(resolve('database',name),'utf8'));await db.query('INSERT INTO schema_migrations(name) VALUES($1)',[name]);}
  await db.query('INSERT INTO companies(id,name,slug,template,layout) VALUES($1,$2,$3,$4,$5),($6,$7,$8,$4,$5)',[companyId,'Isolated HTTP load office','load-'+run,'blank',JSON.stringify(loadFloorDocument()),otherCompanyId,'Isolation sentinel office','other-'+run]);
  for(const client of identities){
   await db.query('INSERT INTO users(id,name,email,password_hash) VALUES($1,$2,$3,$4)',[client.id,`Load session ${client.index+1}`,`${client.id}@load.example.invalid`,randomBytes(48).toString('hex')]);
   await db.query('INSERT INTO sessions(token_hash,user_id,expires_at) VALUES($1,$2,now()+interval \'1 hour\')',[hash(client.token),client.id]);
   await db.query('INSERT INTO memberships(company_id,user_id,role) VALUES($1,$2,$3)',[client===outsider?otherCompanyId:companyId,client.id,client.index===0||client===outsider?'owner':'member']);
   if(client.index>=0)await db.query('INSERT INTO tasks(id,company_id,title,created_by,assignee_id) VALUES($1,$2,$3,$4,$4)',[client.taskId,companyId,`Load task ${client.index}`,client.id]);
  }
  if(!fixture.url){const {PGLiteSocketServer}=await import('@electric-sql/pglite-socket');socket=new PGLiteSocketServer({db,host:'127.0.0.1',port:0,maxConnections:1});await socket.start();const url=new URL('postgresql://127.0.0.1');url.username='postgres';url.password='postgres';url.host=socket.getServerConn();url.pathname='/postgres';fixture.url=url.href;}
  const env={...process.env,DATABASE_URL:fixture.url,DATABASE_POOL_MAX:String(fixture.poolMax),APP_URL:origin,COATRIA_BUILD_DIR:'.next-load',NODE_ENV:options.mode,NEXT_TELEMETRY_DISABLED:'1',VERCEL:'',VERCEL_URL:'',TRUST_PROXY:'false'};
  if(options.mode==='production'){
   console.log('Building the isolated production Next server…');
   child=spawn(process.execPath,[resolve('node_modules/next/dist/bin/next'),'build','--webpack'],{cwd:checkout.directory,env,windowsHide:true,stdio:['ignore','pipe','pipe']});
   let output='';const capture=bytes=>{output=(output+bytes.toString()).slice(-20000);};child.stdout.on('data',capture);child.stderr.on('data',capture);
   const code=await Promise.race([new Promise(yes=>{child.once('exit',yes);child.once('error',()=>yes(-1));}),delay(300000,undefined,{ref:false}).then(()=>-1)]);
   if(code!==0){console.error(output.replace(/(?:postgres(?:ql)?|mysql|mongodb):\/\/[^\s"']+/g,'[database URL redacted]').replace(/\b(?:vcp_|msy_|gh[pousr]_)[A-Za-z0-9_-]+/g,'[token redacted]'));throw new Error('The isolated production build failed.');}
  }
  child=spawn(process.execPath,[resolve('node_modules/next/dist/bin/next'),options.mode==='production'?'start':'dev',...(options.mode==='development'?['--webpack']:[]),'--hostname','127.0.0.1','--port',String(options.port)],{cwd:checkout.directory,env,windowsHide:true,stdio:'ignore'});
  child.once('error',()=>{serverFailure=true;});
  console.log(`Starting isolated ${options.mode} Next HTTP server with ${fixture.database}…`);
  for(let attempt=0;attempt<90;attempt++){
   if(serverFailure||child.exitCode!==null)throw new Error('The isolated Next server could not start.');
   try{if((await fetch(origin+'/api/health',{signal:AbortSignal.timeout(1500)})).status===200)break;}catch{}
   if(attempt===89)throw new Error('The isolated Next server did not become ready.');await delay(500);
  }
  // Warm route compilation before measuring request latency.
  await request(clients[0],'/api/session');await request(clients[0],path('workspace'));await move(clients[0]);await request(clients[0],conversationPath('messages?limit=100'));await request(clients[0],conversationPath('events?after=0&limit=100'));
  warm=true;start=performance.now();
  const initial=await Promise.all(clients.map(client=>move(client)));
  check('independent-sessions','Independent authenticated clients connected',initial.every(result=>result.ok)&&new Set(clients.map(client=>client.token)).size===options.clients,`${options.clients} distinct users and opaque sessions made real HTTP presence writes.`);
  const roster=await request(clients[0],path('presence'));check('initial-roster','Every connected client appears exactly once',roster.ok&&roster.value?.presence?.length===options.clients&&new Set(roster.value.presence.map(person=>person.userId)).size===options.clients,`Expected ${options.clients} presence entries.`);
  const bootstrapped=await Promise.all(clients.map(bootstrapConversation));check('conversation-bootstrap','Every session starts from a consistent history cursor',bootstrapped.every(Boolean),`${options.clients} independent history snapshots and event cursors were initialized before concurrent sends.`);
  console.log(`Measuring ${options.clients} sessions for ${options.duration} seconds; movement every 1 s, presence and conversation events every 2 s, workspace every 5 s…`);
  phase='load';const began=performance.now(),until=began+options.duration*1000;
  async function cadence(client,period,operation){
   await delay(period*client.index/options.clients);let count=0;
   while(performance.now()<until){const tick=performance.now();await operation(client,++count);await delay(Math.max(0,Math.min(until-performance.now(),period-(performance.now()-tick))));}
  }
  let posted=[],retried=[];
  const payload=client=>({body:`Load visibility ${run} ${client.index}`,clientId:client.messageClientId});
  const collaboration=(async()=>{
   posted=await Promise.all(clients.map(client=>request(client,conversationPath('messages'),'POST',payload(client),'chat-write',201)));
   retried=await Promise.all(clients.map(client=>request(client,conversationPath('messages'),'POST',payload(client),'chat-retry',200)));
   await Promise.all(clients.map(client=>request(client,path('tasks/'+client.taskId),'PATCH',{title:`Updated load task ${client.index}`,status:'doing'},'task-write')));
  })();
  await Promise.all([collaboration,...clients.flatMap(client=>[
   cadence(client,policy.movementMs,move),
   cadence(client,policy.presencePollMs,client=>request(client,path('presence'),'GET',undefined,'presence-read')),
   cadence(client,policy.conversationPollMs,pollConversation),
   cadence(client,policy.workspaceMs,client=>request(client,path('workspace'),'GET',undefined,'workspace-read')),
   cadence(client,policy.sessionMs,client=>request(client,'/api/session','GET',undefined,'session-read'))
  ])]);loadDuration=(performance.now()-began)/1000;phase='check';
  const observations=await Promise.all([clients[0],clients[Math.floor(clients.length/2)],clients.at(-1)].map(client=>request(client,path('workspace'))));
  const messageIds=new Set(posted.flatMap(result=>result.value?.message?.id?[result.value.message.id]:[]));
  const drained=await Promise.all(clients.map(pollConversation)),histories=await Promise.all([clients[0],clients[Math.floor(clients.length/2)],clients.at(-1)].map(client=>request(client,conversationPath('messages?limit=100'),'GET',undefined,'conversation-history')));
  check('chat-idempotency','Retrying every client send does not create duplicate messages',posted.length===options.clients&&posted.every(result=>result.ok)&&retried.length===options.clients&&retried.every((result,index)=>result.ok&&result.value?.replayed===true&&result.value.message?.id===posted[index].value?.message?.id)&&histories.every(result=>result.ok&&result.value.messages?.length===options.clients),`${options.clients} original UUIDs were retried through real HTTP; each returned its original message ID.`);
  check('chat-visibility','Concurrent messages are visible through history and every event stream',messageIds.size===options.clients&&drained.every(Boolean)&&histories.every(result=>result.ok&&[...messageIds].every(id=>result.value.messages.some(message=>message.id===id)))&&clients.every(client=>[...messageIds].every(id=>conversations.get(client.id).messages.has(id)))&&observations.every(result=>result.ok&&[...messageIds].every(id=>result.value.messages.some(message=>message.id===id))),`${options.clients} concurrent submissions reached all ${options.clients} event projections, three history snapshots and three compatible workspace snapshots.`);
  check('conversation-order','Independent cursors delivered contiguous committed event sequences',conversationErrors.length===0&&clients.every(client=>conversations.get(client.id).events===options.clients),`${options.clients} independent streams each received ${options.clients} creation events without gaps, duplicates or invalid cursor advancement.`);
  check('task-visibility','Concurrent task updates are visible across sessions',observations.every(result=>result.ok&&clients.every(client=>result.value.tasks.some(task=>task.id===client.taskId&&task.status==='doing'&&task.title===`Updated load task ${client.index}`))),`${options.clients} independently assigned task updates checked from three sessions.`);
  check('movement-visibility','Latest movement coordinates reach other sessions',observations.every(result=>result.ok&&[...positions].every(([id,point])=>{const person=result.value.presence.find(person=>person.userId===id);return person&&Math.abs(person.x-point.x)<.0001&&Math.abs(person.z-point.z)<.0001;})),'Observers agree with the last acknowledged position for every client.');
  const editedId=posted[0]?.value?.message?.id;
  if(editedId){
   const edited=await request(clients[0],conversationPath('messages/'+editedId),'PATCH',{body:'Edited load contribution',revision:1},'conversation-edit');
   const conflict=await request(clients[0],conversationPath('messages/'+editedId),'PATCH',{body:'Stale content must not win',revision:1},'conversation-conflict',409);
   const reactor=clients.at(-1),reaction=await request(reactor,conversationPath('messages/'+editedId+'/reactions'),'PUT',{emoji:'thumbsup',active:true},'conversation-reaction');
   const propagated=await Promise.all(clients.map(pollConversation));
   check('conversation-mutations','Edits and reactions reach every session and stale edits are rejected',edited.ok&&conflict.ok&&conflict.value?.code==='MESSAGE_CONFLICT'&&reaction.ok&&propagated.every(Boolean)&&clients.every(client=>{const message=conversations.get(client.id).messages.get(editedId);return message?.body==='Edited load contribution'&&message.revision===2&&message.reactions?.some(value=>value.emoji==='thumbsup'&&value.count===1&&value.mine===(client.id===reactor.id));}),`One real edit, a stale revision rejection and one reaction were observed consistently by ${options.clients} clients.`);
   const displayed=histories.at(-1)?.value?.messages||[],readSequence=displayed.reduce((current,message)=>sequence(message.sequence)&&BigInt(message.sequence)>BigInt(current)?message.sequence:current,'0'),beforeRead=conversations.get(clients[0].id).cursor;
   const marked=await request(reactor,conversationPath('read'),'PUT',{sequence:readSequence},'conversation-read-marker'),older=await request(reactor,conversationPath('read'),'PUT',{sequence:'0'},'conversation-read-marker');
   const privateEvent=await request(clients[0],conversationPath(`events?after=${beforeRead}&limit=100`),'GET',undefined,'conversation-events');
   check('conversation-read-marker','Read position is monotonic and peer reading details remain private',marked.ok&&older.ok&&marked.value.conversation?.readSequence===readSequence&&older.value.conversation?.readSequence===readSequence&&marked.value.conversation?.lastSequence===older.value.conversation?.lastSequence&&marked.value.conversation?.unreadCount===0&&privateEvent.ok&&privateEvent.value.events?.some(event=>event.type==='read.updated')&&privateEvent.value.events.every(event=>event.type!=='read.updated'||!event.read), 'A displayed-history read marker advanced once, ignored an older marker, and exposed no reader identity or position to another session.');
  }else check('conversation-mutations','Edits, reactions and read positions were exercised',false,'No accepted message was available for mutation verification.');
  const isolation=await Promise.all([request(outsider,path('workspace'),'GET',undefined,'isolation',404),request(outsider,path('presence'),'POST',{roomId:null,x:0,z:0,status:'available'},'isolation',404),request(outsider,path('messages'),'POST',{body:'must not enter'},'isolation',404),request(clients[0],`/api/companies/${otherCompanyId}/workspace`,'GET',undefined,'isolation',404),request(outsider,conversationPath('messages'),'GET',undefined,'isolation',404),request(outsider,conversationPath('events?after=0'),'GET',undefined,'isolation',404),request(outsider,conversationPath('messages'),'POST',{clientId:randomUUID(),body:'must not enter'},'isolation',404)]);
  check('tenant-isolation','Other-company sessions cannot read or write the office',isolation.every(result=>result.ok),'Seven cross-tenant HTTP requests, including conversation history, events and sends, were denied.');
  const stale=await request(clients[0],path('presence'),'POST',{roomId:null,x:0,z:0,status:'available'},'identity',409,{'X-Coatria-User':outsider.id});check('identity-binding','Stale browser identity cannot overwrite presence',stale.ok,'A mismatched identity assertion was rejected.');
  await db.query('UPDATE sessions SET expires_at=now()-interval \'1 second\' WHERE token_hash=$1 AND user_id=$2',[hash(expired.token),expired.id]);
  const expiry=await request(expired,path('workspace'),'GET',undefined,'session-expiry',401);check('session-expiry','Expired authentication cannot read a workspace',expiry.ok,'The deliberately expired sentinel session received HTTP 401.');
  console.log('Checking real 45-second presence expiry and reconnect; keeping other clients active…');
  const disconnect=Math.min(5,Math.max(1,Math.floor(options.clients/10))),active=clients.slice(0,-disconnect),absent=clients.slice(-disconnect),waitUntil=performance.now()+47000;
  while(performance.now()<waitUntil){await Promise.all(active.map(client=>move(client)));await delay(Math.max(0,Math.min(10000,waitUntil-performance.now())));}
  const expiredPresence=await request(active[0],path('presence'));
  check('presence-expiry','Disconnected clients disappear after the real presence TTL',expiredPresence.ok&&expiredPresence.value.presence.length===active.length&&absent.every(client=>!expiredPresence.value.presence.some(person=>person.userId===client.id)),`${disconnect} clients stopped sending heartbeats for at least 47 seconds; ${active.length} remained active.`);
  const reconnect=await Promise.all(absent.map(client=>move(client,99))),rejoined=await request(active[0],path('presence'));
  check('reconnect','Reconnected clients return without duplicate occupants',reconnect.every(result=>result.ok)&&rejoined.value?.presence?.length===options.clients&&new Set(rejoined.value.presence.map(person=>person.userId)).size===options.clients,'The same valid sessions rejoined through real HTTP presence writes.');
  const afterReconnect=await request(clients[0],conversationPath('messages'),'POST',{clientId:randomUUID(),body:'Conversation continued after reconnect'},'chat-write',201),caughtUp=await Promise.all(clients.map(pollConversation));
  check('conversation-reconnect','Event cursors resume after disconnected clients return',afterReconnect.ok&&caughtUp.every(Boolean)&&conversationErrors.length===0&&clients.every(client=>conversations.get(client.id).messages.get(afterReconnect.value.message?.id)?.body==='Conversation continued after reconnect'),'All sessions resumed their saved event cursor after the real presence-expiry interval and received the new message.');
 }catch(error){fatal=error instanceof Error?error.message:'The isolated test failed.';check('completed','The bounded test completed',false,fatal.replace(/postgres(?:ql)?:\/\/\S+/g,'[redacted]'));}
 finally{
  await stopChild(child);
  try{
   await db.query('DELETE FROM companies WHERE id=ANY($1::uuid[])',[companyIds]);
   await db.query('DELETE FROM users WHERE id=ANY($1::uuid[])',[userIds]);
   const rateKeys=identities.flatMap(client=>[hash(`write:${client.id}`),hash(`chat:${companyId}:${client.id}`),hash(`conversation-read:${companyId}:${client.id}`),hash(`conversation-send:${companyId}:human:${client.id}`)]);await db.query('DELETE FROM rate_limits WHERE key=ANY($1::text[])',[rateKeys]);
   cleanup.remainingUsers=Number((await db.query('SELECT count(*) FROM users WHERE id=ANY($1::uuid[])',[userIds])).rows[0].count);
   cleanup.remainingCompanies=Number((await db.query('SELECT count(*) FROM companies WHERE id=ANY($1::uuid[])',[companyIds])).rows[0].count);cleanup.verified=cleanup.remainingUsers===0&&cleanup.remainingCompanies===0;
  }catch{cleanup.verified=false;}
  if(socket)await socket.stop();await db.close();
  if(checkout){try{await releaseLoadCheckoutDependencies(checkout);check('source-isolation','Next generated files stayed in an owned source copy',true,'Source/build copy retained under .devdata; its dependency link was removed without changing installed dependencies.');}catch{check('source-isolation','Next generated files stayed in an owned source copy',false,'The temporary dependency link could not be safely released.');}}
 }
 const measured=records.filter(record=>record.phase==='load'),summary=summarizeRequests(measured);
 check('request-errors','Measured HTTP requests completed without unexpected errors',summary.requests>0&&summary.unexpectedErrors===0,`${summary.unexpectedErrors} unexpected errors among ${summary.requests} measured requests.`);
 check('cleanup','Only the exact test identities and companies were cleaned up',cleanup.verified,'Owned server stopped, exact fixture IDs removed, fixture database connection closed.');
 const correctnessPassed=checks.every(check=>check.passed),performancePassed=meetsLoadBudget(summary);
 check('latency-budget','p95 request latency meets the 1,000 ms budget',performancePassed,`Measured p95 ${summary.p95Ms} ms; ${summary.unexpectedErrors} unexpected errors. Correctness is reported separately.`);
 const report={schemaVersion:1,kind:'coatria-connections',generatedAt:new Date().toISOString(),summary:{clients:options.clients,durationSeconds:Math.round(loadDuration*100)/100,...summary,requestsPerSecond:loadDuration?Math.round(summary.requests/loadDuration*100)/100:0,correctnessPassed,performancePassed,passed:correctnessPassed&&performancePassed,verificationRequests:records.length-measured.length,wallClockSeconds:start?Math.round((performance.now()-start)/1000):0},checks,environment:{applicationMode:options.mode,database:fixture.database,databaseVersion:fixture.version,isolated:true,origin,databasePoolMax:fixture.poolMax,...loadOfficeMetadata(),limitations:['Real Next HTTP requests with separate authenticated sessions; no browser rendering, assets, WebRTC or network geography are measured.',fixture.database==='PGlite'?'PGlite is a single-connection PostgreSQL emulator. These results do not establish production PostgreSQL concurrency, Vercel capacity or worldwide scale.':'An isolated local PostgreSQL service measures real database concurrency. It does not establish Vercel capacity, internet latency or worldwide scale.','Authentication sessions are inserted only into the owned fixture; signup/password hashing is outside the measured workload.']},policy,metrics:[...new Set(measured.map(record=>record.operation))].map(operation=>({operation,...summarizeRequests(measured.filter(record=>record.operation===operation))})),cleanup};
 await mkdir(dirname(options.report),{recursive:true});await writeFile(options.report,JSON.stringify(report,null,2)+'\n',{flag:'wx'});
 console.log(`Report saved: ${options.report}`);console.log(`${summary.requests} measured HTTP requests; p50 ${summary.p50Ms} ms, p95 ${summary.p95Ms} ms; ${summary.unexpectedErrors} unexpected errors. Correctness: ${correctnessPassed?'passed':'failed'}. Performance budget: ${performancePassed?'passed':'failed'}.`);
 for(const metric of report.metrics)console.log(`${metric.operation}: ${metric.requests} requests, p50 ${metric.p50Ms} ms, p95 ${metric.p95Ms} ms, ${metric.unexpectedErrors} errors.`);
 for(const result of checks)console.log(`${result.passed?'PASS':'FAIL'} ${result.id}: ${result.detail}`);
 return report;
}
if(process.argv[1]&&import.meta.url===pathToFileURL(process.argv[1]).href)runOfficeLoad(parseLoadOptions(process.argv.slice(2))).then(report=>{process.exitCode=report.summary.passed?0:1;}).catch(()=>{console.error('The local load test could not start or save its report. Check the bounded CLI options, unused local port and report path. No remote target is accepted.');process.exitCode=1;});
