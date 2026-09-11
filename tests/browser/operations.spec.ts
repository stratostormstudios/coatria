import {test,expect,type Page,type Route} from '@playwright/test';
import type {Agent,Application,Company,Drive,Opening,User,Workspace} from '../../src/lib/client';

const user:User={id:'ux-person',name:'Operations reviewer',email:'operations@example.invalid',roleTitle:'Producer',avatarColor:'#607850',avatarId:null};
const company:Company={id:'ux-company',name:'Studio North',slug:'studio-north',template:'blank',role:'owner'};
const date='2026-09-01T10:00:00.000Z';
const opening=(id:string,title:string,type='either',compensation='paid'):Opening=>({id,companyId:company.id,companyName:company.name,title,type,compensation,status:'published',budget:'USD 2,000 fixed project',description:'Prepare a thoughtful contribution with clear review criteria and a documented outcome.',createdAt:date});
const agent=(id:string,name:string,overrides:Partial<Agent>={}):Agent=>({id,name,harness:'hermes',description:'Documented company contributions.',status:'active',createdBy:user.id,lastSeenAt:null,...overrides});
const drive=(id:string,name:string):Drive=>({id,name,kind:'byo',description:'Approved production folder',status:'online',lastSeenAt:new Date().toISOString(),fileCount:55});
const application=(id:string,openingId:string,overrides:Partial<Application>={}):Application=>({id,openingId,userId:'candidate-'+id,applicantName:'Applicant '+id,applicantEmail:id+'@example.invalid',message:'I can contribute documented work and review it with the team.',status:'applied',createdAt:date,...overrides});
function workspace(overrides:Partial<Workspace>={}):Workspace{return {company,rooms:[],members:[{...user,userId:user.id,role:'owner'}],agents:[],tasks:[],messages:[],presence:[],activity:[],drives:[],openings:[],applications:[],layout:[],...overrides};}
type Fixture={user:User;companies:Company[];workspace:Workspace;openings:Opening[];mine:Application[];handler?:(route:Route,path:string)=>Promise<boolean>};
async function mock(page:Page,state:Fixture){
 await page.route('**/api/**',async route=>{
  const path=new URL(route.request().url()).pathname;
  if(await state.handler?.(route,path))return;
  const data=path==='/api/session'?{user:state.user,companies:state.companies,configured:true}:path==='/api/opportunities'?{openings:state.openings}:path==='/api/applications'?{applications:state.mine}:path.endsWith('/workspace')?state.workspace:path.endsWith('/presence')?{ok:true}:null;
  await route.fulfill({status:data?200:501,contentType:'application/json',body:JSON.stringify(data||{error:'Unexpected fixture request: '+path})});
 });
}
const fixture=(w:Workspace=workspace()):Fixture=>({user,companies:[w.company],workspace:w,openings:[],mine:[]});
const card=(page:Page,title:string)=>page.getByRole('button').filter({has:page.getByRole('heading',{name:title,exact:true})});
test.beforeEach(({baseURL})=>{test.skip(!baseURL||!['localhost','127.0.0.1'].includes(new URL(baseURL).hostname),'Mocked UX fixtures run only on a local origin.');});

