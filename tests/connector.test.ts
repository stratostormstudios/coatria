import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, symlink, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, relative, isAbsolute } from 'node:path';
import { connectorOrigin, scanMetadata } from '../scripts/connector.mjs';

test('connector accepts only a secure origin or explicit local HTTP',()=>{
  assert.equal(connectorOrigin('https://coatria.com').origin,'https://coatria.com');
  assert.equal(connectorOrigin('http://127.0.0.1:4180').origin,'http://127.0.0.1:4180');
  for(const value of ['http://coatria.com','ftp://localhost','file:///tmp','https://user:secret@coatria.com','https://coatria.com/path','https://coatria.com/?token=secret','https://coatria.com/#secret'])assert.throws(()=>connectorOrigin(value));
});

test('connector indexes bounded metadata, excludes hidden paths and follows no junctions',async()=>{
  const temporary=await mkdtemp(join(tmpdir(),'coatria-connector-test-'));
  try{
    const root=join(temporary,'approved'),outside=join(temporary,'outside');
    await mkdir(root);await mkdir(outside);await mkdir(join(root,'media'));await mkdir(join(root,'node_modules'));await mkdir(join(root,'.private'));
    await writeFile(join(root,'media','clip.mov'),'test fixture');await writeFile(join(root,'.env'),'private');await writeFile(join(root,'.private','notes.txt'),'private');await writeFile(join(root,'node_modules','package.json'),'{}');await writeFile(join(outside,'secret.mov'),'outside');
    await symlink(outside,join(root,'outside-link'),process.platform==='win32'?'junction':'dir');
    const files=await scanMetadata(root);
    assert.equal(files.length,1);assert.deepEqual(Object.keys(files[0]).sort(),['modifiedAt','path','size']);assert.equal(files[0].path,'media/clip.mov');assert.equal(files[0].size,12);assert.equal(isAbsolute(files[0].path),false);
    assert.equal((await scanMetadata(root,{maxFiles:1})).length,1,'Exactly at the file limit must succeed despite ignored entries.');
    await writeFile(join(root,'second.txt'),'second');await assert.rejects(scanMetadata(root,{maxFiles:1}),/file index limit/);
    await assert.rejects(scanMetadata(root,{maxDepth:0}),/depth limit/);
    await assert.rejects(scanMetadata(root,{shouldStop:()=>true}),/stopped/);
  }finally{
    // Remove only the exact test directory created under the operating-system temp root.
    const rel=relative(tmpdir(),temporary);assert.ok(rel&&!rel.startsWith('..')&&!isAbsolute(rel));
    await rm(temporary,{recursive:true,force:true});
  }
});
