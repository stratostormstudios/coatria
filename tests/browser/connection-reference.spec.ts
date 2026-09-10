import {test,expect,type Page} from '@playwright/test';
import type {ConnectionReport} from '../../src/lib/office-simulation';

const referencePath='/benchmarks/connections-reference.json';
const sourceCommit='0123456789abcdef0123456789abcdef01234567';
const ciUrl='https://github.com/stratostormstudios/coatria/actions/runs/123456789';
const report:ConnectionReport={schemaVersion:1,kind:'coatria-connections',generatedAt:'2026-09-10T12:00:00Z',summary:{clients:50,durationSeconds:60,requests:2500,errorRate:0,p50Ms:12,p95Ms:45,maxMs:90,requestsPerSecond:41.7,bytesReceived:100000,passed:true,unexpectedErrors:0},checks:[{id:'presence',label:'Independent sessions synchronize presence',passed:true,detail:'Measured fixture result.'}],environment:{applicationMode:'production',database:'PostgreSQL',isolated:true,origin:'http://127.0.0.1:4180',databasePoolMax:10,limitations:['Local CI environment; no global latency claim.']},cleanup:{verified:true,remainingUsers:0,remainingCompanies:0}};
const reference={...report,reference:{sourceCommit,ciUrl}};
const load=(page:Page)=>page.getByRole('button',{name:'Load reference run',exact:true});
const alert=(page:Page)=>page.locator('main').getByRole('alert');
async function setup(page:Page){
  const user={id:'10000000-0000-4000-8000-000000000292',name:'Reference Reviewer',email:'reference@example.invalid',avatarColor:'#617e54',avatarId:null},company={id:'20000000-0000-4000-8000-000000000292',name:'Reference Fixture',slug:'reference-fixture',template:'blank',role:'owner'};
  await page.addInitScript(()=>{(window as any).CoatriaOfficeRuntime={createCharacterLibrary:()=>({dispose(){}}),createOfficeAssetLibrary:()=>({dispose(){}}),mount:()=>({dispose(){},updateSnapshot(){},resetPerformance(){},diagnostics:{}})};const original=window.fetch;window.fetch=(input,options)=>{if(String(input)==='/benchmarks/connections-reference.json')(window as any).__referenceCache=options?.cache;return original(input,options);};});
  await page.route('**/api/**',route=>{const path=new URL(route.request().url()).pathname;const value=path==='/api/session'?{user,companies:[company],configured:true}:path.endsWith('/workspace')?{company,members:[{...user,userId:user.id,role:'owner'}],rooms:[],agents:[],tasks:[],messages:[],presence:[],activity:[],drives:[],openings:[],applications:[],layout:[],floor:{width:20,depth:16},layoutRevision:0}:path.endsWith('/presence')?{presence:[]}:{};return route.fulfill({contentType:'application/json',body:JSON.stringify(value)});});
  await page.goto('/#tester');await page.getByRole('tab',{name:'Connection results',exact:true}).click();
}
test.beforeEach(({baseURL})=>{test.skip(!baseURL||!['localhost','127.0.0.1'].includes(new URL(baseURL).hostname),'Read-only loopback fixtures only.');});

test('loads a measured CI reference with validated provenance, then distinguishes an uploaded report',async({page})=>{
  let requests=0;await page.route('**'+referencePath,route=>{requests++;return route.fulfill({contentType:'application/json',body:JSON.stringify(reference)});});await setup(page);await load(page).click();
  await expect(page.getByText(/Published reference run ·/)).toBeVisible();await expect(page.getByText(sourceCommit,{exact:true})).toBeVisible();const link=page.getByRole('link',{name:'View CI run',exact:true});await expect(link).toHaveAttribute('href',ciUrl);await expect(link).toHaveAttribute('rel','noopener noreferrer');await expect(page.getByText('This reference describes its tested source and CI environment; it is not a measurement of current live capacity.',{exact:true})).toBeVisible();await expect(page.getByText('Authenticated sessions',{exact:true}).locator('..').locator('strong')).toHaveText('50');expect(requests).toBe(1);expect(await page.evaluate(()=>(window as any).__referenceCache)).toBe('no-store');
  await page.setViewportSize({width:390,height:844});await expect(load(page)).toBeVisible();await expect(page.getByLabel('Import connection report',{exact:true})).toBeAttached();expect(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth+1)).toBe(true);
  await page.getByLabel('Import connection report',{exact:true}).setInputFiles({name:'my-report.json',mimeType:'application/json',buffer:Buffer.from(JSON.stringify(reference))});await expect(page.getByText(/Imported local report ·/)).toBeVisible();await expect(link).toHaveCount(0);await expect(page.getByText('Reference run · measured in CI',{exact:true})).toHaveCount(0);await page.getByRole('button',{name:'Clear report',exact:true}).click();await expect(page.getByText('No connection run imported yet.',{exact:true})).toBeVisible();
});

test('reference failures are explicit and retry validates schema, size, and exact CI provenance',async({page})=>{
  let status=404,body='{}';await page.route('**'+referencePath,route=>route.fulfill({status,contentType:'application/json',body}));await setup(page);await load(page).click();await expect(alert(page)).toHaveText('Reference run is not available yet');await expect(load(page)).toBeEnabled();
  status=200;body=JSON.stringify({...reference,kind:'other'});await load(page).click();await expect(alert(page)).toHaveText('This file does not match the supported connection-test report format.');
  for(const metadata of [{sourceCommit:'short',ciUrl},{sourceCommit,ciUrl:ciUrl+'?redirect=elsewhere'},{sourceCommit,ciUrl:'https://github.com/another/repo/actions/runs/123'},{sourceCommit,ciUrl:'javascript:alert(1)'}]){body=JSON.stringify({...reference,reference:metadata});await load(page).click();await expect(alert(page)).toHaveText('The reference run is missing valid source and CI details.');await expect(page.getByRole('link',{name:'View CI run',exact:true})).toHaveCount(0);}
  body=JSON.stringify({...reference,padding:'x'.repeat(1024*1024)});await load(page).click();await expect(alert(page)).toHaveText('The reference report exceeds the 1 MB limit.');body=JSON.stringify(reference);await load(page).click();await expect(page.getByText(/Published reference run ·/)).toBeVisible();await expect(alert(page)).toHaveCount(0);
});

test('a late reference response cannot overwrite a newer uploaded report',async({page})=>{
  let release!:()=>void;const hold=new Promise<void>(resolve=>{release=resolve;});await page.route('**'+referencePath,async route=>{await hold;await route.fulfill({contentType:'application/json',body:JSON.stringify(reference)});});await setup(page);await load(page).click();await expect(page.getByRole('button',{name:'Loading reference…',exact:true})).toBeDisabled();
  try{await page.getByLabel('Import connection report',{exact:true}).setInputFiles({name:'newer-report.json',mimeType:'application/json',buffer:Buffer.from(JSON.stringify({...report,summary:{...report.summary,clients:25}}))});await expect(page.getByText(/Imported local report ·/)).toBeVisible();await expect(load(page)).toBeEnabled();}finally{release();}
  await page.waitForTimeout(100);await expect(page.getByText('Authenticated sessions',{exact:true}).locator('..').locator('strong')).toHaveText('25');await expect(page.getByText(/Published reference run ·/)).toHaveCount(0);await expect(alert(page)).toHaveCount(0);
});
