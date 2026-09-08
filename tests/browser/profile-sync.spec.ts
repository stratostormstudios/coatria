import { test, expect, type Page } from '@playwright/test';

test('untouched and previously saved avatar fields follow another tab without overwriting its choice', async ({ page, context, baseURL }) => {
  test.skip(!baseURL || !['localhost', '127.0.0.1'].includes(new URL(baseURL).hostname), 'Local fixtures only.');
  const suffix = `${Date.now().toString(36)}-profile-sync`;
  const signup = await context.request.post('/api/auth/signup', {
    headers: { Origin: baseURL! },
    data: { name: 'Profile sync QA', email: `${suffix}@example.invalid`, password: `Profile sync passphrase ${suffix}` }
  });
  expect(signup.status()).toBe(201);
  const catalogResponse = await context.request.get('/api/avatars');
  expect(catalogResponse.status()).toBe(200);
  const { avatars } = await catalogResponse.json();
  expect(avatars.length).toBeGreaterThanOrEqual(2);
  const [first, second] = avatars;
  // This regression exercises profile state, including the supported missing
  // preview fallback; it does not require or distribute the licensed bundle.
  await context.route('**/api/avatars/*/preview', route => route.fulfill({ status: 503, contentType: 'application/json', body: '{"error":"Preview unavailable in this fixture."}' }));
  const otherTab = await context.newPage();
  const openProfile = async (tab: Page) => {
    await tab.goto('/#profile');
    await expect(tab.getByRole('radio', { name: 'Automatic character', exact: true })).toBeVisible();
  };
  const select = async (tab: Page, name: string) => {
    await tab.locator('label.avatar-choice').filter({ has: tab.getByRole('radio', { name, exact: true }) }).click();
  };
  const save = async (tab: Page) => {
    const response = tab.waitForResponse(response => response.url().endsWith('/api/profile') && response.request().method() === 'PATCH');
    await tab.getByRole('button', { name: 'Save personal profile', exact: true }).click();
    const result = await response; expect(result.status()).toBe(200);
    await expect(tab.getByRole('button', { name: 'Save personal profile', exact: true })).toBeEnabled();
    return result.request().postDataJSON();
  };
  const reconcile = async (tab: Page, expectedName: string) => {
    await tab.bringToFront();
    const response = tab.waitForResponse(response => response.url().endsWith('/api/session'));
    await tab.evaluate(() => window.dispatchEvent(new Event('focus')));
    expect((await response).status()).toBe(200);
    await expect(tab.getByRole('radio', { name: expectedName, exact: true })).toBeChecked();
  };
  try {
    await openProfile(page); await openProfile(otherTab);
    await select(otherTab, first.name); expect((await save(otherTab)).avatarId).toBe(first.id);
    await reconcile(page, first.name);
    await page.getByLabel('Full name', { exact: true }).fill('Profile name updated');
    expect(await save(page)).not.toHaveProperty('avatarId');
    expect((await (await context.request.get('/api/session')).json()).user.avatarId).toBe(first.id);

    // Saving an explicit choice clears its dirty flag, allowing a later remote
    // change to become the displayed value instead of resubmitting the old one.
    await select(page, second.name); expect((await save(page)).avatarId).toBe(second.id);
    await reconcile(otherTab, second.name);
    await select(otherTab, first.name); await save(otherTab);
    await reconcile(page, first.name);
    await page.getByLabel('Full name', { exact: true }).fill('Profile sync complete');
    expect(await save(page)).not.toHaveProperty('avatarId');
    expect((await (await context.request.get('/api/session')).json()).user.avatarId).toBe(first.id);
  } finally { await otherTab.close(); }
});