test('agent setup protects its one-time token and revoked activity never looks connected',async({page})=>{
 const state=fixture(workspace({agents:[agent('revoked','Retired analyst',{status:'revoked',lastSeenAt:new Date().toISOString()})]}));
 const token='ca_'+'local-ux-fixture';
 state.handler=async(route,path)=>{if(path===`/api/companies/${company.id}/agents`&&route.request().method()==='POST'){const body=route.request().postDataJSON();expect(body).toEqual({name:'Atlas',harness:'hermes',description:'Prepare reviewable reports',conversationAccess:'none'});const added=agent('atlas','Atlas');state.workspace.agents.push(added);await route.fulfill({status:201,json:{agent:added,token}});return true;}return false;};
 await mock(page,state);await page.goto('/#agents');
 await expect(card(page,'Retired analyst')).toContainText('Revoked');
 await expect(card(page,'Retired analyst')).not.toContainText('Recent API activity');
 await page.getByRole('button',{name:'Connect an agent',exact:true}).first().click();
 const dialog=page.getByRole('dialog');await dialog.getByLabel('Agent name',{exact:true}).fill('Atlas');await dialog.getByLabel('What should this agent contribute?',{exact:true}).fill('Prepare reviewable reports');
 await dialog.getByRole('button',{name:'Create agent identity',exact:true}).click();
 await expect(dialog.getByRole('textbox',{name:'Connection token',exact:true})).toHaveValue(token);
 await dialog.getByRole('button',{name:'Close dialog',exact:true}).click();
 await expect(dialog.getByRole('alert')).toContainText('This token cannot be shown again');
 await dialog.getByRole('checkbox',{name:'I saved this token in a private location.',exact:true}).check();
 await dialog.getByRole('button',{name:'Close dialog',exact:true}).click();await expect(dialog).toHaveCount(0);
 await card(page,'Atlas').click();await expect(page.getByRole('dialog').getByText('Use the token you saved during creation.',{exact:false})).toBeVisible();await expect(page.getByRole('textbox',{name:'Connection token',exact:true})).toHaveCount(0);
 expect(await page.evaluate(value=>Object.values(localStorage).some(item=>item.includes(value))||location.href.includes(value),token)).toBe(false);
});

test('agent conversation access starts off and administrators can grant participation',async({page})=>{
 const state=fixture(workspace({agents:[agent('atlas','Atlas')]}));const changes:unknown[]=[];
 state.handler=async(route,path)=>{if(path===`/api/companies/${company.id}/agents/atlas`&&route.request().method()==='PATCH'){const change=route.request().postDataJSON();changes.push(change);Object.assign(state.workspace.agents[0],change);await route.fulfill({json:{agent:state.workspace.agents[0]}});return true;}return false;};
 await mock(page,state);await page.goto('/#agents');await card(page,'Atlas').click();const access=page.getByRole('dialog').getByLabel('Conversation access',{exact:true});await expect(access).toHaveValue('none');await access.selectOption('write');await expect(access).toHaveValue('write');expect(changes).toEqual([{conversationAccess:'write'}]);await expect(page.getByRole('link',{name:'Conversation API guide'})).toHaveAttribute('href','/downloads/CONVERSATIONS.md');
 await access.selectOption('none');await expect(access).toHaveValue('none');expect(changes).toHaveLength(2);
});

test('an API contact after initial render is immediately recent and later expires',async({page})=>{
 const state=fixture(workspace({agents:[agent('clock-agent','Clock-aware agent')]}));await page.clock.install({time:new Date('2026-09-08T12:00:00.000Z')});await mock(page,state);await page.goto('/#agents');await expect(card(page,'Clock-aware agent')).toContainText('Needs setup');
 await page.clock.runFor(1000);state.workspace.agents[0].lastSeenAt=await page.evaluate(()=>new Date().toISOString());await page.evaluate(()=>document.dispatchEvent(new Event('visibilitychange')));await expect(card(page,'Clock-aware agent')).toContainText('Recent API activity');
 await page.clock.fastForward(91000);await expect(card(page,'Clock-aware agent')).toContainText('No recent API activity');
});

