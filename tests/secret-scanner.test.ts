import test from 'node:test';
import assert from 'node:assert/strict';
import {execFileSync,spawnSync} from 'node:child_process';
import {mkdtemp,writeFile,mkdir,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join,resolve,relative,isAbsolute} from 'node:path';
import {detectSecrets,forbiddenPath,scanRepository} from '../scripts/check-secrets.mjs';

test('secret detection covers provider tokens, scoped tokens and database URLs without returning values',()=>{
  const values=['vcp'+'_'+ 'a'.repeat(40),'sk'+'-proj-'+ 'b'.repeat(40),'ca'+'_'+ 'c'.repeat(43),'napi'+'_'+ 'd'.repeat(32),'postgresql'+'://owner:private-password@db.example.com/company'];
  for(const value of values){const found=detectSecrets(value);assert.ok(found.length>0);assert.ok(!JSON.stringify(found).includes(value));}
  assert.equal(detectSecrets('postgresql://USER:PASSWORD@HOST/coatria').length,0);
  assert.equal(detectSecrets('postgresql://coatria_test:local_ci_test_only@127.0.0.1:5432/coatria_test').length,0);
  assert.ok(forbiddenPath('nested/.env.production'));assert.ok(forbiddenPath('nested/.vercel/project.json'));assert.ok(!forbiddenPath('.env.example'));
});

test('scanner catches staged-only values, binary-looking files, nested environments and deleted history',async()=>{
  const temporary=await mkdtemp(join(tmpdir(),'coatria-secret-scan-'));
  const git=(args:string[])=>execFileSync('git',args,{cwd:temporary,encoding:'utf8',stdio:['ignore','pipe','pipe']});
  const commit=()=>git(['-c','user.name=Coatria scanner test','-c','user.email=coatria-test@example.invalid','commit','-m','Synthetic scanner fixture']);
  const value='msy'+'_'+ 'z'.repeat(40);
  try{
    git(['init']);await writeFile(join(temporary,'notes.txt'),value);git(['add','notes.txt']);await writeFile(join(temporary,'notes.txt'),'No credential in the working file.');
    const staged=await scanRepository({cwd:temporary});assert.ok(staged.failures.some((finding:{source:string})=>finding.source==='index:notes.txt'));
    commit();git(['add','notes.txt']);commit();
    assert.equal((await scanRepository({cwd:temporary})).failures.length,0);
    const history=await scanRepository({cwd:temporary,history:true});assert.ok(history.failures.some((finding:{source:string})=>finding.source.startsWith('history:')));
    await writeFile(join(temporary,'asset.png'),Buffer.from('\0'+value));await mkdir(join(temporary,'nested'));await writeFile(join(temporary,'nested','.env.production'),'unrelated setting');
    const current=await scanRepository({cwd:temporary});assert.ok(current.failures.some((finding:{source:string})=>finding.source==='worktree:asset.png'));assert.ok(current.failures.some((finding:{source:string})=>finding.source==='worktree:nested/.env.production'));
    const output=spawnSync(process.execPath,[resolve('scripts/check-secrets.mjs'),'--history'],{cwd:temporary,encoding:'utf8'});assert.equal(output.status,1);assert.ok(!`${output.stdout}${output.stderr}`.includes(value));
  }finally{
    const target=relative(tmpdir(),temporary);assert.ok(target&&!target.startsWith('..')&&!isAbsolute(target));await rm(temporary,{recursive:true,force:true});
  }
});
