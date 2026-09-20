import test from 'node:test';
import assert from 'node:assert/strict';
import {assertReviewedProfile,hasBwrapDeclaration,relevantLoadedProfiles} from './prepare-media-apparmor-ci.mjs';
import {classifyMediaAppArmorDenials} from './collect-media-apparmor-ci.mjs';
import {mediaClosureFileMode} from './prepare-media-sandbox-ci.mjs';
test('only exact decoders and the kernel ELF interpreter receive executable permission',()=>{
 for(const path of ['/bin/ffprobe','/bin/ffmpeg','/lib64/ld-linux-x86-64.so.2'])assert.equal(mediaClosureFileMode(path),0o555,path);
 for(const path of ['/lib/x86_64-linux-gnu/ld-linux-x86-64.so.2','/lib/x86_64-linux-gnu/libc.so.6','/lib/x86_64-linux-gnu/libm.so.6','/bin/unexpected'])assert.equal(mediaClosureFileMode(path),0o444,path);
});
test('only exact reviewed profile bytes are eligible for scoped activation',()=>{
 for(const value of ['profile bwrap /usr/bin/bwrap flags=(unconfined) {userns,}','profile unpriv_bwrap {allow capability,}',''])assert.throws(()=>assertReviewedProfile(Buffer.from(value)),/POLICY_REJECTED/);
});
test('loaded policy evidence restricts names and retains enforcement state',()=>{
 assert.deepEqual(relevantLoadedProfiles('private-customer-profile (enforce)\nbwrap (enforce)\nunpriv_bwrap (complain)\nbwrap//&unpriv_bwrap (enforce)\n'),[{profile:'bwrap',mode:'enforce'},{profile:'unpriv_bwrap',mode:'complain'},{profile:'bwrap_child_stack',mode:'enforce'}]);
});
test('conflict detection includes quoted names, named attachments, and nested target profiles',()=>{
 for(const value of ['profile "bwrap" {','profile "unpriv_bwrap" flags=(unconfined) {','profile custom "/usr/bin/bwrap" {','"/usr/bin/bwrap" {','profile bwrap//child {'])assert.equal(hasBwrapDeclaration(value),true,value);
 assert.equal(hasBwrapDeclaration('# profile "bwrap" {\nprofile unrelated /usr/bin/other {'),false);
});
test('kernel denial evidence discards arbitrary messages, paths and unrelated processes',()=>{
 const line=MESSAGE=>JSON.stringify({MESSAGE});const result=classifyMediaAppArmorDenials([
  line('apparmor="DENIED" operation="capable" comm="bwrap" profile="unprivileged_userns" capname="net_admin" name="/private/secret"'),
  line('apparmor="DENIED" operation="open" comm="unrelated" profile="private-customer" name="/private/secret"'),
  line('apparmor="DENIED" operation="secret-operation" comm="ffprobe" profile="bwrap//&unpriv_bwrap" capname="secret-capability"'),
 ].join('\n'));
 assert.deepEqual(result,[{comm:'bwrap',operation:'capable',capability:'net_admin',profile:'default_restricted_userns'},{comm:'ffprobe',operation:'other',capability:null,profile:'capability_denied_child'}]);assert.doesNotMatch(JSON.stringify(result),/private|secret|unrelated/);
});