test('file index ignores an old connection response and provides search, sort and paging',async({page})=>{
 const state=fixture(workspace({drives:[drive('first','First server'),drive('second','Second server')]}));let release:()=>void=()=>{};let firstRequested=false;const gate=new Promise<void>(resolve=>{release=resolve;});
 state.handler=async(route,path)=>{if(!path.endsWith('/files'))return false;if(path.includes('/first/')){firstRequested=true;await gate;await route.fulfill({json:{files:[{path:'private-first-project.mov',size:1,modifiedAt:date}]}});}else await route.fulfill({json:{files:Array.from({length:55},(_,i)=>({path:`second-project/clip-${String(i+1).padStart(2,'0')}.mov`,size:i+1,modifiedAt:date}))}});return true;};
 await mock(page,state);await page.goto('/#infrastructure');await card(page,'First server').click();await expect.poll(()=>firstRequested).toBe(true);await page.getByRole('dialog').getByRole('button',{name:'Close dialog',exact:true}).click();await card(page,'Second server').click();
 await expect(page.getByRole('dialog')).toContainText('Showing 1–50 of 55 files');release();await expect(page.getByText('private-first-project.mov')).toHaveCount(0);
 await page.getByLabel('Sort files',{exact:true}).selectOption('size');await expect(page.getByRole('row').nth(1)).toContainText('clip-55.mov');
 await page.getByLabel('Search indexed files',{exact:true}).fill('missing');await expect(page.getByRole('heading',{name:'No paths match your search',exact:true})).toBeVisible();await page.getByRole('button',{name:'Clear file search',exact:true}).click();await page.getByRole('button',{name:'Next',exact:true}).click();await expect(page.getByRole('dialog')).toContainText('Showing 51–55 of 55 files');
});

test('opportunities combine applicant and compensation filters and prevent duplicate introductions',async({page})=>{
 const state=fixture();state.openings=[opening('human','Documentary editor','human'),opening('agent','Research assistant','agent'),opening('either','Production researcher'),opening('volunteer','Archive volunteer','human','volunteer')];state.mine=[application('mine','human',{openingTitle:'Documentary editor',companyName:company.name,userId:user.id})];
 await mock(page,state);await page.goto('/#opportunities');await expect(card(page,'Documentary editor')).toContainText('Applied');
 await page.getByLabel('Who can apply',{exact:true}).selectOption('human');await page.getByLabel('Compensation',{exact:true}).selectOption('paid');await expect(card(page,'Documentary editor')).toBeVisible();await expect(card(page,'Production researcher')).toBeVisible();await expect(card(page,'Research assistant')).toHaveCount(0);await expect(card(page,'Archive volunteer')).toHaveCount(0);
 await page.getByLabel('Search opportunities',{exact:true}).fill('nothing matches');await expect(page.getByRole('heading',{name:'No openings match your filters',exact:true})).toBeVisible();await page.getByRole('button',{name:'Clear filters',exact:true}).first().click();await expect(card(page,'Archive volunteer')).toBeVisible();
 await card(page,'Documentary editor').click();await expect(page.getByRole('dialog')).toContainText('You already applied');await expect(page.getByRole('button',{name:'Send application',exact:true})).toHaveCount(0);await page.getByRole('button',{name:'Close dialog',exact:true}).click();await page.getByRole('button',{name:/^My applications/}).click();await expect(page.getByRole('heading',{name:'Your application history',exact:true})).toBeVisible();
});

test('agent applications keep company selectors usable and discard a late company response',async({page})=>{
 const second={...company,id:'ux-second',name:'Studio South',role:'admin'},member={...company,id:'ux-member',name:'Member-only company',role:'member'},state=fixture();state.companies.push(second,member);state.openings=[opening('agent-only','Agent research role','agent')];let delayed=false;let release:()=>void=()=>{};const gate=new Promise<void>(resolve=>{release=resolve;});let submitted:unknown;
 state.handler=async(route,path)=>{if(path===`/api/companies/${company.id}/workspace`&&delayed){await gate;await route.fulfill({json:workspace({agents:[agent('agent-a','Agent Alpha')]})});return true;}if(path===`/api/companies/${second.id}/workspace`){await route.fulfill({json:workspace({company:second,agents:[agent('agent-b','Agent Beta')]})});return true;}if(path==='/api/opportunities/agent-only/apply'){submitted=route.request().postDataJSON();await route.fulfill({status:201,json:{application:application('new','agent-only',{agentId:'agent-b',userId:user.id})}});return true;}return false;};
 await mock(page,state);await page.goto('/#opportunities');await card(page,'Agent research role').click();const dialog=page.getByRole('dialog');await expect(dialog.getByRole('button',{name:'Send application',exact:true})).toBeDisabled();
 await expect(dialog.getByLabel('Agent’s current company',{exact:true})).toBeEnabled();await expect(dialog.getByRole('option',{name:'Member-only company',exact:true})).toHaveCount(0);delayed=true;await dialog.getByLabel('Agent’s current company',{exact:true}).selectOption(company.id);await dialog.getByLabel('Agent’s current company',{exact:true}).selectOption(second.id);await expect(dialog.getByRole('option',{name:/Agent Beta/})).toHaveCount(1);release();await expect(dialog.getByRole('option',{name:/Agent Alpha/})).toHaveCount(0);await dialog.getByLabel('Agent identity',{exact:true}).selectOption('agent-b');await dialog.getByLabel('Your introduction',{exact:true}).fill('I will prepare a well-documented research contribution for review.');await dialog.getByRole('button',{name:'Send application',exact:true}).click();await expect(dialog.getByRole('heading',{name:'Application submitted',exact:true})).toBeVisible();expect(submitted).toMatchObject({agentId:'agent-b'});
});

