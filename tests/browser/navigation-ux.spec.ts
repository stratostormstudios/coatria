import {test,expect,type Page} from '@playwright/test';

const user={id:'10000000-0000-4000-8000-000000000099',name:'Navigation Reviewer',email:'navigation@example.invalid',roleTitle:'Designer',avatarColor:'#c9d6b5',avatarId:null};
const company={id:'20000000-0000-4000-8000-000000000099',name:'Navigation Studio',slug:'navigation-studio',template:'blank',role:'member'};
async function fixture(page:Page,hasCompany=true){
 await page.route('**/api/**',route=>{const path=new URL(route.request().url()).pathname;const data=path==='/api/session'?{user,companies:hasCompany?[company]:[],configured:true}:path.endsWith('/workspace')?{company,members:[{...user,userId:user.id,role:'member'}],rooms:[],agents:[],tasks:[],messages:[],presence:[],activity:[],drives:[],openings:[],applications:[],layout:[]}:path==='/api/vault'?{skills:[]}:{};return route.fulfill({status:200,contentType:'application/json',body:JSON.stringify(data)});});
}
test.beforeEach(({baseURL})=>{test.skip(!baseURL||!['localhost','127.0.0.1'].includes(new URL(baseURL).hostname),'Intercepted fixtures run only on local development.');});

test('quick navigation is named, keyboard operated, role aware, and recoverable',async({page})=>{
 await fixture(page);await page.goto('/#people');
 await page.getByRole('button',{name:'Search navigation',exact:true}).click();
 const modal=page.getByRole('dialog',{name:'Find your way',exact:true});await expect(modal).toBeVisible();
 const search=modal.getByRole('combobox',{name:'Search navigation'});await expect(search).toBeFocused();
 await search.fill('furniture');await expect(modal.getByRole('option')).toHaveCount(0);
 await expect(modal.getByRole('status')).toContainText('No pages match');
 await modal.getByRole('button',{name:'Clear search',exact:true}).click();await expect(search).toBeFocused();
 await search.fill('private');await expect(modal.getByRole('option')).toHaveCount(1);await search.press('Enter');
 await expect(page).toHaveURL(/#vault$/);await expect(modal).toHaveCount(0);
 await expect(page.locator('.breadcrumbs')).toContainText('Your Coatria');
 await expect(page.getByRole('button',{name:'My skill vault',exact:true})).toHaveAttribute('aria-current','page');
 await page.locator('.skip-link').focus();await page.keyboard.press('Enter');await expect(page).toHaveURL(/#vault$/);await expect(page.locator('#main')).toBeFocused();
 await page.goBack();await expect(page).toHaveURL(/#people$/);await expect(page.getByRole('button',{name:'People',exact:true})).toHaveAttribute('aria-current','page');
 await page.getByRole('button',{name:'Search navigation',exact:true}).click();await search.press('Escape');
 await expect(modal).toHaveCount(0);await expect(page.getByRole('button',{name:'Search navigation',exact:true})).toBeFocused();
});

test('mobile navigation closes with Escape, contains focus, and recovers on desktop resize',async({page})=>{
 await fixture(page);await page.setViewportSize({width:390,height:844});await page.goto('/#people');
 const open=page.getByRole('button',{name:'Open navigation',exact:true});await open.click();
 const drawer=page.locator('#workspace-navigation');await expect(drawer).toBeVisible();
 await expect(page.locator('.main-shell')).toHaveAttribute('inert','');
 await page.keyboard.press('Shift+Tab');await expect(drawer.getByRole('button',{name:'Opportunities',exact:true})).toBeFocused();
 await page.keyboard.press('Tab');await expect(drawer.locator('.company-switch')).toBeFocused();
 await page.keyboard.press('Escape');await expect(drawer).toBeHidden();await expect(open).toBeFocused();
 await open.click();await page.setViewportSize({width:1280,height:900});await expect(page.locator('.main-shell')).not.toHaveAttribute('inert','');
 await page.setViewportSize({width:390,height:844});expect(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth+1)).toBe(true);
});

test('workplace setup suggests a stable address, preserves edits between steps, and focuses save failures',async({page})=>{
 await fixture(page,false);await page.route('**/api/companies',route=>route.fulfill({status:409,contentType:'application/json',body:JSON.stringify({error:'That workplace address is already in use.'})}));await page.goto('/#create');
 const name=page.getByLabel('Company name',{exact:true}),address=page.getByLabel('Workspace address',{exact:true});
 await name.fill('Atelier Design Studio');await expect(address).toHaveValue('atelier-design-studio');
 await address.fill('atelier-west');await name.fill('Atelier West Studio');await expect(address).toHaveValue('atelier-west');
 await page.getByRole('button',{name:'Choose your space',exact:true}).click();
 await page.getByRole('button',{name:/A blank canvas/}).click();
 await page.getByRole('button',{name:'Back',exact:true}).click();await expect(name).toHaveValue('Atelier West Studio');await expect(address).toHaveValue('atelier-west');
 await page.getByRole('button',{name:'Choose your space',exact:true}).click();await expect(page.getByRole('button',{name:/A blank canvas/})).toHaveAttribute('aria-pressed','true');
 await page.getByRole('button',{name:'Create your workplace',exact:true}).click();await expect(page.locator('#main').getByRole('alert')).toBeFocused();await expect(page.locator('#main').getByRole('alert')).toContainText('already in use');
});

test('password visibility is explicit and never resets a typed password',async({page})=>{
 await page.route('**/api/session',route=>route.fulfill({status:200,contentType:'application/json',body:JSON.stringify({user:null,companies:[],configured:true})}));await page.goto('/');
 const password=page.getByLabel('Password',{exact:true});await password.fill('A memorable local test passphrase');
 await expect(password).toHaveAttribute('type','password');await page.getByRole('button',{name:'Show password',exact:true}).click();
 await expect(password).toHaveAttribute('type','text');await expect(password).toHaveValue('A memorable local test passphrase');
 await page.getByRole('button',{name:'Hide password',exact:true}).click();await expect(password).toHaveAttribute('type','password');
 await expect(password).toHaveAttribute('aria-describedby',/.+-hint$/);
});

test('a shared-cookie account change closes the old drawer and restores usable content',async({page})=>{
 let current=user;
 await fixture(page,false);
 await page.route('**/api/session',route=>route.fulfill({status:200,contentType:'application/json',body:JSON.stringify({user:current,companies:[],configured:true})}));
 await page.setViewportSize({width:390,height:844});await page.goto('/#create');
 await page.getByRole('button',{name:'Open navigation',exact:true}).click();await expect(page.locator('.main-shell')).toHaveAttribute('inert','');
 current={...user,id:'10000000-0000-4000-8000-000000000098',name:'Second Reviewer'};
 await page.evaluate(()=>window.dispatchEvent(new Event('focus')));
 await expect(page.locator('.main-shell')).not.toHaveAttribute('inert','');await expect(page.locator('#workspace-navigation')).toBeHidden();
 await page.getByRole('button',{name:'Open navigation',exact:true}).click();await expect(page.locator('#workspace-navigation .company-switch')).toBeFocused();
 await page.keyboard.press('Escape');await expect(page.getByRole('button',{name:'Open navigation',exact:true})).toBeFocused();
});
