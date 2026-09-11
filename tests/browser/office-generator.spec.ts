import {test,expect,type Page,type Route} from '@playwright/test';
import {mkdir} from 'node:fs/promises';
import path from 'node:path';
import type {Workspace,LayoutItem} from '../../src/lib/client';
import {generateOffice,OFFICE_GENERATOR_PRESETS,type OfficeGeneratorOptions} from '../../src/lib/office-generator';
import {getOfficeAsset} from '../../src/lib/office-catalog';

// Intercepted loopback fixtures verify the real editor and SVG preview, not
// production data or a GPU/multiplayer benchmark. No purchased bytes are copied.
const user={id:'10000000-0000-4000-8000-000000000231',name:'Generator Reviewer',email:'generator@example.invalid',roleTitle:'Studio owner',avatarColor:'#617e54',avatarId:null};
const company={id:'20000000-0000-4000-8000-000000000231',name:'Generator Fixture Studio',slug:'generator-fixture',template:'blank',role:'owner'};
const original:LayoutItem={id:'original-desk',type:'desk',x:20,y:25,w:15,h:12.5,label:'Existing desk'};
const png=Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR4nGPoXdjyHwAGIwKyeWvUQwAAAABJRU5ErkJggg==','base64');
const copy=<T,>(value:T):T=>JSON.parse(JSON.stringify(value));
const json=(route:Route,value:unknown,status=200)=>route.fulfill({status,contentType:'application/json',body:JSON.stringify(value)});
const button=(page:Page,name:string)=>page.getByRole('button',{name,exact:true});
const field=(page:Page,name:string)=>page.getByLabel(name,{exact:true});
const dialog=(page:Page)=>page.getByRole('dialog',{name:'Office templates',exact:true});
const objects=(page:Page)=>page.getByTestId('floor-plan').locator('[data-object-id]');
const apply=(page:Page)=>dialog(page).getByRole('button',{name:'Use this layout',exact:true});
const tab=(page:Page,name:string)=>dialog(page).getByRole('tab',{name,exact:true});

async function fixture(page:Page){
 const data:Workspace={company,members:[{...user,userId:user.id,role:'owner'}],rooms:[],agents:[],tasks:[],messages:[],presence:[],activity:[],drives:[],openings:[],applications:[],layout:[copy(original)],floor:{width:20,depth:16},layoutRevision:4};
 const requests:{path:string;method:string;body:any}[]=[],errors:string[]=[];page.on('pageerror',error=>errors.push(error.message));
 await page.route('**/api/**',async route=>{
  const request=route.request(),pathname=new URL(request.url()).pathname,method=request.method(),body=request.postData()?request.postDataJSON():null;requests.push({path:pathname,method,body});
  if(pathname==='/api/session')return json(route,{user,companies:[company],configured:true});
  if(pathname===`/api/companies/${company.id}/workspace`)return json(route,data);
  if(pathname===`/api/companies/${company.id}/presence`)return json(route,{presence:[]});
  if(/^\/api\/office-assets\/[^/]+\/(preview|plan)$/.test(pathname))return route.fulfill({status:200,contentType:'image/png',body:png});
  if(pathname===`/api/companies/${company.id}/layout`&&method==='PATCH'){
   if(body.revision!==data.layoutRevision)return json(route,{error:'The shared floor changed.',code:'LAYOUT_CONFLICT'},409);
   data.layout=copy(body.layout);data.floor=copy(body.floor);data.layoutRevision!++;return json(route,{layout:data.layout,floor:data.floor,layoutRevision:data.layoutRevision});
  }
  return json(route,{error:'Unexpected generator fixture request.'},501);
 });
 return {data,requests,errors,writes:()=>requests.filter(request=>request.method==='PATCH')};
}
async function open(page:Page,generate=false){await page.goto('/#layout');await button(page,'Office templates').click();await expect(dialog(page)).toBeVisible();if(generate)await tab(page,'Generate a studio').click();}
async function seedField(page:Page){const input=dialog(page).getByLabel('Layout seed',{exact:true});if(!await input.isVisible())await dialog(page).getByText('Keep a layout seed',{exact:true}).click();return input;}
async function settings(page:Page,options:OfficeGeneratorOptions){
 await field(page,'Workstations').fill(String(options.deskCount));await field(page,'Meeting rooms').fill(String(options.roomCount));await field(page,'Space to breathe').selectOption(options.spaciousness);
 const labels={courtyard:'Courtyard',neighborhoods:'Neighborhoods',gallery:'Gallery'};
 await dialog(page).getByRole('group',{name:'Studio style'}).getByRole('button',{name:new RegExp('^'+labels[options.style])}).click();await (await seedField(page)).fill(String(options.seed));
}
async function previewSignature(page:Page){return dialog(page).getByRole('img').locator('[data-plan-object]').evaluateAll(elements=>elements.map(element=>({id:element.getAttribute('data-plan-object'),x:element.getAttribute('x'),y:element.getAttribute('y'),width:element.getAttribute('width'),height:element.getAttribute('height'),fill:element.getAttribute('fill')})));}
async function save(page:Page){await button(page,'Save shared floor plan').click();await expect(page.getByText('Shared floor plan is up to date',{exact:true})).toBeVisible();}
async function screenshot(page:Page,name:string){const output=path.resolve(process.cwd(),'../output/coatria-office-generator-ui');await mkdir(output,{recursive:true});await page.screenshot({path:path.join(output,name+'.png')});}

