import test from 'node:test';
import assert from 'node:assert/strict';
import { assertOrigin, body, hashToken, passwordHash, passwordMatches, secret } from '../src/lib/security';
import { layoutInput, signupInput, submissionUrl } from '../src/lib/model';
import { canApproveTask } from '../src/lib/work';

test('password hashing uses random salts and verifies without storing plaintext',async()=>{
 const first=await passwordHash('a strong test password'),second=await passwordHash('a strong test password');
 assert.notEqual(first,second);assert(!first.includes('a strong'));assert(await passwordMatches('a strong test password',first));assert.equal(await passwordMatches('wrong',first),false);assert.equal(await passwordMatches('wrong','corrupt'),false);
});
test('session and integration credentials are high entropy and stored as one-way digests',()=>{
 const a=secret('ca_'),b=secret('ca_');assert.notEqual(a,b);assert.equal(a.length,46);assert.match(hashToken(a),/^[a-f0-9]{64}$/);assert.notEqual(hashToken(a),a);
});
test('cookie-authenticated writes reject missing or cross-site origins',()=>{
 assert.throws(()=>assertOrigin(new Request('https://coatria.example/api/profile',{method:'PATCH'})));
 assert.throws(()=>assertOrigin(new Request('https://coatria.example/api/profile',{method:'PATCH',headers:{Origin:'https://evil.example'}})));
 assert.throws(()=>assertOrigin(new Request('https://coatria.example/api/profile',{method:'PATCH',headers:{Origin:'https://coatria.example','Sec-Fetch-Site':'cross-site'}})));
 assert.doesNotThrow(()=>assertOrigin(new Request('https://coatria.example/api/profile',{method:'PATCH',headers:{Origin:'https://coatria.example'}})));
});
test('validation rejects weak passwords, unsafe URLs and furniture outside floor',()=>{
 assert.equal(signupInput.safeParse({name:'One',email:'one@example.test',password:'short'}).success,false);
 assert.equal(submissionUrl.safeParse('javascript:alert(1)').success,false);
 assert.equal(submissionUrl.safeParse('https://secret:password@example.test').success,false);
 assert.equal(layoutInput.safeParse({layout:[{id:'a',type:'desk',x:99,y:1,w:10,h:10,label:'Desk'}],floor:{width:20,depth:16},revision:0}).success,false);
});
test('only an independent administrator may accept a reviewed contribution',()=>{
 const task={status:'review',created_by:'creator',assignee_id:'worker',submitted_by:'submitter',agent_sponsor:'sponsor'};
 for(const user of ['worker','submitter','sponsor'])assert.equal(canApproveTask(task,user,'admin'),false);
 assert.equal(canApproveTask(task,'creator','admin'),true);
 assert.equal(canApproveTask(task,'reviewer','member'),false);assert.equal(canApproveTask(task,'reviewer','admin'),true);assert.equal(canApproveTask({...task,status:'doing'},'reviewer','owner'),false);
});
test('streamed bodies enforce byte caps even without a content-length header',async()=>{
 const request=new Request('https://coatria.example/api/auth/signup',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({name:'A'.repeat(500),email:'a@example.test',password:'a long password'})});
 await assert.rejects(()=>body(request,signupInput,100),/too large/);
});
