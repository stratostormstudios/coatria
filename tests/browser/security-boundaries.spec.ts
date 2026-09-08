import {test,expect,type Page,type Route} from '@playwright/test';

const user={id:'10000000-0000-4000-8000-000000000001',name:'Boundary QA',email:'boundary@example.invalid',roleTitle:'Reviewer',avatarColor:'#c9d6b5'};
const a={id:'20000000-0000-4000-8000-000000000001',name:'Company A',slug:'company-a',template:'blank',role:'owner'};
const b={id:'20000000-0000-4000-8000-000000000002',name:'Company B',slug:'company-b',template:'blank',role:'owner'};
const peer=(name:string,id:string)=>({id,userId:id,name,email:id+'@example.invalid',role:'member',roleTitle:'Colleague',avatarColor:'#c9d6b5'});
function workspace(company:typeof a,extra:Record<string,unknown>={}){
  return {company,members:[{...user,userId:user.id,role:'owner'},peer(company.id===a.id?'Only company A':'Only company B','30000000-0000-4000-8000-'+(company.id===a.id?'000000000001':'000000000002'))],rooms:[],agents:[],tasks:[],messages:[],presence:[],activity:[],drives:[],openings:[],applications:[],layout:[],...extra};
}
const fulfill=(route:Route,data:unknown,status=200)=>route.fulfill({status,contentType:'application/json',body:JSON.stringify(data)});
async function stubGeometry(page:Page){
  await page.addInitScript(()=>{
    (window as any).CoatriaOfficeRuntime={mount:(host:HTMLElement)=>{const canvas=document.createElement('canvas');host.append(canvas);return{dispose:()=>canvas.remove(),updateSnapshot:()=>{},diagnostics:{position:{x:0,z:0}},setCharacterModel:()=>false};},loadCharacter:()=>Promise.reject(new Error('Test uses procedural geometry')),disposeCharacter:()=>{}};
  });
}

test('a completed old-company mutation cannot replace the newly selected workspace',async({page,baseURL})=>{
  test.skip(!baseURL||!['localhost','127.0.0.1'].includes(new URL(baseURL).hostname),'Local browser fixtures only; all API requests are intercepted.');
  await stubGeometry(page);
  const held:Route[]=[];let aReads=0,release=false;
  await page.route('**/api/**',async route=>{
    const url=new URL(route.request().url());
    if(url.pathname==='/api/session')return fulfill(route,{user,companies:[a,b],configured:true});
    if(url.pathname===`/api/companies/${a.id}/workspace`){aReads++;return fulfill(route,workspace(a));}
    if(url.pathname===`/api/companies/${b.id}/workspace`)return fulfill(route,workspace(b));
    if(url.pathname===`/api/companies/${a.id}/presence`&&!release){held.push(route);return;}
    return fulfill(route,{presence:[]});
  });
  await page.goto('/#office');
  await expect(page.getByText('Only company A',{exact:true})).toBeVisible();
  await expect.poll(()=>held.length).toBeGreaterThanOrEqual(2); // UI heartbeat and initial position write.
  await page.getByRole('button',{name:'Switch to Company B',exact:true}).click();
  await expect(page.getByText('Only company B',{exact:true})).toBeVisible();
  const readsBeforeRelease=aReads;release=true;
  await Promise.all(held.map(route=>fulfill(route,{presence:[]})));
  await page.waitForLoadState('networkidle');
  expect(aReads,'Completing an A write must not issue a stale A refresh after selecting B.').toBe(readsBeforeRelease);
  await expect(page.getByText('Only company B',{exact:true})).toBeVisible();
  await expect(page.getByText('Only company A',{exact:true})).toHaveCount(0);
});

test('untrusted company, teammate and message strings render as text in React and the 3D overlay',async({page,baseURL})=>{
  test.skip(!baseURL||!['localhost','127.0.0.1'].includes(new URL(baseURL).hostname),'Local intercepted browser fixture only.');
  const attack='<img src=x onerror="window.__coatriaXss=1">';
  const evilCompany={...a,name:attack,template:'studio'},teammate=peer(attack,'30000000-0000-4000-8000-000000000005');
  const data=workspace(evilCompany,{members:[{...user,userId:user.id,role:'owner'},teammate],presence:[{userId:teammate.userId,name:attack,avatarColor:'#c9d6b5',roomId:null,x:1,z:1,status:'available',updatedAt:new Date().toISOString()}],messages:[{id:'40000000-0000-4000-8000-000000000001',roomId:null,body:attack,userId:teammate.userId,authorName:attack,createdAt:new Date().toISOString()}]});
  await page.route('**/api/**',route=>fulfill(route,new URL(route.request().url()).pathname==='/api/session'?{user,companies:[evilCompany],configured:true}:new URL(route.request().url()).pathname.endsWith('/workspace')?data:{presence:data.presence}));
  await page.goto('/#office');
  await expect(page.locator('.cs-scene-floor')).toContainText(attack);
  await page.getByRole('button',{name:'Select '+attack,exact:true}).click();
  await expect(page.locator('.cs-scene-context strong')).toHaveText(attack);
  expect(await page.locator('.cs-scene img').count()).toBe(0);
  expect(await page.evaluate(()=>(window as any).__coatriaXss)).toBeUndefined();
  await page.getByRole('button',{name:'Conversations',exact:true}).click();
  await expect(page.locator('.message p')).toHaveText(attack);
  expect(await page.locator('.message img').count()).toBe(0);
  expect(await page.evaluate(()=>(window as any).__coatriaXss)).toBeUndefined();
});