test.beforeEach(({baseURL})=>{test.skip(!baseURL||!['localhost','127.0.0.1'].includes(new URL(baseURL).hostname),'Generator fixtures only run against loopback.');});

for(const definition of OFFICE_GENERATOR_PRESETS)test(`${definition.name} applies the exact curated geometry as an unpublished draft`,async({page})=>{
 const state=await fixture(page),expected=generateOffice(definition.options);await open(page);
 await dialog(page).getByRole('button',{name:new RegExp('^'+definition.name.replace(/[.*+?^${}()|[\]\\]/g,'\\$&'))}).click();await expect(dialog(page).getByRole('heading',{name:definition.name,exact:true})).toBeVisible();
 await expect(dialog(page).getByRole('img')).toHaveAccessibleName(definition.name+' floor plan, '+definition.options.deskCount+' workstations');
 await dialog(page).getByRole('button',{name:'Use '+definition.name,exact:true}).click();await expect(dialog(page)).toHaveCount(0);await expect(objects(page)).toHaveCount(expected.layout.length);await expect(field(page,'Floor width (m)')).toHaveValue(String(expected.floor.width));await expect(field(page,'Floor depth (m)')).toHaveValue(String(expected.floor.depth));expect(state.writes()).toHaveLength(0);expect(state.data.layout).toEqual([original]);
 await save(page);expect(state.writes()).toHaveLength(1);expect(state.writes()[0].body).toEqual({layout:expected.layout,floor:expected.floor,revision:4});expect(state.data.rooms).toEqual([]);expect(state.errors).toEqual([]);
});

test('custom counts apply as one undo step and Save persists every requested desk, chair and nook',async({page})=>{
 const state=await fixture(page),options:OfficeGeneratorOptions={deskCount:17,roomCount:5,style:'gallery',spaciousness:'balanced',seed:'Editorial team'},expected=generateOffice(options);await open(page,true);await settings(page,options);
 await expect(apply(page)).toBeDisabled();await button(page,'Generate preview').click();await expect(apply(page)).toBeEnabled();await expect(dialog(page).getByText(/do not create audio rooms/)).toBeVisible();await apply(page).click();
 await expect(objects(page)).toHaveCount(expected.layout.length);expect(state.writes()).toHaveLength(0);await button(page,'Undo').click();await expect(objects(page)).toHaveCount(1);await expect(button(page,'Select Existing desk')).toBeVisible();await expect(field(page,'Floor width (m)')).toHaveValue('20');await expect(button(page,'Save shared floor plan')).toBeDisabled();
 await button(page,'Redo').click();await expect(objects(page)).toHaveCount(expected.layout.length);await save(page);expect(state.writes()).toHaveLength(1);expect(state.writes()[0].body).toEqual({layout:expected.layout,floor:expected.floor,revision:4});
 expect(state.data.layout.filter(item=>getOfficeAsset(item.assetId||'')?.category==='desks')).toHaveLength(17);expect(state.data.layout.filter(item=>item.label.endsWith(' chair')&&item.label.startsWith('Workstation'))).toHaveLength(17);expect(state.data.layout.filter(item=>item.label.endsWith(' back divider'))).toHaveLength(5);
 await page.reload();await expect(objects(page)).toHaveCount(expected.layout.length);await expect(field(page,'Floor width (m)')).toHaveValue(String(expected.floor.width));await expect(button(page,'Save shared floor plan')).toBeDisabled();expect(state.data.layoutRevision).toBe(5);expect(state.requests.filter(request=>request.method!=='GET'&&!request.path.endsWith('/presence')).map(request=>request.path)).toEqual([`/api/companies/${company.id}/layout`]);expect(state.errors).toEqual([]);
});

