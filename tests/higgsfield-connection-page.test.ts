import test from 'node:test';
import assert from 'node:assert/strict';
import {endedHiggsfieldConnectionPage} from '../src/lib/higgsfield-connection-page';
test('expired OAuth recovery is static, private and sends the user back to connection status',async()=>{
 const response=endedHiggsfieldConnectionPage(),html=await response.text();assert.equal(response.status,409);assert.equal(response.headers.get('Referrer-Policy'),'no-referrer');assert.match(response.headers.get('Cache-Control')!,/no-store/);assert.match(response.headers.get('Content-Security-Policy')!,/default-src 'none'/);assert.match(html,/https:\/\/coatria.com\/#plugins/);assert.match(html,/may already be connected/);assert(!/<script|<iframe|<form|code=|state=/i.test(html));
});