test('a changed shared-cookie identity cannot receive the previous account’s private skill draft',async({page,baseURL})=>{
  test.skip(!baseURL||!['localhost','127.0.0.1'].includes(new URL(baseURL).hostname),'Local intercepted browser fixture only.');
  const other={...user,id:'10000000-0000-4000-8000-000000000002',name:'Other identity',email:'other@example.invalid'};
  let cookieIdentity=user,attemptedIdentity='',acceptedWrites=0;
  const skill=(id:string,title:string,content:string)=>({id,title,description:'Private fixture',content,version:1,updatedAt:new Date().toISOString()});
  const ownSkill=skill('50000000-0000-4000-8000-000000000001','Account A private method','PRIVATE ACCOUNT A MATERIAL');
  const otherSkill=skill('50000000-0000-4000-8000-000000000002','Account B private method','PRIVATE ACCOUNT B MATERIAL');
  await page.route('**/api/**',async route=>{
    const url=new URL(route.request().url());
    if(url.pathname==='/api/session')return fulfill(route,{user:cookieIdentity,companies:[],configured:true});
    if(url.pathname==='/api/vault'&&route.request().method()==='GET')return fulfill(route,{skills:[cookieIdentity.id===user.id?ownSkill:otherSkill]});
    if(url.pathname.startsWith('/api/vault/')&&route.request().method()==='PATCH'){
      attemptedIdentity=route.request().headers()['x-coatria-user']||'';
      if(attemptedIdentity!==cookieIdentity.id)return fulfill(route,{code:'SESSION_CHANGED',error:'Your account changed. Refresh before continuing.'},409);
      acceptedWrites++;return fulfill(route,{skill:otherSkill});
    }
    return fulfill(route,{});
  });
  await page.goto('/#vault');
  await page.getByRole('heading',{name:ownSkill.title,exact:true}).click();
  await page.getByRole('button',{name:'Edit and save a new version',exact:true}).click();
  await expect(page.getByRole('textbox',{name:'Instructions, process or knowledge',exact:true})).toHaveValue(ownSkill.content);
  cookieIdentity=other; // Simulate another tab replacing the shared session cookie.
  await page.getByRole('button',{name:'Save new version',exact:true}).click();
  await expect(page.getByRole('heading',{name:otherSkill.title,exact:true})).toBeVisible();
  expect(attemptedIdentity).toBe(user.id);
  expect(acceptedWrites).toBe(0);
  await expect(page.getByRole('dialog')).toHaveCount(0);
  await expect(page.getByText(ownSkill.title,{exact:true})).toHaveCount(0);
  expect(await page.locator('body').innerText()).not.toContain(ownSkill.content);
  cookieIdentity=user;
  await page.evaluate(()=>window.dispatchEvent(new Event('focus')));
  await expect(page.getByRole('heading',{name:ownSkill.title,exact:true})).toBeVisible();
  await expect(page.getByText(otherSkill.title,{exact:true})).toHaveCount(0);
});

test('a delayed private export is discarded after the browser switches accounts',async({page,baseURL})=>{
  test.skip(!baseURL||!['localhost','127.0.0.1'].includes(new URL(baseURL).hostname),'Local intercepted browser fixture only.');
  const other={...user,id:'10000000-0000-4000-8000-000000000003',name:'Export recipient',email:'recipient@example.invalid'};
  let cookieIdentity=user,heldExport:Route|undefined,downloads=0;
  page.on('download',()=>downloads++);
  await page.route('**/api/**',async route=>{
    const url=new URL(route.request().url());
    if(url.pathname==='/api/session')return fulfill(route,{user:cookieIdentity,companies:[],configured:true});
    if(url.pathname==='/api/vault/export'){heldExport=route;return;}
    if(url.pathname==='/api/vault')return fulfill(route,{skills:[]});
    return fulfill(route,{});
  });
  await page.goto('/#vault');
  await page.getByRole('button',{name:'Export my skills',exact:true}).click();
  await expect.poll(()=>Boolean(heldExport)).toBe(true);
  expect(heldExport!.request().headers()['x-coatria-user']).toBe(user.id);
  cookieIdentity=other;
  await page.evaluate(()=>window.dispatchEvent(new Event('focus')));
  await expect(page.getByRole('banner').getByRole('button',{name:'Your profile',exact:true})).toContainText('ER');
  await fulfill(heldExport!,{user:{id:user.id},skills:[{content:'PRIVATE ACCOUNT A EXPORT'}]});
  await page.waitForLoadState('networkidle');
  expect(downloads,'An export authorized as A must not be downloaded by the continuation now showing B.').toBe(0);
});
