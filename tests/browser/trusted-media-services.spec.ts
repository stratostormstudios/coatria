import {test,expect,type Page,type Route} from '@playwright/test';
import {generatedFixture,mockGenerated,uuid,noOverflow} from './studio-generated-fixture';
import {trustedServicePlanInput,trustedServiceStartInput,trustedServiceStopInput} from '../../src/lib/trusted-service-protocol';

const ready={configured:true,code:null,serviceVerified:false};
function provision(){return {id:uuid(80),service:'gateway',revision:1,phase:'planned',planHash:'a'.repeat(64),expiresAt:new Date(Date.now()+3600000).toISOString(),providerStatus:null as string|null,podId:null as string|null,submittedAt:null as string|null,stopRequestedAt:null as string|null,lastReconciledAt:null as string|null,errorCode:null as string|null,computeStopped:false,readiness:{...ready},plan:{reviewExpiresAt:new Date(Date.now()+600000).toISOString(),preset:{id:'sim-gateway-d29a040-preflight',releaseCommit:'d29a040a25c61a982feff02fdff1e739d8df3ae7',dataCenterId:'US-NC-2',cpuTypeId:'cpu3c',vcpuCount:2,memoryGb:4},reservation:{cpuMicrousd:108334,previouslyReservedMicrousd:0,lifetimeAllowanceMicrousd:500000,billingCapGuaranteed:false}}};}
async function setup(page:Page,options:{role?:string;unavailable?:boolean;rows?:ReturnType<typeof provision>[];handler?:(route:Route,path:string,body:any)=>Promise<boolean>}={}){
 const state=generatedFixture();state.company.role=options.role??'owner';const rows=options.rows??[];
 state.handler=async(route,url)=>{
  const path=url.pathname,method=route.request().method();
  if(path.endsWith('/studio/hosts')){await route.fulfill({json:{hosts:[],encryptionConfigured:true}});return true;}
  if(!path.includes('/studio/trusted-services')&&!path.endsWith('/gateway'))return false;
  const body=method==='POST'?route.request().postDataJSON():null;
  if(await options.handler?.(route,path,body))return true;
  if(!path.includes('/studio/trusted-services'))return false;
  if(method==='GET'){await route.fulfill({json:path.endsWith('/trusted-services')?{provisions:rows,readiness:{archive:{configured:false,code:'SERVICE_CONFIGURATION_INACTIVE',serviceVerified:false},gateway:options.unavailable?{configured:false,code:'SERVICE_DATABASE_UNAVAILABLE',serviceVerified:false}:ready}}:{provision:rows.find(row=>path.endsWith(row.id))}});return true;}
  throw Error('Unexpected mutation '+path);
 };
 await mockGenerated(page,state);await page.goto('/#studio');return{state,rows};
}
async function open(page:Page){await page.getByRole('button',{name:'Agent hosts',exact:true}).click();await page.getByRole('button',{name:'Trusted media services',exact:true}).click();return page.getByRole('dialog');}
test.beforeEach(({baseURL})=>test.skip(!baseURL||!['localhost','127.0.0.1'].includes(new URL(baseURL).hostname),'Only local synthetic browser fixtures.'));

