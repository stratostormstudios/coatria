import {defineConfig} from '@playwright/test';
export default defineConfig({
  testDir:'./tests/browser',
  timeout:60000,
  expect:{timeout:15000},
  fullyParallel:false,
  workers:1,
  reporter:'list',
  webServer:process.env.COATRIA_BROWSER_START==='1'?{
    command:'node node_modules/next/dist/bin/next start --hostname 127.0.0.1 --port 4180',
    url:'http://127.0.0.1:4180',
    reuseExistingServer:false,
    timeout:60000,
  }:undefined,
  use:{
    baseURL:process.env.COATRIA_TEST_URL||'http://127.0.0.1:4180',
    viewport:{width:1536,height:1000},
    screenshot:'only-on-failure',
    trace:'retain-on-failure',
    launchOptions:process.env.COATRIA_BROWSER_PATH?{executablePath:process.env.COATRIA_BROWSER_PATH}:undefined
  }
});