test('hiring stages preserve applicant identity and protect accepted invitations',async({page})=>{
 const role=opening('role','Creative producer'),state=fixture(workspace({openings:[role],applications:[application('self','role',{userId:user.id,applicantName:'Own introduction'}),application('jane','role',{applicantName:'Jane Reviewer'}),application('short','role',{status:'shortlisted'})]}));
 state.handler=async(route,path)=>{if(path.endsWith('/applications/jane')&&route.request().method()==='PATCH'){expect(route.request().postDataJSON()).toEqual({status:'accepted'});state.workspace.applications=state.workspace.applications.map(a=>a.id==='jane'?{...a,status:'accepted'}:a);await route.fulfill({json:{application:application('jane','role',{status:'accepted',applicantName:undefined,applicantEmail:undefined}),invitation:{url:'https://coatria.example.invalid/?invite=local-ux-fixture'}}});return true;}return false;};
 await mock(page,state);await page.goto('/#hiring');await page.getByRole('button',{name:/^Shortlisted 1$/}).click();await expect(page.getByRole('button',{name:/Jane Reviewer/})).toHaveCount(0);await page.getByRole('button',{name:/^New 2$/}).click();await page.getByRole('button',{name:/Own introduction/}).click();await expect(page.getByRole('option',{name:'Accept and create member invitation',exact:true})).toBeDisabled();await page.getByRole('button',{name:'Close dialog',exact:true}).click();
 await page.getByRole('button',{name:/Jane Reviewer/}).click();const dialog=page.getByRole('dialog');await dialog.getByLabel('Decision',{exact:true}).selectOption('accepted');await dialog.getByRole('button',{name:'Save application decision',exact:true}).click();await expect(dialog.getByRole('heading',{name:'Jane Reviewer',exact:true})).toBeVisible();await expect(dialog.getByRole('textbox',{name:'Accepted applicant invitation',exact:true})).toHaveValue(/local-ux-fixture/);await dialog.getByRole('button',{name:'Close dialog',exact:true}).click();await expect(dialog.getByRole('alert')).toContainText('This invitation is shown once');await dialog.getByRole('checkbox',{name:'I saved the invitation for this applicant.',exact:true}).check();await dialog.getByRole('button',{name:'Close dialog',exact:true}).click();await expect(dialog).toHaveCount(0);
});

test('members see opening information without administrator application controls',async({page})=>{
 const state=fixture(workspace({company:{...company,role:'member'},openings:[opening('role','Creative producer')],applications:[application('hidden','role',{applicantName:'Private applicant identity'})]}));
 await mock(page,state);await page.goto('/#hiring');await expect(page.getByText('Applicant review is private to administrators.',{exact:true})).toBeVisible();await expect(page.getByText('Private applicant identity')).toHaveCount(0);await expect(page.getByRole('button',{name:'Create an opening',exact:true})).toHaveCount(0);await card(page,'Creative producer').click();await expect(page.getByRole('button',{name:'Publish opening',exact:true})).toHaveCount(0);await expect(page.getByLabel('Search applicants',{exact:true})).toHaveCount(0);
});