test('changed or invalid settings preserve the last preview but block applying stale geometry',async({page})=>{
 const state=await fixture(page);await open(page,true);const originalPreview=await previewSignature(page);
 await field(page,'Workstations').fill('61');await expect(apply(page)).toBeDisabled();await expect(dialog(page).getByRole('status')).toHaveText('Settings changed. Generate a preview to see and apply them.');await button(page,'Generate preview').click();await expect(dialog(page).getByRole('alert')).toHaveText('Choose 1–60 workstations and 0–8 rooms.');expect(await previewSignature(page)).toEqual(originalPreview);
 await field(page,'Workstations').fill('24');await field(page,'Meeting rooms').fill('2.5');await button(page,'Generate preview').click();await expect(apply(page)).toBeDisabled();expect(await previewSignature(page)).toEqual(originalPreview);
 await field(page,'Meeting rooms').fill('0');await button(page,'Generate preview').click();await expect(apply(page)).toBeEnabled();const zeroRooms=await previewSignature(page);await field(page,'Meeting rooms').fill('');await expect(apply(page)).toBeDisabled();await button(page,'Generate preview').click();await expect(dialog(page).getByRole('alert')).toBeVisible();expect(await previewSignature(page)).toEqual(zeroRooms);
 await field(page,'Meeting rooms').fill('0');await (await seedField(page)).fill('   ');await button(page,'Generate preview').click();await expect(dialog(page).getByRole('alert')).toHaveText('Enter a layout seed, or choose New variation.');await expect(apply(page)).toBeDisabled();expect(state.writes()).toHaveLength(0);expect(state.data.layout).toEqual([original]);
});

test('a seed reproduces the exact preview and New variation changes it without publishing',async({page})=>{
 const state=await fixture(page),options:OfficeGeneratorOptions={deskCount:24,roomCount:3,style:'courtyard',spaciousness:'airy',seed:'Reproducible studio'};await open(page,true);await settings(page,options);await button(page,'Generate preview').click();const first=await previewSignature(page);
 await button(page,'New variation').click();const newSeed=await field(page,'Layout seed').inputValue();expect(newSeed).toMatch(/^[a-f0-9]{8}$/);expect(newSeed).not.toBe(options.seed);const varied=await previewSignature(page),visual=(shapes:typeof varied)=>shapes.map(({id,...shape})=>shape);expect(visual(varied)).not.toEqual(visual(first));await expect(apply(page)).toBeEnabled();
 await field(page,'Layout seed').fill(String(options.seed));await expect(apply(page)).toBeDisabled();await button(page,'Generate preview').click();expect(await previewSignature(page)).toEqual(first);expect(state.writes()).toHaveLength(0);expect(state.data.layout).toEqual([original]);
});

test('floor finishes paint underneath furniture in both the preset and generated previews',async({page})=>{
 await fixture(page);await open(page);await dialog(page).getByRole('button',{name:/^Canopy Court/}).click();
 for(const mode of ['preset','generated']){if(mode==='generated')await tab(page,'Generate a studio').click();const shapes=dialog(page).getByRole('img').locator('[data-plan-layer]'),layers=await shapes.evaluateAll(elements=>elements.map(element=>element.getAttribute('data-plan-layer')));expect(layers).toContain('floor');expect(layers).toContain('furniture');const firstFurniture=layers.indexOf('furniture');expect(layers.slice(firstFurniture).every(layer=>layer==='furniture')).toBe(true);expect(await shapes.count()).toBeGreaterThan(70);}
 await screenshot(page,'desktop-generated');await apply(page).scrollIntoViewIfNeeded();await screenshot(page,'desktop-result');
});

