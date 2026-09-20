import {test,expect,type Page,type Route} from '@playwright/test';
import {STUDIO_TEMPLATES,STUDIO_SKILLS,type StudioSnapshot,type StudioProjectDetail} from '../../src/lib/studio-protocol';
import {PLUGIN_CATALOG,PLUGIN_CATALOG_VERSION} from '../../src/lib/plugin-catalog';
import type {StudioReviewPolicy} from '../../src/lib/studio-review-policy-protocol';
import type {Company,User,Workspace,Member,Agent} from '../../src/lib/client';

const user:User={id:'studio-owner',name:'Studio owner',email:'owner@example.invalid',roleTitle:'Owner',avatarColor:'#607850',avatarId:null};
const company:Company={id:'studio-company',name:'Role review studio',slug:'role-review-studio',template:'blank',role:'owner'};
const member=(id:string,name:string,role:string):Member=>({...user,id,userId:id,name,role,email:id+'@example.invalid'});
const agent=(id:string,name:string,capabilities:string[]):Agent=>({id,name,capabilities,description:'Local browser fixture',harness:'claude',status:'active',createdBy:user.id,lastSeenAt:null,pluginInstallationId:'installation-'+id,invocationAccess:'admins'});
function fixture(){
 const workspace:Workspace={company:{...company},rooms:[],members:[member(user.id,user.name,'owner'),member('review-admin','Independent administrator','admin'),member('artist-member','Production artist','member')],agents:[agent('production-agent','Production coordinator',['studio.read','studio.write','tasks.write']),agent('planning-agent','Planning reviewer',['studio.read','studio.review'])],tasks:[],messages:[],presence:[],activity:[],drives:[],openings:[],applications:[],layout:[]};
 const template=STUDIO_TEMPLATES.find(item=>item.id==='ai-production')!;
 const roles=template.roles.map(role=>({...role,agentId:role.key==='coordinator'?'production-agent':null,humanId:role.key==='qc'?'review-admin':null}));
 const project:StudioProjectDetail['project']={id:'fixture-production',name:'Reference campaign',clientName:'Synthetic client',brief:'Prepare a reference plan for review.',productionPath:'higgsfield',dueDate:null,spec:{width:1920,height:1080,fpsNumerator:24,fpsDenominator:1,format:'mp4',colorSpace:'Rec.709'},aiPolicy:'allowed',revision:1,status:'planning',gates:{},createdAt:'2026-09-20T00:00:00Z',updatedAt:'2026-09-20T00:00:00Z'};
 const snapshot:StudioSnapshot={templates:STUDIO_TEMPLATES,skills:STUDIO_SKILLS,profile:{templateId:template.id,revision:4,roles},projects:[project],hasMore:false,nextAfter:null};
 const detail:StudioProjectDetail={project,roles,skills:STUDIO_SKILLS,workItems:[],shots:[],artifacts:[],reviews:[],deliveries:[]};
 return {workspace,snapshot,detail,policy:null as StudioReviewPolicy|null,handler:undefined as ((route:Route,path:string)=>Promise<boolean>)|undefined};
}
async function mock(page:Page,state:ReturnType<typeof fixture>){
 await page.route('**/api/**',async route=>{
  const path=new URL(route.request().url()).pathname;
  if(await state.handler?.(route,path))return;
  const data=path==='/api/session'?{user,companies:[state.workspace.company],configured:true}:path.endsWith('/workspace')?state.workspace:path.endsWith('/presence')?{presence:[]}:path==='/api/plugins/catalog'?{plugins:PLUGIN_CATALOG,version:PLUGIN_CATALOG_VERSION}:path.endsWith('/studio/staffing/proposals')?{proposals:[]}:path.endsWith('/studio')?state.snapshot:path.endsWith('/fixture-production')?state.detail:path.endsWith('/review-policy')?{policy:state.policy,reviews:[]}:path.endsWith('/coordination')?{policy:null,dispatches:[]}:null;
  await route.fulfill({status:data?200:501,json:data||{error:'Unexpected browser fixture '+path}});
 });
}
async function assignments(page:Page){await page.getByRole('button',{name:'Manage studio team',exact:true}).click();await page.getByRole('dialog').getByRole('button',{name:'Continue',exact:true}).click();return page.getByRole('dialog');}
async function openPlanningPolicy(page:Page){await page.getByRole('button').filter({has:page.getByRole('heading',{name:'Reference campaign',exact:true})}).click();await page.getByRole('tab',{name:'Coordination',exact:true}).click();await page.getByRole('button',{name:/^(Set|Review) planning (review )?policy$/}).click();return page.getByRole('dialog');}
async function noOverflow(page:Page){const sizes=await page.evaluate(()=>({viewport:innerWidth,page:document.documentElement.scrollWidth,dialogs:[...document.querySelectorAll('dialog[open]')].map(el=>({visible:el.clientWidth,scroll:el.scrollWidth}))}));expect(sizes.page).toBeLessThanOrEqual(sizes.viewport+1);for(const dialog of sizes.dialogs)expect(dialog.scroll).toBeLessThanOrEqual(dialog.visible+1);}

