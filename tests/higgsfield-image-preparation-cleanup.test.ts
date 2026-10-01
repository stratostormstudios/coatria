import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import {syncBuiltinESMExports} from 'node:module';
import {createHash} from 'node:crypto';
import {tmpdir} from 'node:os';
import {basename,dirname,join,resolve} from 'node:path';
import {crc32,deflateSync} from 'node:zlib';
import {prepareReferenceImage} from '../src/lib/higgsfield-image-preparation';
import {ImagePreparationError} from '../src/lib/higgsfield-image-preparation-policy';

const digest=(bytes:Buffer)=>createHash('sha256').update(bytes).digest('hex');
function tinyPng(){
 const chunk=(name:string,data:Buffer)=>{const bytes=Buffer.alloc(data.length+12);bytes.writeUInt32BE(data.length);bytes.write(name,4,'latin1');data.copy(bytes,8);bytes.writeUInt32BE(crc32(bytes.subarray(4,-4)),bytes.length-4);return bytes;};
 const header=Buffer.alloc(13);header.writeUInt32BE(1);header.writeUInt32BE(1,4);header[8]=8;header[9]=6;
 return Buffer.concat([Buffer.from([137,80,78,71,13,10,26,10]),chunk('IHDR',header),chunk('IDAT',deflateSync(Buffer.from([0,12,34,56,128]))),chunk('IEND',Buffer.alloc(0))]);
}

// File-local mocks are sequential and wrap real handles/removal. They do not
// replace decoding or cause any production cleanup exception to be ignored.
test('a real transform cannot succeed when file close or scratch removal is unconfirmed',{timeout:60000},async t=>{
 const fallback=process.platform==='win32'?join(process.env.LOCALAPPDATA??'','Microsoft','WinGet','Links','ffmpeg.exe'):'/usr/bin/ffmpeg';
 const ffmpegPath=await fs.realpath(process.env.COATRIA_TEST_FFMPEG_PATH??fallback);
 const options={nativeTestMode:true as const,ffmpegPath,ffmpegSha256:digest(await fs.readFile(ffmpegPath))};
 for(const failure of ['snapshot-close','scratch-removal'] as const)await t.test(failure,async sub=>{
  const directory=await fs.mkdtemp(join(tmpdir(),'coatria-cleanup-review-')),path=join(directory,'PRIVATE_SOURCE.png'),original=tinyPng();
  await fs.writeFile(path,original,{mode:0o600});
  const open=fs.open,remove=fs.rm;let scratch:string|undefined;const closed:string[]=[];let removalAttempted=false;
  try{
   sub.mock.method(fs,'open',async(filePath:Parameters<typeof fs.open>[0],flags:Parameters<typeof fs.open>[1],mode?:Parameters<typeof fs.open>[2])=>{
    const file=await open(filePath,flags,mode),name=String(filePath);
    const snapshot=basename(name)==='input'&&basename(dirname(name)).startsWith('coatria-image-preparation-')&&flags!=='wx';
    if(snapshot)scratch=dirname(name);
    if(name===path||snapshot){const close=file.close.bind(file);file.close=async()=>{closed.push(snapshot?'snapshot':'original');await close();if(snapshot&&failure==='snapshot-close')throw Error('PRIVATE_CLEANUP_PATH '+name);};}
    return file;
   });
   sub.mock.method(fs,'rm',async(target:Parameters<typeof fs.rm>[0],settings?:Parameters<typeof fs.rm>[1])=>{
    if(scratch&&String(target)===scratch){removalAttempted=true;await remove(target,settings);if(failure==='scratch-removal')throw Error('PRIVATE_CLEANUP_PATH '+String(target));return;}
    return remove(target,settings);
   });
   syncBuiltinESMExports();
   await assert.rejects(prepareReferenceImage({path,expectedBytes:original.length,expectedSha256:digest(original)},options),(error:unknown)=>{
    assert.ok(error instanceof ImagePreparationError);assert.equal(error.code,'PREPARATION_CLEANUP_FAILED');assert.doesNotMatch(error.message,/PRIVATE_|[A-Z]:\\|\/tmp\//i);return true;
   });
   assert.ok(scratch,'The actual transform acquired a private input snapshot');
   assert.deepEqual(closed.sort(),['original','snapshot'],'Both real handles must close despite the injected rejection');
   assert.equal(removalAttempted,true,'A close rejection must not bypass scratch removal');
   await assert.rejects(fs.stat(scratch),{code:'ENOENT'});
   assert.deepEqual(await fs.readFile(path),original,'Cleanup never removes or rewrites the selected original');
  }finally{
   sub.mock.restoreAll();syncBuiltinESMExports();
   assert.ok(resolve(directory).startsWith(resolve(tmpdir())));await remove(directory,{recursive:true,force:true});
  }
 });
});
