import test from 'node:test';
import assert from 'node:assert/strict';
import {scryptSync} from 'node:crypto';
import {dummyPasswordHash,passwordHash,passwordMatches,passwordNeedsUpgrade} from '../src/lib/security';

test('existing account hashes remain usable while new hashes use the stronger versioned profile',async()=>{
  const password='Existing account keeps its password';
  const salt='0123456789abcdef0123456789abcdef';
  const legacy=`scrypt$${salt}$${scryptSync(password,salt,64,{N:16384,r:8,p:1}).toString('hex')}`;
  assert(await passwordMatches(password,legacy));assert(passwordNeedsUpgrade(legacy));
  assert.equal(await passwordMatches('incorrect',legacy),false);
  const upgraded=await passwordHash(password);
  assert.match(upgraded,/^scrypt\$v2\$32768\$8\$3\$/);
  assert(await passwordMatches(password,upgraded));assert.equal(passwordNeedsUpgrade(upgraded),false);
  assert.equal(await passwordMatches('incorrect',upgraded),false);
  assert.equal(await passwordMatches(password,upgraded.replace('$32768$','$1073741824$')),false);
  assert.equal(await passwordMatches(password,dummyPasswordHash),false);
});
