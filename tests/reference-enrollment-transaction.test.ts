import test from 'node:test';
import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import {parseReferenceEnrollmentRequest,referenceEnrollmentHash} from '../scripts/hosting/reference-enrollment-contract.mjs';
import {enrollReferenceService,reconcileReferenceService} from '../scripts/hosting/reference-enrollment-transaction.mjs';

const now=Date.now();
function request():Record<string,any>{return {
 version:1,requestId:randomUUID(),serviceId:randomUUID(),companyId:randomUUID(),enrolledBy:randomUUID(),tokenHash:'a'.repeat(64),origin:'https://coatria.com',releaseSha256:'b'.repeat(64),qualificationSha256:'c'.repeat(64),profileSha256:'d'.repeat(64),expiresAt:new Date(now+600000).toISOString(),uploadHosts:['upload.example.invalid'],
 provider:{connectionId:randomUUID(),connectionRevision:1,catalogSha256:'e'.repeat(64)},projects:[{projectId:randomUUID(),projectRevision:1,storageBindingId:randomUUID(),storageBindingRevision:1,storageConnectionId:randomUUID(),storageConnectionRevision:1}],
 qualification:{sourceCommit:'a'.repeat(40),sourceTree:'b'.repeat(40),bundleSha256:'c'.repeat(64),hostConfigurationSha256:'d'.repeat(64),configurationSha256:'e'.repeat(64),qualifierSha256:'f'.repeat(64),conformanceProfileSha256:'a'.repeat(64),bootId:randomUUID(),uid:1234,gid:1234,qualifierInvocationId:'a'.repeat(32),evidenceSha256:'b'.repeat(64),reportSha256:'c'.repeat(64),acceptedAt:new Date(now-1000).toISOString()}
};}
test('enrollment input accepts finite exact hash-only authority, without copying token or credentials',()=>{
 const value=request(),parsed=parseReferenceEnrollmentRequest(value,{now});assert.deepEqual(parsed,value);assert.notEqual(parsed,value);
 for(const bad of [{...value,token:'rfs_'+'x'.repeat(43)},{...value,password:'SYNTHETIC_MUST_NOT_REFLECT'},{...value,provider:{...value.provider,accessToken:'SYNTHETIC_MUST_NOT_REFLECT'}},{...value,qualification:{...value.qualification,qualified:true}}])assert.throws(()=>parseReferenceEnrollmentRequest(bad,{now}),error=>{assert(!String(error).includes('SYNTHETIC_MUST_NOT_REFLECT'));return true;});
});
test('enrollment deadline is finite while expired reconciliation preserves the exact original identity',()=>{
 const value=request();for(const expiresAt of [new Date(now).toISOString(),new Date(now-1).toISOString(),new Date(now+3600001).toISOString(),'invalid'])assert.throws(()=>parseReferenceEnrollmentRequest({...value,expiresAt},{now}));
 const expired={...value,expiresAt:new Date(now-1).toISOString()};assert.equal(parseReferenceEnrollmentRequest(expired,{allowExpired:true,now}).expiresAt,expired.expiresAt);
 assert.throws(()=>parseReferenceEnrollmentRequest({...value,qualification:{...value.qualification,acceptedAt:new Date(now+1).toISOString()}},{now}));
});
test('enrollment scope rejects duplicate projects, unconstrained hosts, invalid epochs and unpinned sources',()=>{
 const value=request();for(const change of [{projects:[]},{projects:[value.projects[0],value.projects[0]]},{projects:Array.from({length:129},()=>({...value.projects[0],projectId:randomUUID()}))},{uploadHosts:[]},{uploadHosts:['*.example.invalid']},{uploadHosts:['https://upload.example.invalid']},{uploadHosts:Array.from({length:9},(_,n)=>'upload'+n+'.example.invalid')},{provider:{...value.provider,connectionRevision:0}},{projects:[{...value.projects[0],projectRevision:0}]},{tokenHash:'not-a-hash'},{qualification:{...value.qualification,sourceCommit:'branch-name'}}])assert.throws(()=>parseReferenceEnrollmentRequest({...value,...change},{now}));
});
test('request hash is stable under object key order and binds every external authority identity',()=>{
 const value=parseReferenceEnrollmentRequest(request(),{now}),digest=referenceEnrollmentHash(value);assert.match(digest,/^[a-f0-9]{64}$/);
 assert.equal(referenceEnrollmentHash(Object.fromEntries(Object.entries(value).reverse())),digest);
 for(const change of [{requestId:randomUUID()},{serviceId:randomUUID()},{companyId:randomUUID()},{enrolledBy:randomUUID()},{tokenHash:'f'.repeat(64)},{origin:'https://other.example.invalid'},{expiresAt:new Date(now+300000).toISOString()},{qualificationSha256:'f'.repeat(64)},{uploadHosts:['other.example.invalid']},{provider:{...value.provider,connectionRevision:2}},{projects:[{...value.projects[0],storageBindingRevision:2}]},{qualification:{...value.qualification,bootId:randomUUID()}}])assert.notEqual(referenceEnrollmentHash({...value,...change}),digest);
});
test('malformed enrollment and reconciliation fail before any SQL or credential access',async()=>{
 let queries=0;const db={query:async()=>{queries++;throw Error('UNEXPECTED_DATABASE_ACCESS');}};
 await assert.rejects(()=>enrollReferenceService(db,{...request(),tokenHash:'raw-token'}),error=>!String(error).includes('UNEXPECTED_DATABASE_ACCESS'));
 await assert.rejects(()=>reconcileReferenceService(db,{...request(),companyId:'wrong'}),error=>!String(error).includes('UNEXPECTED_DATABASE_ACCESS'));assert.equal(queries,0);
});
