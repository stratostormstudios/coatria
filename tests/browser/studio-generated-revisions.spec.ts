import {test,expect,type Page} from '@playwright/test';
import {generatedFixture,mockGenerated,openGenerated,noOverflow,ids,uuid,date} from './studio-generated-fixture';
import {studioGeneratedRevisionDraftInput,studioGeneratedRevisionApplyInput,type StudioGeneratedRevisionPlan,type StudioGeneratedRevisionSourceDetail} from '../../src/lib/studio-generated-revision-protocol';

test.beforeEach(({baseURL})=>{test.skip(!baseURL||!['localhost','127.0.0.1'].includes(new URL(baseURL).hostname),'Synthetic fixtures require a local origin.');});
function revisionFixture(){
 const state=generatedFixture(),unit2=uuid(101),oldWork=uuid(102),oldQc=uuid(103),roundId=uuid(110);
 state.detail.shots.push({...state.detail.shots[0],id:unit2,code:'D020',description:'Second campaign image to retain'});
 state.detail.workItems.push({...state.detail.workItems[0],id:oldWork,taskId:uuid(104),shotId:unit2,title:'D020 · Original generation'},{...state.detail.workItems[1],id:oldQc,taskId:uuid(105),shotId:unit2,dependencies:[oldWork],title:'D020 · Original QC'});
 state.detail.workItems.forEach(work=>{work.status='done';work.readiness='accepted';});
 const original={...state.artifact,reviewStatus:'approved' as const},kept={...structuredClone(original),id:uuid(106),name:'Preserved second image',workItemId:oldWork,provenance:{...original.provenance,storageVersionId:uuid(107)}};
 state.detail.artifacts=[original,kept];
 const reviews=[original,kept].map((artifact,i)=>({contractVersion:2 as const,id:uuid(120+i),artifactId:artifact.id,decision:'approved' as const,note:'Independent original review.',technicalQc:true,reviewedBy:ids.user,createdAt:date,specSha256:artifact.specSha256,manifestSha256:artifact.manifestSha256,attestationVersion:1 as const,technicalMatch:{matches:true,issues:[],limitations:artifact.limitations}}));state.detail.reviews=reviews;
 state.detail.deliveries=[{id:uuid(130),name:'Original approved package',note:'Preserved original delivery.',status:'prepared',createdAt:date,manifest:{schemaVersion:2,transportStatus:'not_transferred'},roundId:null,roundNumber:0}];
 const source:StudioGeneratedRevisionSourceDetail={source:{shareId:uuid(131),receiptId:uuid(132),deliveryId:uuid(130),packageSha256:'d'.repeat(64),sourceManifestSha256:'e'.repeat(64),clientUserId:uuid(133),note:'Please make D010 warmer. Keep D020 exactly as approved.',roundId:null},items:state.detail.shots.map((unit,i)=>({unitId:unit.id,code:unit.code,description:unit.description,mediaKind:unit.kind,base:{artifactId:state.detail.artifacts[i].id,reviewId:reviews[i].id,storageVersionId:state.detail.artifacts[i].provenance.storageVersionId,manifestSha256:state.detail.artifacts[i].manifestSha256,fileSha256:state.detail.artifacts[i].file.sha256,generationWorkItemId:i?oldWork:ids.work,qcWorkItemId:i?oldQc:ids.qc}}))};
 state.detail.project.gates.client_acceptance={decision:'changes_requested',note:source.source.note,recordedBy:source.source.clientUserId,at:date,source:'authenticated_external_client',clientReceiptId:source.source.receiptId,clientDeliveryId:source.source.shareId,packageSha256:source.source.packageSha256};
 const plans:StudioGeneratedRevisionPlan[]=[],draftBodies:unknown[]=[],applyBodies:unknown[]=[];
 let failDraft=false,failApply=false,staleExact=false,sourceAvailable=true;
 function makePlan():StudioGeneratedRevisionPlan{return {schemaVersion:1,id:uuid(140),projectId:ids.project,projectRevision:state.detail.project.revision,source:structuredClone(source.source),summary:'Warmer hero image, preserve the companion.',items:source.items.map((item,i)=>({...structuredClone(item),action:i?'carry':'regenerate',instructions:i?'':'Warm the lighting. Preserve composition and product details.'})),planSha256:'f'.repeat(64),createdBy:ids.producer,createdAgentId:uuid(141),createdAt:date,appliedRoundId:null};}
 function activate(){
  const history=structuredClone(state.detail.workItems),gen={...history[0],id:uuid(150),taskId:uuid(151),title:'D010 · Revision 1 generation',description:'Warm the lighting. Preserve composition and product details.',status:'todo' as const,readiness:'blocked' as const},qc={...history[1],id:uuid(152),taskId:uuid(153),dependencies:[gen.id],title:'D010 · Revision 1 independent QC',status:'todo' as const,readiness:'blocked' as const},delivery={...history[2],id:uuid(154),taskId:uuid(155),dependencies:[qc.id],title:'Revision 1 delivery handoff',status:'todo' as const,readiness:'blocked' as const};
  state.detail.historyWorkItems=history;state.detail.workItems=[gen,qc,delivery];state.detail.generatedRound={roundId,number:1,planSha256:'f'.repeat(64),workItemIds:[gen.id,qc.id,delivery.id],finals:[{unitId:ids.unit,generationWorkItemId:gen.id,qcWorkItemId:qc.id,carry:null},{unitId:unit2,generationWorkItemId:oldWork,qcWorkItemId:oldQc,carry:{artifactId:kept.id,reviewId:reviews[1].id,storageVersionId:kept.provenance.storageVersionId,manifestSha256:kept.manifestSha256,fileSha256:kept.file.sha256}}]};state.detail.project.revision++;sourceAvailable=false;delete state.detail.project.gates.client_acceptance;
 }
 state.handler=async(route,url)=>{
  const method=route.request().method();
  if(url.pathname.endsWith('/generated-revisions')&&method==='GET'){
   const selected=url.searchParams.get('planId');
   await route.fulfill({json:{projectRevision:state.detail.project.revision+(selected&&staleExact?1:0),currentRound:state.detail.generatedRound?{id:roundId,number:1,planId:uuid(140),planSha256:'f'.repeat(64),approvedBy:ids.user,createdAt:date}:null,source:selected||!sourceAvailable?null:source,sourceBlockedReason:sourceAvailable?null:'The current round needs its own client response.',plan:selected?plans.find(plan=>plan.id===selected)??null:null,plans:plans.map(({items,...plan})=>({...plan,summary:plan.summary.slice(0,320),changedCount:items.filter(item=>item.action==='regenerate').length,carryCount:items.filter(item=>item.action==='carry').length})),page:{hasMore:false,nextAfter:null,limit:20}}});return true;
  }
  if(url.pathname.endsWith('/generated-revisions')&&method==='POST'){
   const body=studioGeneratedRevisionDraftInput.parse(route.request().postDataJSON());draftBodies.push(body);
   if(!plans.length){const plan=makePlan();plan.createdBy=ids.user;plan.createdAgentId=null;plan.summary=body.summary;plan.items=source.items.map(item=>{const chosen=body.items.find(value=>value.unitId===item.unitId)!;return {...item,...chosen,instructions:chosen.action==='regenerate'?chosen.instructions:''};});plans.push(plan);}
   if(failDraft&&draftBodies.length===1)await route.fulfill({status:503,json:{error:'Synthetic lost draft acknowledgement.'}});else await route.fulfill({json:{plan:plans[0],replayed:draftBodies.length>1}});return true;
  }
  if(url.pathname.endsWith('/generated-revisions/'+uuid(140)+'/apply')){
   const body=studioGeneratedRevisionApplyInput.parse(route.request().postDataJSON());applyBodies.push(body);
   if(!plans[0].appliedRoundId){activate();plans[0].appliedRoundId=roundId;}
   if(failApply&&applyBodies.length===1)await route.fulfill({status:503,json:{error:'Synthetic lost approval acknowledgement.'}});else await route.fulfill({json:{plan:plans[0],round:{id:roundId,number:1},project:state.detail.project,replayed:applyBodies.length>1}});return true;
  }
  return false;
 };
 return {state,source,plans,draftBodies,applyBodies,makePlan,activate,setFailDraft(){failDraft=true;},setFailApply(){failApply=true;},setStaleExact(){staleExact=true;}};
}
async function reviewTab(page:Page){await page.getByRole('tab',{name:/^Review & delivery/}).click();await expect(page.getByRole('region',{name:'Creative revision planning'})).toBeVisible();}
test('human drafts exact selective work and retries uncertain draft and approval without changing evidence',async({page},testInfo)=>{
 const f=revisionFixture(),errors:string[]=[];f.setFailDraft();f.setFailApply();page.on('pageerror',error=>errors.push(error.message));
 await mockGenerated(page,f.state);await openGenerated(page,f.state);await page.getByRole('button',{name:'Plan the client’s revisions'}).click();
 await page.getByRole('button',{name:'Draft revision plan',exact:true}).click();const dialog=page.getByRole('dialog');
 await dialog.getByLabel('Revision summary').fill('Make the hero warmer; keep the companion unchanged.');await dialog.getByLabel('D010 revision action').selectOption('regenerate');await dialog.getByLabel('D010 creative corrections').fill('Warm the lighting. Preserve composition and product details.');
 await page.setViewportSize({width:390,height:844});await noOverflow(page);await page.screenshot({path:testInfo.outputPath('revision-draft-mobile.png'),fullPage:false});
 await dialog.getByRole('button',{name:'Save revision draft'}).click();await expect(dialog.getByText('Synthetic lost draft acknowledgement.')).toBeVisible();await expect(dialog.getByLabel('Revision summary')).toBeDisabled();
 await dialog.getByRole('button',{name:'Retry exact draft'}).click();await expect(dialog).toHaveCount(0);expect(f.draftBodies[1]).toEqual(f.draftBodies[0]);
 const body=f.draftBodies[0] as {items:unknown[]};expect(body.items).toEqual([{unitId:ids.unit,action:'regenerate',instructions:'Warm the lighting. Preserve composition and product details.'},{unitId:uuid(101),action:'carry'}]);
 await page.getByRole('button',{name:'Review revision plan',exact:true}).click();await expect(dialog.getByText('Warm the lighting. Preserve composition and product details.',{exact:true})).toBeVisible();
 await dialog.getByText('Preserved source version',{exact:true}).first().click();await expect(dialog).toContainText(f.source.items[0].base.fileSha256);await noOverflow(page);
 await dialog.getByRole('checkbox').check();await dialog.getByRole('button',{name:'Approve & create revision work'}).click();await expect(dialog.getByText('Synthetic lost approval acknowledgement.')).toBeVisible();
 await dialog.getByRole('button',{name:'Retry exact plan approval'}).click();await expect(dialog).toHaveCount(0);expect(f.applyBodies[1]).toEqual(f.applyBodies[0]);
 await expect(page.getByRole('region',{name:'Creative revision planning'})).toContainText('Revision round 1');await page.getByRole('button',{name:'View preserved plan'}).click();await expect(dialog.getByRole('button',{name:'Approve & create revision work'})).toHaveCount(0);await expect(dialog).toContainText('Keep exact version');
 await noOverflow(page);await page.screenshot({path:testInfo.outputPath('preserved-plan-mobile.png'),fullPage:false});expect(errors).toEqual([]);expect(f.state.unexpected).toEqual([]);
 expect(f.state.writes.every(write=>write.path.endsWith('/presence')||write.path.includes('/generated-revisions'))).toBe(true);
});
test('members inspect the full preserved source and plan but cannot draft or approve',async({page},testInfo)=>{
 const f=revisionFixture();f.state.company.role='member';f.plans.push(f.makePlan());await mockGenerated(page,f.state);await openGenerated(page,f.state);await reviewTab(page);
 await expect(page.getByText(f.source.source.note,{exact:true})).toBeVisible();await expect(page.getByRole('button',{name:'Draft revision plan',exact:true})).toHaveCount(0);
 await page.getByRole('button',{name:'View revision plan',exact:true}).click();const dialog=page.getByRole('dialog');await expect(dialog).toContainText('Warm the lighting. Preserve composition and product details.');await expect(dialog).toContainText('Only a human company administrator');await expect(dialog.getByRole('checkbox')).toHaveCount(0);
 await page.screenshot({path:testInfo.outputPath('revision-plan-desktop.png'),fullPage:false});await noOverflow(page);expect(f.state.writes.filter(write=>write.path.includes('/generated-revisions'))).toEqual([]);expect(f.state.unexpected).toEqual([]);
});
test('an exact plan read at a newer project revision never opens an approval dialog',async({page})=>{
 const f=revisionFixture();f.plans.push(f.makePlan());f.setStaleExact();await mockGenerated(page,f.state);await openGenerated(page,f.state);await reviewTab(page);await page.getByRole('button',{name:'Review revision plan',exact:true}).click();await expect(page.getByRole('alert').filter({hasText:'project changed while loading'})).toBeVisible();await expect(page.getByRole('dialog')).toHaveCount(0);await expect(page.getByRole('button',{name:'Draft revision plan',exact:true})).toBeDisabled();expect(f.applyBodies).toEqual([]);
});
test('an older saved draft remains readable after project edits but cannot be applied',async({page})=>{
 const f=revisionFixture();f.plans.push(f.makePlan());f.state.detail.project.revision++;await mockGenerated(page,f.state);await openGenerated(page,f.state);await reviewTab(page);await page.getByRole('button',{name:'Review revision plan',exact:true}).click();const dialog=page.getByRole('dialog');await expect(dialog).toContainText('prepare a new draft for approval');await expect(dialog).toContainText('Warm the lighting. Preserve composition and product details.');await dialog.getByRole('checkbox').check();await expect(dialog.getByRole('button',{name:'Approve & create revision work'})).toBeDisabled();expect(f.applyBodies).toEqual([]);
});
test('account change closes the pinned draft and aborts any future approval from that scope',async({page})=>{
 const f=revisionFixture();await mockGenerated(page,f.state);await openGenerated(page,f.state);await reviewTab(page);await page.getByRole('button',{name:'Draft revision plan',exact:true}).click();await page.getByRole('dialog').getByLabel('Revision summary').fill('Never send after sign-out.');await page.evaluate(()=>window.dispatchEvent(new Event('coatria:session-changed')));await expect(page.getByRole('dialog')).toHaveCount(0);expect(f.draftBodies).toEqual([]);expect(f.applyBodies).toEqual([]);
});
test('active round keeps old tasks and package evidence read-only and carries the exact companion into new packaging',async({page},testInfo)=>{
 const f=revisionFixture();f.plans.push(f.makePlan());f.activate();f.plans[0].appliedRoundId=uuid(110);
 const next={...structuredClone(f.state.artifact),id:uuid(160),name:'Revised hero image',workItemId:uuid(150),reviewStatus:'approved' as const,provenance:{...f.state.artifact.provenance,storageVersionId:uuid(161)}};
 f.state.detail.artifacts.push(next);f.state.detail.reviews.push({...f.state.detail.reviews[0],id:uuid(162),artifactId:next.id});f.state.detail.workItems.forEach(work=>{work.status='done';work.readiness='accepted';});
 await mockGenerated(page,f.state);await openGenerated(page,f.state);await page.getByRole('tab',{name:/^Production work/}).click();await page.getByText('Earlier work · preserved history (5)',{exact:true}).click();await expect(page.getByRole('tabpanel')).toContainText('Original generation');await expect(page.getByRole('button',{name:'Register output',exact:true})).toHaveCount(1);await expect(page.getByRole('button',{name:'Register output',exact:true})).toBeDisabled();
 await page.getByRole('tab',{name:/^Deliverables/}).click();await expect(page.getByText('Kept exact approved version',{exact:true})).toBeVisible();await reviewTab(page);await expect(page.getByRole('heading',{name:'Campaign master',exact:true})).toHaveCount(0);await expect(page.getByRole('heading',{name:'Preserved second image',exact:true})).toBeVisible();await expect(page.getByRole('button',{name:'Create client invitation',exact:true})).toBeDisabled();
 await page.getByRole('button',{name:'Prepare internal package',exact:true}).click();await expect(page.getByRole('dialog')).toContainText('Revised hero image');await expect(page.getByRole('dialog')).toContainText('Preserved second image');await expect(page.getByRole('dialog')).toContainText('Kept unchanged');await noOverflow(page);await page.screenshot({path:testInfo.outputPath('revision-replacement-package.png'),fullPage:true});expect(f.state.unexpected).toEqual([]);
});