test('an older application-history response cannot erase a newly submitted introduction',async({page})=>{
 const state=fixture();state.openings=[opening('new-role','New research opening','human')];let release:()=>void=()=>{};const gate=new Promise<void>(resolve=>{release=resolve;});let historyRequested=false;
 state.handler=async(route,path)=>{if(path==='/api/applications'){historyRequested=true;await gate;await route.fulfill({json:{applications:[]}});return true;}if(path==='/api/opportunities/new-role/apply'){await route.fulfill({status:201,json:{application:application('new-introduction','new-role',{userId:user.id})}});return true;}return false;};
 await mock(page,state);await page.goto('/#opportunities');await expect.poll(()=>historyRequested).toBe(true);await card(page,'New research opening').click();await page.getByRole('dialog').getByLabel('Your introduction',{exact:true}).fill('I will prepare a carefully documented research contribution for review.');await page.getByRole('button',{name:'Send application',exact:true}).click();await expect(page.getByRole('heading',{name:'Application submitted',exact:true})).toBeVisible();
 const historyResponse=page.waitForResponse(r=>new URL(r.url()).pathname==='/api/applications');release();await (await historyResponse).finished();await page.getByRole('dialog').getByRole('button',{name:'Done',exact:true}).click();await expect(card(page,'New research opening')).toContainText('Applied');await page.getByRole('button',{name:/^My applications/}).click();await expect(page.getByRole('button',{name:/New research opening/})).toBeVisible();
});

test('losing administrator access discards an in-flight connection credential',async({page})=>{
 const state=fixture();let release:()=>void=()=>{};const gate=new Promise<void>(resolve=>{release=resolve;});let createRequested=false;const token='ca_'+'late-local-ux-fixture';
 state.handler=async(route,path)=>{if(path===`/api/companies/${company.id}/agents`&&route.request().method()==='POST'){createRequested=true;await gate;await route.fulfill({status:201,json:{agent:agent('late-agent','Late identity'),token}});return true;}return false;};
 await mock(page,state);await page.goto('/#agents');await page.getByRole('button',{name:'Connect an agent',exact:true}).click();await page.getByRole('dialog').getByLabel('Agent name',{exact:true}).fill('Late identity');await page.getByRole('button',{name:'Create agent identity',exact:true}).click();await expect.poll(()=>createRequested).toBe(true);
 state.workspace={...state.workspace,company:{...company,role:'member'},members:state.workspace.members.map(m=>({...m,role:'member'}))};state.companies=[state.workspace.company];await page.evaluate(()=>document.dispatchEvent(new Event('visibilitychange')));await expect(page.getByRole('dialog')).toHaveCount(0);await expect(page.getByRole('button',{name:'Connect an agent',exact:true})).toHaveCount(0);
 const creationResponse=page.waitForResponse(r=>new URL(r.url()).pathname===`/api/companies/${company.id}/agents`&&r.request().method()==='POST');release();await (await creationResponse).finished();await page.getByLabel('Search agents',{exact:true}).fill('late');await expect(page.getByRole('textbox',{name:'Connection token',exact:true})).toHaveCount(0);expect(await page.locator('body').textContent()).not.toContain(token);
});


test('office agent summaries stop counting identities whose sponsor lost administrator access',async({page})=>{
 const state=fixture(workspace({agents:[agent('eligible','Owner agent',{lastSeenAt:new Date().toISOString()}),agent('demoted','Former admin agent',{createdBy:'former-admin',lastSeenAt:new Date().toISOString()})],drives:[drive('server-one','Studio archive')]}));
 state.workspace.members.push({...user,id:'former-admin',userId:'former-admin',name:'Former administrator',role:'member'});
 await mock(page,state);await page.goto('/#office');
 await expect(page.getByText('1 recently connected agent',{exact:true})).toBeVisible();await expect(page.getByText('1 enabled identity · recent activity within 2 minutes',{exact:true})).toBeVisible();
 await page.getByRole('navigation',{name:'Main navigation'}).getByRole('button',{name:'Infrastructure',exact:true}).click();
 await expect(page.getByText('Saved connections',{exact:true})).toBeVisible();await expect(page.getByText('Access enabled',{exact:true})).toHaveCount(0);
});
