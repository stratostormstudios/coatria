import test from 'node:test';
import assert from 'node:assert/strict';
import {generateKeyPairSync,randomUUID,sign} from 'node:crypto';
import {verifyArchiveExecutorToken} from '../src/lib/company-runtime-executor';
import {trustedServiceHash,type TrustedServicePreset} from '../src/lib/company-runtime-preset';
import {VERCEL_MEDIA_IMAGE} from '../src/lib/higgsfield-vercel-media-sandbox';

const now=Date.now(),pair=generateKeyPairSync('rsa',{modulusLength:2048}),jwk={...pair.publicKey.export({format:'jwk'}),kid:'synthetic',use:'sig',alg:'RS256'};
const scope={companyId:randomUUID(),projectIds:[randomUUID()],sourceCommit:'a'.repeat(40),expiresAt:new Date(now+600000).toISOString()};
const configuration={version:1,policy:{...scope,pilotId:randomUUID(),maxLaunches:6,binding:{teamId:'team_synthetic',projectId:'prj_synthetic',region:'iad1',image:VERCEL_MEDIA_IMAGE,closureSha256:'b'.repeat(64),limits:{maxInputBytes:128*1024**2,maxClosureBytes:256*1024**2,timeoutMs:120000,maxOutputBytes:1024**2,maxStderrBytes:65536}}},closure:{root:'/opt/coatria/closure',files:[{path:'bin/ffmpeg',bytes:4096,sha256:'b'.repeat(64)},{path:'bin/ffprobe',bytes:4096,sha256:'c'.repeat(64)}]},qualification:{receiptPath:'/opt/coatria/qualification.json',sha256:'d'.repeat(64)},scratchRoot:'/var/lib/coatria-scratch',outputHosts:['media.example.invalid'],operationDeadlineMs:600000,inspection:{timeoutMs:300000,sandboxTimeoutMs:90000}};
const preset={id:'synthetic-archive',service:'archive',companyId:scope.companyId,projectIds:scope.projectIds,releaseCommit:scope.sourceCommit,expiresAt:scope.expiresAt,configuration,configurationHash:trustedServiceHash(configuration)} as TrustedServicePreset;
const claims={iss:'https://oidc.vercel.com/synthetic',aud:'https://vercel.com/synthetic',sub:'owner:synthetic:project:coatria:environment:development',owner:'synthetic',owner_id:'team_synthetic',project:'coatria',project_id:'prj_synthetic',environment:'development',iat:Math.floor(now/1000)-1,exp:Math.floor(now/1000)+3600};
function token(patch:Record<string,unknown>={},headerPatch:Record<string,unknown>={}){const body=[{typ:'JWT',alg:'RS256',kid:'synthetic',...headerPatch},{...claims,...patch}].map(value=>Buffer.from(JSON.stringify(value)).toString('base64url')).join('.');return body+'.'+sign('RSA-SHA256',Buffer.from(body),pair.privateKey).toString('base64url');}
const transport:typeof fetch=async(url,init)=>{assert.equal(String(url),'https://oidc.vercel.com/synthetic/.well-known/jwks');assert.equal(init?.redirect,'error');assert(init?.signal);assert(!('Authorization'in(init?.headers as any)));return Response.json({keys:[jwk]});};
const rejected={code:'EXECUTOR_CREDENTIAL_INVALID'};
test('archive executor verifies RSA signature, fixed issuer and exact team/project before accepting token',async()=>{
 assert.deepEqual(await verifyArchiveExecutorToken(token(),preset,{fetch:transport,now}),{expiresAt:new Date(claims.exp*1000).toISOString()});
 const good=token(),pieces=good.split('.');pieces[2]=Buffer.alloc(256,1).toString('base64url');await assert.rejects(verifyArchiveExecutorToken(pieces.join('.'),preset,{fetch:transport,now}),rejected);
 for(const patch of [{owner_id:'team_other'},{project_id:'prj_other'},{aud:'other'},{aud:[claims.aud]},{sub:'other'},{iss:'https://evil.example/synthetic'},{owner:'../../evil'},{environment:'other'},{exp:Math.floor(now/1000)+620},{exp:Math.floor(now/1000)+90000},{iat:Math.floor(now/1000)+100},{nbf:Math.floor(now/1000)+100},{exp:'9999999999'}]){
  let calls=0;await assert.rejects(verifyArchiveExecutorToken(token(patch),preset,{fetch:async()=>{calls++;throw Error('No key request expected');},now}),rejected);assert.equal(calls,0);
 }
 for(const patch of [{alg:'none'},{alg:'HS256'},{crit:['custom']},{typ:'other'}])await assert.rejects(verifyArchiveExecutorToken(token({},patch),preset,{fetch:transport,now}),rejected);
});
test('archive executor bounds untrusted key responses and fails closed on wrong/duplicate keys and network errors',async()=>{
 for(const value of [{keys:[]},{keys:[jwk,jwk]},{keys:[{...jwk,kid:'other'}]},{keys:[{...jwk,use:'enc'}]},{keys:[{...jwk,key_ops:['sign']}]},{keys:[{...jwk,kty:'oct'}]}])await assert.rejects(verifyArchiveExecutorToken(token(),preset,{fetch:async()=>Response.json(value),now}),rejected);
 for(const fetcher of [async()=>new Response('x'.repeat(65537)),async()=>new Response('[]',{status:503}),async()=>{throw Error('credential-private-message-must-not-leak');}]){await assert.rejects(verifyArchiveExecutorToken(token(),preset,{fetch:fetcher,now}),error=>{assert.equal((error as any).code,'EXECUTOR_CREDENTIAL_INVALID');assert(!String(error).includes('private-message'));return true;});}
});
test('documented Vercel global issuer works without permitting a supplied JWKS location',async()=>{
 assert((await verifyArchiveExecutorToken(token({iss:'https://oidc.vercel.com'},{jku:'https://evil.example/keys'}),preset,{now,fetch:async(url)=>{assert.equal(String(url),'https://oidc.vercel.com/.well-known/jwks');return Response.json({keys:[jwk]});}})).expiresAt);
});
