import {defineConfig} from '@playwright/test';
export default defineConfig({
  testDir:'./tests/browser',
  timeout:60000,
  expect:{timeout:15000},
  fullyParallel:false,
  workers:1,
  reporter:'list',
  use:{
    baseURL:process.env.COATRIA_TEST_URL||'http://127.0.0.1:4180',
    viewport:{width:1536,height:1000},
    screenshot:'only-on-failure',
    trace:'retain-on-failure',
    launchOptions:process.env.COATRIA_BROWSER_PATH?{executablePath:process.env.COATRIA_BROWSER_PATH}:undefined
  }
});
