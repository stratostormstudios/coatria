import {lstat} from 'node:fs/promises';
import path from 'node:path';
import {z} from 'zod';
import {executionManifestInput,type ExecutionManifest} from '../../src/lib/studio-execution-protocol';
import {RenderError,sha256File,verifyRenderDirectory,type RenderResult} from './renderer.mjs';

/** Shared projection used by completion and private-media publication. */
export async function executionManifestFromResult(outputRoot:string,result:RenderResult):Promise<ExecutionManifest> {
  z.string().uuid().parse(result.jobId);
  const base=path.resolve(outputRoot,result.jobId),manifestPath=path.resolve(base,result.manifestPath);
  if(!/^attempts\/\d{4}\/manifest\.json$/.test(result.manifestPath)||await sha256File(manifestPath)!==result.manifestSha256)throw new RenderError('OUTPUT_HASH_MISMATCH','The sealed renderer result changed.');
  const manifest=await verifyRenderDirectory(path.dirname(manifestPath)),prefix=result.jobId+'/'+result.manifestPath.slice(0,-'manifest.json'.length);
  const files:ExecutionManifest['files']=manifest.files.map(file=>({path:prefix+file.path,kind:file.kind==='frame'?'image' as const:file.kind==='scene'?'scene' as const:'media' as const,bytes:file.sizeBytes,sha256:file.sha256,...file.frame===undefined?{}:{frame:file.frame}}));
  const report=path.join(path.dirname(manifestPath),'manifest.json');
  files.push({path:prefix+'manifest.json',kind:'report',bytes:(await lstat(report)).size,sha256:await sha256File(report)});
  return executionManifestInput.parse({schemaVersion:1,files,spec:{width:manifest.job.width,height:manifest.job.height,fpsNumerator:manifest.job.fpsNumerator,fpsDenominator:manifest.job.fpsDenominator,format:'exr',colorSpace:manifest.job.colorSpace},engineVersion:`Blender ${manifest.evidence.blenderVersion} (${manifest.evidence.blenderBuildHash})`,verification:{fileHashes:true,fileSizes:true,frameCoverage:true,imageMetadata:true}});
}