test('owner reviews the exact finite plan before a paid start; consent expires with a changed plan',async({page},info)=>{
 const row=provision(),posts:{path:string;body:any}[]=[];
 const {rows}=await setup(page,{handler:async(route,path,body)=>{if(!body)return false;posts.push({path,body});if(path.endsWith('/trusted-services')){trustedServicePlanInput.parse(body);rows.push(row);await route.fulfill({json:{provision:row}});}else{const parsed=trustedServiceStartInput.parse(body);expect(parsed).toMatchObject({revision:2,planHash:'b'.repeat(64),acknowledgeCharges:true});row.phase='running';row.revision++;row.podId='synthetic-pod';row.providerStatus='RUNNING';row.submittedAt=new Date().toISOString();await route.fulfill({json:{provision:row}});}return true;}});
 const dialog=await open(page);await expect(dialog.getByRole('button',{name:'Prepare archive plan'})).toBeDisabled();await dialog.getByRole('button',{name:'Prepare gateway plan'}).click();await expect(dialog.getByRole('button',{name:'Start reviewed media service'})).toBeDisabled();expect(posts).toHaveLength(1);
 await expect(dialog).toContainText('CPU reservation for this start');await expect(dialog).toContainText('0.108334');await dialog.getByRole('checkbox',{name:/I reviewed this exact service plan/}).check();
 row.revision=2;row.planHash='b'.repeat(64);await dialog.getByRole('button',{name:'Refresh media services'}).click();await expect(dialog.getByRole('checkbox')).not.toBeChecked();await expect(dialog.getByRole('button',{name:'Start reviewed media service'})).toBeDisabled();
 await page.setViewportSize({width:390,height:844});await dialog.getByRole('region',{name:'Review media service plan'}).evaluate(element=>element.scrollIntoView({block:'start'}));await noOverflow(page);await page.screenshot({path:info.outputPath('media-plan-mobile.png')});
 await page.setViewportSize({width:1440,height:1000});await page.screenshot({path:info.outputPath('media-plan-desktop.png')});
 await dialog.getByRole('checkbox').check();await dialog.getByRole('button',{name:'Start reviewed media service'}).click();await expect(dialog).toContainText('Provider RUNNING');expect(posts).toHaveLength(2);expect(posts[1].body.clientId).toMatch(/^[a-f0-9-]{36}$/);expect(posts[1].body.clientId).not.toBe(posts[0].body.clientId);await expect(dialog).not.toContainText('Service verified');
});

test('lost plan response survives closing and reloading, with explicit same-id recovery and no automatic mutation',async({page})=>{
 const row=provision(),bodies:any[]=[];
 const {rows}=await setup(page,{handler:async(route,path,body)=>{if(!body)return false;expect(path.endsWith('/trusted-services')).toBe(true);bodies.push(body);trustedServicePlanInput.parse(body);if(bodies.length===1){rows.push(row);await route.abort('failed');}else await route.fulfill({json:{provision:row,replayed:true}});return true;}});
 let dialog=await open(page);await dialog.getByRole('button',{name:'Prepare gateway plan'}).click();await expect(dialog.getByRole('alert')).toContainText('outcome is unknown');await expect(dialog.getByRole('button',{name:'Prepare gateway plan'})).toBeDisabled();expect(bodies).toHaveLength(1);
 await page.reload();dialog=await open(page);await expect(dialog).toContainText('Resolve the existing request first');await dialog.getByRole('button',{name:'Refresh media services'}).click();expect(bodies).toHaveLength(1);await expect(dialog.getByRole('button',{name:'Prepare gateway plan'})).toBeDisabled();
 await dialog.getByRole('button',{name:'Resolve same request'}).click();await expect(dialog.getByRole('heading',{name:'Review file gateway plan'})).toBeVisible();expect(bodies).toHaveLength(2);expect(bodies[1]).toEqual(bodies[0]);await expect(dialog.getByRole('checkbox')).not.toBeChecked();
});

test('readiness, expired plans and exhausted allowances prevent paid starts',async({page})=>{
 const expired=provision();expired.plan.reviewExpiresAt=new Date(Date.now()-1000).toISOString();const exhausted={...provision(),id:uuid(81),plan:{...provision().plan,reservation:{cpuMicrousd:108334,previouslyReservedMicrousd:450000,lifetimeAllowanceMicrousd:500000,billingCapGuaranteed:false}}};
 const {state}=await setup(page,{unavailable:true,rows:[expired,exhausted]});const dialog=await open(page);await expect(dialog.getByRole('button',{name:'Prepare gateway plan'})).toBeDisabled();await dialog.getByRole('button',{name:'Review media plan'}).first().click();await expect(dialog.getByRole('alert')).toContainText('expired');await expect(dialog.getByRole('button',{name:'Start reviewed media service'})).toBeDisabled();await dialog.getByRole('button',{name:'Close plan',exact:true}).click();await dialog.getByRole('button',{name:'Review media plan'}).last().click();await expect(dialog.getByRole('alert')).toContainText('exceeds');await expect(dialog.getByRole('checkbox')).toBeDisabled();expect(state.writes.filter(write=>write.path.includes('/trusted-services'))).toHaveLength(0);
});

