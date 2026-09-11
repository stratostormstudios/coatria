import {test,expect,type BrowserContext,type Page} from '@playwright/test';
import {Pool,type PoolClient} from 'pg';
import {randomUUID} from 'node:crypto';
import {dummyPasswordHash,hashToken,secret} from '../../src/lib/security';
import {getOfficeAsset} from '../../src/lib/office-catalog';
import {getOfficeSeats} from '../../src/lib/office-seating';
import type {LayoutItem} from '../../src/lib/floor-plan';

// Opt-in, real HTTP sessions and real private models against a disposable local DB.
// No application requests are intercepted. Both identities and their company are removed.
test('two authenticated browsers share chair claims, reactions and movement, and a seated reload stays seated',async({browser,baseURL},testInfo)=>{
 test.setTimeout(150000);
 const database=process.env.DATABASE_URL;
 test.skip(process.env.COATRIA_INTERACTIONS_REAL_DB!=='1'||!database||!baseURL||![database,baseURL].every(url=>['localhost','127.0.0.1'].includes(new URL(url).hostname)),'Requires an explicitly enabled disposable loopback database and app.');
 const poolOptions={connectionString:database,max:1,idleTimeoutMillis:10,connectionTimeoutMillis:45000,statement_timeout:15000},pool=new Pool(poolOptions),origin=baseURL!,suffix=randomUUID(),users=[{id:randomUUID(),name:'Studio Host',avatar:'city-023',token:secret()},{id:randomUUID(),name:'Studio Colleague',avatar:'city-025',token:secret()}];
 let seedPoolClosed=false;
 const contexts:BrowserContext[]=[];let companyId:string|undefined,primaryError:unknown;const errors:string[]=[];
 const floor={width:20,depth:16},chair=getOfficeAsset('office-chair-009')!;
 const layout:LayoutItem[]=[{id:'shared-chair',type:'asset',assetId:chair.id,label:'Shared review chair',x:(10-chair.width/2)/20*100,y:(8-chair.depth/2)/16*100,w:chair.width/20*100,h:chair.depth/16*100,rotation:0}];
 const seat=getOfficeSeats(layout,floor)[0];
 async function post(context:BrowserContext,path:string,data:unknown,method='POST'){const response=await context.request.fetch(origin+path,{method,headers:{Origin:origin},data});expect(response.ok(),`${method} ${path}: ${await response.text()}`).toBe(true);return response.json();}
 const scene=async(page:Page)=>{try{return await page.evaluate(()=>(window as any).CoatriaScene?.instance?.diagnostics);}catch(error){if(!page.isClosed()&&/Execution context was destroyed|Cannot find context/.test((error as Error).message))return undefined;throw error;}};
 const own=(page:Page,id:string)=>scene(page).then(data=>data?.occupants.find((person:any)=>person.id===id));
 try{
  for(const user of users){await pool.query('INSERT INTO users(id,name,email,password_hash,avatar_id) VALUES($1,$2,$3,$4,$5)',[user.id,user.name,`${user.id}@interaction.invalid`,dummyPasswordHash,user.avatar]);await pool.query("INSERT INTO sessions(token_hash,user_id,expires_at) VALUES($1,$2,now()+interval '1 hour')",[hashToken(user.token),user.id]);const context=await browser.newContext();contexts.push(context);await context.addCookies([{name:'coatria_session',value:user.token,url:origin,httpOnly:true,sameSite:'Lax'}]);}
  // The emulator serves one database connection. Release all fixture connections
  // before Next handles real HTTP, then reconnect only after both browsers close.
  await pool.end();seedPoolClosed=true;
  const [host,guest]=contexts;companyId=(await post(host,'/api/companies',{name:'Shared interactions fixture',slug:'interaction-'+suffix,template:'blank'})).company.id;
  const invitation=await post(host,`/api/companies/${companyId}/invitations`,{role:'member'});await post(guest,'/api/invitations/join',{token:invitation.token});
  await post(host,`/api/companies/${companyId}/layout`,{floor,layout,revision:0},'PATCH');
  for(const [index,context] of contexts.entries())await post(context,`/api/companies/${companyId}/presence`,{roomId:null,status:'available',x:index?4:seat.approach.x,z:index?4:seat.approach.z});
  const a=await host.newPage(),b=await guest.newPage();for(const page of [a,b])page.on('pageerror',error=>errors.push(error.message));
  await a.goto(origin+'/#office');await b.goto(origin+'/#office');for(const page of[a,b])await expect.poll(async()=>(await scene(page))?.loadedCharacterModels).toBe(2);
  await a.evaluate(id=>(window as any).CoatriaScene.instance.requestSeat(id),seat.id);await expect.poll(async()=>(await own(a,users[0].id))?.seatId).toBe(seat.id);await expect.poll(async()=>(await own(b,users[0].id))?.seatId).toBe(seat.id);
  expect(await b.evaluate(id=>(window as any).CoatriaScene.instance.requestSeat(id),seat.id)).toBe(false);
  await a.getByRole('button',{name:'Character actions',exact:true}).click();await expect(a.getByRole('button',{name:'Wave',exact:true})).toBeDisabled();await a.getByRole('button',{name:'React with heart',exact:true}).click();
  await expect(b.getByRole('status',{name:'Studio Host reacts with heart',exact:true})).toBeVisible();await expect.poll(async()=>(await own(a,users[0].id))?.seatId).toBe(seat.id);
  await a.reload();await expect.poll(async()=>(await own(a,users[0].id))?.currentMotion).toBe('sit');await expect.poll(async()=>(await own(b,users[0].id))?.seatId).toBe(seat.id);
  await a.evaluate(()=>(window as any).CoatriaScene.instance.stand());await expect.poll(async()=>(await own(b,users[0].id))?.seatId).toBe(null);
  await a.evaluate(()=>(window as any).CoatriaScene.instance.emote('wave'));await expect.poll(async()=>(await own(b,users[0].id))?.currentMotion).toBe('wave');
  await a.evaluate(()=>(window as any).CoatriaScene.instance.walkTo(-6,3,'run'));await expect.poll(async()=>(await own(b,users[0].id))?.motionMode).toBe('run');
  await a.evaluate(()=>(window as any).CoatriaScene.instance.teleportTo(-4,5));await expect.poll(async()=>(await own(b,users[0].id))?.x).toBeCloseTo(-4,2);await expect.poll(async()=>(await own(b,users[0].id))?.z).toBeCloseTo(5,2);
  await a.screenshot({path:testInfo.outputPath('shared-character-actions.png')});expect(errors).toEqual([]);
 }catch(error){primaryError=error;throw error;}finally{
  await Promise.all(contexts.map(context=>context.close()));
  if(!seedPoolClosed)await pool.end();
  // A single-connection emulator rejects a second socket until Next's idle pool
  // disconnects. Retry only connection establishment, never arbitrary SQL errors.
  const cleanup=new Pool({...poolOptions,connectionTimeoutMillis:1500});let client:PoolClient|undefined;
  try{
   const deadline=Date.now()+45000;
   while(!client){try{client=await cleanup.connect();}catch(error){if(Date.now()>=deadline||!['ECONNRESET','ECONNREFUSED'].includes((error as NodeJS.ErrnoException).code??''))throw error;await new Promise(resolve=>setTimeout(resolve,750));}}
   if(companyId)await client.query('DELETE FROM companies WHERE id=$1 AND slug=$2',[companyId,'interaction-'+suffix]);await client.query('DELETE FROM rate_limits WHERE key=ANY($1::text[])',[users.flatMap(user=>['write:'+user.id,'company-create:'+user.id,'invite-create:'+user.id,'invite-join:'+user.id,...(companyId?[`interaction:${companyId}:${user.id}`]:[])].map(hashToken))]);for(const user of users)await client.query('DELETE FROM users WHERE id=$1 AND email=$2',[user.id,`${user.id}@interaction.invalid`]);expect(Number((await client.query('SELECT count(*) FROM users WHERE id=ANY($1::uuid[])',[users.map(user=>user.id)])).rows[0].count)).toBe(0);
  }catch(error){if(!primaryError)throw error;console.error('Exact fixture cleanup failed after the primary test error:',(error as NodeJS.ErrnoException).code??(error as Error).name);}
  finally{client?.release();await cleanup.end();}
 }
});