test.beforeEach(({baseURL})=>{test.skip(!baseURL||!['localhost','127.0.0.1'].includes(new URL(baseURL).hostname),'Fixtures use a local origin.');});

test('human roles explain task authority and save only reviewed assignments; QC offers human administrators',async({page})=>{
 const state=fixture();let sent:Record<string,unknown>|undefined;
 state.handler=async(route,path)=>{if(!path.endsWith('/studio/setup'))return false;sent=route.request().postDataJSON();state.snapshot.profile!.roles=state.snapshot.profile!.roles.map(role=>({...role,...(sent!.assignments as {roleKey:string;humanId:string|null;agentId:string|null}[]).find(value=>value.roleKey===role.key)}));state.snapshot.profile!.revision++;await route.fulfill({json:{profile:state.snapshot.profile}});return true;};
 await mock(page,state);await page.goto('/#studio');const dialog=await assignments(page);
 await expect(dialog).toContainText('A person assigned to a role can work on its linked tasks.');
 const quality=dialog.getByLabel('Assign Independent quality reviewer');
 expect(await quality.locator('option').evaluateAll(options=>options.map(option=>(option as HTMLOptionElement).value))).toEqual(['','human:studio-owner','human:review-admin']);
 await expect(dialog).toContainText('This assignment does not promote a member.');
 await dialog.getByLabel('Assign Reference & provenance specialist').selectOption('human:artist-member');await quality.selectOption('human:review-admin');await dialog.getByRole('button',{name:'Continue',exact:true}).click();
 await expect(dialog).toContainText('Applying assigns people to the role’s unstarted project tasks');await dialog.getByRole('button',{name:'Apply studio structure',exact:true}).click();await expect(dialog).toHaveCount(0);
 expect(sent).toMatchObject({templateId:'ai-production',templateVersion:1,revision:4,assignments:expect.arrayContaining([{roleKey:'ingest',humanId:'artist-member',agentId:null},{roleKey:'qc',humanId:'review-admin',agentId:null}])});expect(sent?.clientId).toMatch(/^[a-f0-9-]{36}$/);expect(Object.keys(sent!).sort()).toEqual(['assignments','clientId','revision','templateId','templateVersion']);
 const reopened=await assignments(page);await expect(reopened.getByLabel('Assign Reference & provenance specialist')).toHaveValue('human:artist-member');
});

for(const legacy of ['agent','ordinary member'] as const)test(`legacy QC assigned to ${legacy} requires an explicit correction`,async({page},testInfo)=>{
 const state=fixture(),qualityRole=state.snapshot.profile!.roles.find(role=>role.key==='qc')!;qualityRole.agentId=legacy==='agent'?'production-agent':null;qualityRole.humanId=legacy==='ordinary member'?'artist-member':null;
 let writes=0;state.handler=async(route,path)=>{if(path.endsWith('/studio/setup')){writes++;await route.fulfill({json:{}});return true;}return false;};
 await mock(page,state);await page.goto('/#studio');await expect(page.getByText('Quality reviewer needs reassignment.',{exact:true})).toBeVisible();await page.getByRole('button',{name:'Update quality reviewer'}).click();const dialog=page.getByRole('dialog');await dialog.getByRole('button',{name:'Continue',exact:true}).click();
 const quality=dialog.getByLabel('Assign Independent quality reviewer');await expect(quality).toHaveAttribute('aria-invalid','true');await expect(dialog.getByRole('alert')).toContainText('Replace the saved reviewer');await expect(dialog.getByRole('button',{name:'Continue',exact:true})).toBeDisabled();expect(writes).toBe(0);
 await page.setViewportSize({width:390,height:844});await quality.scrollIntoViewIfNeeded();await noOverflow(page);await page.screenshot({path:testInfo.outputPath('quality-role-mobile.png')});
 await quality.selectOption('');await expect(quality).not.toHaveAttribute('aria-invalid','true');await expect(dialog.getByRole('alert')).toHaveCount(0);await dialog.getByRole('button',{name:'Continue',exact:true}).click();await expect(dialog).toContainText('Unassigned');expect(writes).toBe(0);
});

test('busy role changes retain the draft and explain how to resolve attribution',async({page})=>{
 const state=fixture();state.handler=async(route,path)=>{if(!path.endsWith('/studio/setup'))return false;await route.fulfill({status:409,json:{error:'Finish or reset the doing or review work before reassigning this role.',code:'STUDIO_ROLE_BUSY'}});return true;};await mock(page,state);await page.goto('/#studio');const dialog=await assignments(page);await dialog.getByLabel('Assign Executive producer').selectOption('human:artist-member');await dialog.getByRole('button',{name:'Continue',exact:true}).click();await dialog.getByRole('button',{name:'Apply studio structure',exact:true}).click();await expect(dialog.getByRole('alert')).toContainText('Finish or reset');await dialog.getByRole('button',{name:'Back',exact:true}).click();await expect(dialog.getByLabel('Assign Executive producer')).toHaveValue('human:artist-member');
});