test('uncertain services reconcile their existing identity and stop with the current revision',async({page})=>{
 const row=provision();row.phase='uncertain';row.errorCode='SERVICE_CREATE_UNCERTAIN';row.submittedAt=new Date().toISOString();const posts:{path:string;body:any}[]=[];
 await setup(page,{rows:[row],handler:async(route,path,body)=>{if(!body)return false;posts.push({path,body});if(path.endsWith('/reconcile')){expect(Object.keys(body)).toEqual(['clientId']);row.phase='running';row.revision=3;row.errorCode=null;row.providerStatus='RUNNING';}else{expect(path.endsWith('/stop')).toBe(true);expect(trustedServiceStopInput.parse(body).revision).toBe(3);row.phase='stopping';row.stopRequestedAt=new Date().toISOString();row.revision++;}await route.fulfill({json:{provision:row}});return true;}});
 const dialog=await open(page);await expect(dialog).toContainText('SERVICE_CREATE_UNCERTAIN');await expect(dialog.getByRole('button',{name:'Prepare gateway plan'})).toBeDisabled();await dialog.getByRole('button',{name:'Reconcile service'}).click();await expect(dialog).toContainText('Provider RUNNING');await dialog.getByRole('button',{name:'Stop media service'}).click();await expect(dialog.getByRole('button',{name:'Stop requested'})).toBeDisabled();await expect(dialog).not.toContainText('Provider compute stopped.');expect(posts).toHaveLength(2);
});

test('ordinary members have no media-service management entry or requests',async({page})=>{const {state}=await setup(page,{role:'member'});await expect(page.getByRole('button',{name:'Agent hosts',exact:true})).toHaveCount(0);expect(state.reads.filter(url=>url.pathname.includes('/trusted-services'))).toHaveLength(0);});

test('access ending after a durable paid start retains the attempt while service reads are unavailable',async({page})=>{
 const row=provision();let denied=false,posts=0;
 await setup(page,{rows:[row],handler:async(route,path,body)=>{if(!path.includes('/trusted-services'))return false;if(denied){await route.fulfill({status:403,json:{error:'Membership ended.'}});return true;}if(!body)return false;expect(path.endsWith('/start')).toBe(true);posts++;row.phase='running';row.revision++;denied=true;await route.fulfill({status:403,json:{error:'Membership ended after service submission.'}});return true;}});
 let dialog=await open(page);await dialog.getByRole('button',{name:'Review media plan'}).click();await dialog.getByRole('checkbox',{name:/I reviewed/}).check();await dialog.getByRole('button',{name:'Start reviewed media service'}).click();await expect(dialog.getByRole('alert')).toContainText('outcome is unknown');
 await page.reload();dialog=await open(page);await expect(dialog).toContainText('Resolve the existing request first');await expect(dialog.getByRole('button',{name:'Resolve same request'})).toBeDisabled();expect(posts).toBe(1);expect(await page.evaluate(()=>Object.keys(sessionStorage).filter(key=>key.startsWith('coatria:media-service-attempt:')))).toHaveLength(1);
 denied=false;await dialog.getByRole('button',{name:'Refresh media services'}).click();await expect(dialog).not.toContainText('Resolve the existing request first');expect(posts).toBe(1);
});

function running(){const row=provision();row.phase='running';row.podId='synthetic-pod';row.providerStatus='RUNNING';row.lastReconciledAt=new Date().toISOString();return row;}
function gateway(row:ReturnType<typeof provision>,bindingId=uuid(91)){return {bindingId,provisionId:row.id,expiresAt:row.expiresAt,configurationHash:'c'.repeat(64),origin:'https://synthetic-pod-4190.proxy.runpod.net'};}