test('tab keyboard navigation stays within the dialog and never edits or publishes the underlying draft',async({page})=>{
 const state=await fixture(page);await page.goto('/#layout');await button(page,'Select Existing desk').click();await field(page,'Label').fill('Unpublished existing desk');await field(page,'Label').press('Tab');const before={left:await field(page,'Left (m)').inputValue(),top:await field(page,'Top (m)').inputValue()};await button(page,'Office templates').click();
 await tab(page,'Studio presets').focus();await page.keyboard.press('ArrowRight');await expect(tab(page,'Generate a studio')).toHaveAttribute('aria-selected','true');await expect(tab(page,'Generate a studio')).toBeFocused();await expect(tab(page,'Studio presets')).toHaveAttribute('tabindex','-1');await page.keyboard.press('Home');await expect(tab(page,'Studio presets')).toBeFocused();await page.keyboard.press('End');await expect(tab(page,'Generate a studio')).toBeFocused();await page.keyboard.press('Control+s');expect(state.writes()).toHaveLength(0);
 await page.keyboard.press('Escape');await expect(dialog(page)).toHaveCount(0);await expect(button(page,'Office templates')).toBeFocused();await expect(field(page,'Label')).toHaveValue('Unpublished existing desk');await expect(field(page,'Left (m)')).toHaveValue(before.left);await expect(field(page,'Top (m)')).toHaveValue(before.top);await expect(button(page,'Save shared floor plan')).toBeEnabled();await button(page,'Undo').click();await expect(field(page,'Label')).toHaveValue('Existing desk');await expect(button(page,'Save shared floor plan')).toBeDisabled();
});

test('maximum counts show decoration limits and retain all requested furniture',async({page})=>{
 const state=await fixture(page);await open(page,true);await field(page,'Workstations').fill('60');await field(page,'Meeting rooms').fill('8');await button(page,'Generate preview').click();await expect(dialog(page).getByText(/Some optional planting and shared furniture were omitted/)).toBeVisible();await expect(dialog(page).getByText(/All 60 desk-and-chair pairs and 8 meeting nooks are included/)).toBeVisible();await apply(page).click();await expect(objects(page)).toHaveCount(180);await save(page);expect(state.data.layout.filter(item=>item.label.startsWith('Workstation')&&item.label.endsWith(' desk'))).toHaveLength(60);expect(state.data.layout.filter(item=>item.label.endsWith(' back divider'))).toHaveLength(8);expect(state.errors).toEqual([]);
});

test('390px generator remains within the viewport with readable fields and a reachable apply action',async({page})=>{
 const state=await fixture(page);await page.setViewportSize({width:390,height:844});await open(page);await screenshot(page,'mobile-presets');await tab(page,'Generate a studio').click();
 for(const label of ['Workstations','Meeting rooms','Space to breathe']){await expect(field(page,label)).toBeVisible();expect(await field(page,label).evaluate(element=>parseFloat(getComputedStyle(element).fontSize))).toBeGreaterThanOrEqual(16);}
 await field(page,'Workstations').fill('12');await field(page,'Meeting rooms').fill('2');await button(page,'Generate preview').click();await screenshot(page,'mobile-generated');
 const bounds=await dialog(page).boundingBox();expect(bounds).not.toBeNull();expect(bounds!.x).toBeGreaterThanOrEqual(0);expect(bounds!.x+bounds!.width).toBeLessThanOrEqual(391);expect(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth+1)).toBe(true);expect(await dialog(page).evaluate(element=>element.scrollWidth<=element.clientWidth+1)).toBe(true);
 await apply(page).scrollIntoViewIfNeeded();await expect(apply(page)).toBeInViewport();await screenshot(page,'mobile-result');await apply(page).click();await expect(dialog(page)).toHaveCount(0);expect(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth+1)).toBe(true);expect(state.writes()).toHaveLength(0);expect(state.errors).toEqual([]);
});
