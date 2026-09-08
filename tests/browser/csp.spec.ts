import {test,expect} from '@playwright/test';

test('production CSP rotates nonces and blocks untrusted inline scripts and handlers',async({page,request,baseURL})=>{
  test.skip(process.env.COATRIA_CSP_PRODUCTION!=='1','Run against a production build with COATRIA_CSP_PRODUCTION=1.');
  const target=new URL('/?security-csp=1',baseURL!).href;
  await page.route(target,async route=>{
    const response=await route.fetch(),html=await response.text();
    const injected='<script id="untrusted-csp-script">window.coatriaInjectedScript=true</script><button onclick="window.coatriaInjectedHandler=true">CSP verification control</button>';
    await route.fulfill({response,body:html.replace('</body>',injected+'</body>')});
  });
  const response=await page.goto(target);
  const policy=response?.headers()['content-security-policy']||'';
  expect(policy).toContain("'strict-dynamic'");expect(policy).not.toContain("'unsafe-eval'");
  const nonce=policy.match(/'nonce-([^']+)'/)?.[1];expect(nonce).toBeTruthy();
  expect(policy).toContain("frame-ancestors 'none'");expect(policy).toContain("base-uri 'none'");
  await expect(page.getByRole('button',{name:'Create your account',exact:true})).toBeVisible();
  const second=await request.get(baseURL!);
  const secondNonce=second.headers()['content-security-policy']?.match(/'nonce-([^']+)'/)?.[1];
  expect(secondNonce).toBeTruthy();expect(secondNonce).not.toBe(nonce);
  // Parser-inserted HTML models an injection. Scripts deliberately created by
  // trusted JavaScript are allowed under strict-dynamic and are not this threat.
  expect(await page.locator('#untrusted-csp-script').count()).toBe(1);
  await page.getByRole('button',{name:'CSP verification control',exact:true}).click();
  expect(await page.evaluate(()=>Boolean((window as unknown as {coatriaInjectedScript?:boolean}).coatriaInjectedScript))).toBe(false);
  expect(await page.evaluate(()=>Boolean((window as unknown as {coatriaInjectedHandler?:boolean}).coatriaInjectedHandler))).toBe(false);
});