test('project gateway connection uses a read binding CAS and requires a fresh review after conflict',async({page},info)=>{
 const row=running(),posts:any[]=[];let bound:ReturnType<typeof gateway>|null=null;
 await setup(page,{rows:[row],handler:async(route,path,body)=>{if(!path.endsWith('/gateway'))return false;if(!body){await route.fulfill({json:{gateway:bound}});return true;}posts.push(body);expect(Object.keys(body).sort()).toEqual(['expectedBindingId','provisionId']);if(posts.length===1){bound=gateway({...row,id:uuid(89)});await route.fulfill({status:409,json:{error:'The gateway binding changed. Refresh before verifying.',code:'GATEWAY_BINDING_CONFLICT'}});}else{expect(body).toEqual({provisionId:row.id,expectedBindingId:uuid(91)});bound=gateway(row,uuid(92));await route.fulfill({json:{gateway:bound}});}return true;}});
 const dialog=await open(page);await dialog.getByLabel('Gateway project').selectOption(uuid(4));await dialog.getByLabel('Running file gateway').selectOption(row.id);await expect(dialog.getByRole('button',{name:'Verify and connect gateway'})).toBeDisabled();await dialog.getByRole('checkbox',{name:/Verify this gateway/}).check();await dialog.getByRole('button',{name:'Verify and connect gateway'}).click();await expect(dialog).toContainText('gateway binding changed');await expect(dialog.getByRole('checkbox',{name:/Verify this gateway/})).not.toBeChecked();expect(posts[0]).toEqual({provisionId:row.id,expectedBindingId:null});
 await dialog.getByRole('checkbox',{name:/Verify this gateway/}).check();await dialog.getByRole('button',{name:'Verify and connect gateway'}).click();await expect(dialog).toContainText('Verified project gateway');await expect(dialog).toContainText('updated security policy');await expect(dialog.getByRole('button',{name:'Verify and connect gateway'})).toBeDisabled();expect(posts).toHaveLength(2);
 await page.setViewportSize({width:390,height:844});await dialog.getByRole('button',{name:'Reload for file transfers'}).scrollIntoViewIfNeeded();await noOverflow(page);await page.screenshot({path:info.outputPath('gateway-connected-mobile.png')});
});

test('lost gateway binding response resolves by read after reload without resending or rotating the grant',async({page})=>{
 const row=running();let bound:ReturnType<typeof gateway>|null=null,posts=0,readsDenied=false;
 await setup(page,{rows:[row],handler:async(route,path,body)=>{if(!path.endsWith('/gateway'))return false;if(!body){if(readsDenied)await route.fulfill({status:403,json:{error:'Project access unavailable.'}});else await route.fulfill({json:{gateway:bound}});return true;}posts++;bound=gateway(row);readsDenied=true;await route.abort('failed');return true;}});
 let dialog=await open(page);await dialog.getByLabel('Gateway project').selectOption(uuid(4));await dialog.getByLabel('Running file gateway').selectOption(row.id);await dialog.getByRole('checkbox',{name:/Verify this gateway/}).check();await dialog.getByRole('button',{name:'Verify and connect gateway'}).click();await expect(dialog).toContainText('verification outcome is unknown');await page.reload();dialog=await open(page);await dialog.getByLabel('Gateway project').selectOption(uuid(4));await expect(dialog).toContainText('Resolve the existing verification first');await expect(dialog.getByRole('button',{name:'Resolve same verification'})).toBeDisabled();expect(posts).toBe(1);
 readsDenied=false;await dialog.getByRole('button',{name:'Refresh project gateway'}).click();await expect(dialog).toContainText('Verified project gateway');await expect(dialog).not.toContainText('Resolve the existing verification first');expect(posts).toBe(1);
});

test('gateway project changes isolate slow binding reads and unavailable services cannot be selected',async({page})=>{
 const row=running(),stopped={...running(),id:uuid(81),stopRequestedAt:new Date().toISOString()},stale={...running(),id:uuid(82),lastReconciledAt:new Date(Date.now()-130000).toISOString()};let first:Route|undefined;
 const {state}=await setup(page,{rows:[row,stopped,stale],handler:async(route,path,body)=>{if(!path.endsWith('/gateway'))return false;expect(body).toBeNull();if(path.includes(uuid(4))){first=route;return true;}await route.fulfill({json:{gateway:null}});return true;}});
 const dialog=await open(page);await dialog.getByLabel('Gateway project').selectOption(uuid(4));await expect.poll(()=>!!first).toBe(true);await dialog.getByLabel('Gateway project').selectOption(state.legacy.id);await expect(dialog).toContainText('No verified live gateway');await first!.fulfill({json:{gateway:gateway(row)}}).catch(()=>{});await expect(dialog).not.toContainText('Verified project gateway');await expect(dialog.getByLabel('Running file gateway').locator('option')).toHaveCount(2);await expect(dialog.getByRole('button',{name:'Verify and connect gateway'})).toBeDisabled();
});