test('ordinary members see an actionable legacy warning without management controls',async({page})=>{
 const state=fixture();state.workspace.company.role='member';state.snapshot.profile!.roles.find(role=>role.key==='qc')!.humanId='artist-member';await mock(page,state);await page.goto('/#studio');await expect(page.getByText('Quality reviewer needs reassignment.',{exact:true})).toBeVisible();await expect(page.getByText('Ask a company owner or administrator to update the studio team.')).toBeVisible();await expect(page.getByRole('button',{name:'Update quality reviewer'})).toHaveCount(0);await expect(page.getByRole('button',{name:'Manage studio team'})).toHaveCount(0);
});

test('staffing proposals explain why only a separate human administrator can perform QC',async({page},testInfo)=>{
 const state=fixture();await mock(page,state);await page.goto('/#studio');await page.getByRole('button',{name:'Build an AI team',exact:true}).click();const dialog=page.getByRole('dialog'),quality=dialog.getByLabel('Independent quality reviewer',{exact:true});expect(await quality.locator('option').evaluateAll(options=>options.map(option=>(option as HTMLOptionElement).value))).toEqual(['','review-admin']);await expect(dialog).toContainText('You sponsor the proposed agents');await expect(quality).toHaveValue('');await page.setViewportSize({width:390,height:844});await quality.scrollIntoViewIfNeeded();await noOverflow(page);await page.screenshot({path:testInfo.outputPath('staffing-reviewer-mobile.png')});
});

test('reference planning is opt-in and persists only after explicit policy review',async({page},testInfo)=>{
 const state=fixture();let sent:Record<string,unknown>|undefined;state.handler=async(route,path)=>{if(!path.endsWith('/review-policy')||route.request().method()!=='PUT')return false;sent=route.request().postDataJSON();state.policy={...sent,revision:1,remainingReviews:5,reviewsStarted:0,effectiveStatus:'paused',blocker:null} as StudioReviewPolicy;await route.fulfill({json:{policy:state.policy}});return true;};await mock(page,state);await page.goto('/#studio');const dialog=await openPlanningPolicy(page);
 const reference=dialog.getByRole('checkbox',{name:'Reference planning & provenance',exact:true});await expect(reference).not.toBeChecked();await expect(dialog.getByRole('checkbox',{name:'Scope & estimate draft',exact:true})).toBeChecked();await expect(dialog.getByRole('checkbox',{name:'Shot breakdown & schedule',exact:true})).toBeChecked();await expect(dialog).toContainText('does not approve image quality, sharing media with Higgsfield, paid generation, or client delivery');
 await dialog.getByLabel('Separate planning reviewer',{exact:true}).selectOption('planning-agent');await dialog.getByRole('checkbox',{name:/I reviewed the distinct agents/}).check();await reference.check();await expect(dialog.getByRole('checkbox',{name:/I reviewed the distinct agents/})).not.toBeChecked();await expect(dialog.getByRole('button',{name:'Save reviewed policy',exact:true})).toBeDisabled();
 await page.setViewportSize({width:390,height:844});await reference.scrollIntoViewIfNeeded();await noOverflow(page);await page.screenshot({path:testInfo.outputPath('reference-policy-mobile.png')});await dialog.getByRole('checkbox',{name:/I reviewed the distinct agents/}).check();await dialog.getByRole('button',{name:'Save reviewed policy',exact:true}).click();await expect(dialog).toHaveCount(0);expect(sent).toMatchObject({allowedStages:['estimate','breakdown','references'],allowSharedSponsor:false,status:'paused',coordinatorAgentId:'production-agent',reviewerAgentId:'planning-agent',revision:0});
 await page.getByRole('button',{name:'Review planning policy',exact:true}).click();await expect(page.getByRole('dialog').getByRole('checkbox',{name:'Reference planning & provenance',exact:true})).toBeChecked();
});

test('existing planning policy never receives reference authority implicitly',async({page})=>{
 const state=fixture();state.policy={projectId:state.detail.project.id,coordinatorAgentId:'production-agent',reviewerAgentId:'planning-agent',allowedStages:['ingest'],allowSharedSponsor:false,maxReviews:7,reviewsStarted:2,remainingReviews:5,status:'paused',effectiveStatus:'paused',blocker:null,revision:3,profileRevision:4,approvedBy:user.id,expiresAt:'2027-01-01T00:00:00Z',updatedAt:'2026-09-20T00:00:00Z',reviewKind:'machine_planning'};await mock(page,state);await page.goto('/#studio');const dialog=await openPlanningPolicy(page);await expect(dialog.getByRole('checkbox',{name:'Reference planning & provenance',exact:true})).not.toBeChecked();await expect(dialog.getByRole('checkbox',{name:'Agent-assigned ingest provenance',exact:true})).toBeChecked();await expect(dialog.getByRole('checkbox',{name:'Scope & estimate draft',exact:true})).not.toBeChecked();await expect(dialog.getByRole('checkbox',{name:/I reviewed the distinct agents/})).not.toBeChecked();
});
