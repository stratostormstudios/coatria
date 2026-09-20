/** CI preparation only. The production worker never downloads an executable.
 * Publisher is linked from https://ffmpeg.org/download.html (FFmpeg itself ships
 * source only). This month-end build has two-year retention; no floating latest.
 * Linux execution/sandbox qualification is distinct from checksum verification.
 */
import {createHash} from 'node:crypto';
import {spawnSync} from 'node:child_process';
import {appendFile,chmod,lstat,mkdtemp,open} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join,resolve} from 'node:path';
import {fileURLToPath,pathToFileURL} from 'node:url';

export const MEDIA_INSPECTOR_CI_BUILD=Object.freeze({
 version:'n8.1.2-50-g1a748fe2cd',
 package:'ffmpeg-n8.1.2-50-g1a748fe2cd-linux64-lgpl-8.1',
 url:'https://github.com/BtbN/FFmpeg-Builds/releases/download/autobuild-2026-08-31-13-27/ffmpeg-n8.1.2-50-g1a748fe2cd-linux64-lgpl-8.1.tar.xz',
 sha256:'7d6d93e9c39e0e461feb13c118e91e4eec2515e4da3a01d4ad6790996731bbee',
 bytes:112545684,
 checksumsUrl:'https://github.com/BtbN/FFmpeg-Builds/releases/download/autobuild-2026-08-31-13-27/checksums.sha256',
});
const minimalEnv={LANG:'C',LC_ALL:'C'};
function execute(binary,args,stdin='ignore'){
 const result=spawnSync(binary,args,{shell:false,stdio:[stdin,'pipe','pipe'],env:minimalEnv,encoding:'utf8',timeout:30000,maxBuffer:1024*1024});
 if(result.error||result.status!==0)throw new Error('Pinned media decoder CI preparation failed.');
 return result.stdout+result.stderr;
}

export async function prepareMediaInspectorCI(){
 if(process.platform!=='linux'||process.arch!=='x64'||process.env.CI!=='true')throw new Error('This preparation step is only for an explicit Linux x64 CI job.');
 const directory=await mkdtemp(join(tmpdir(),'coatria-media-ci-')),archive=join(directory,'verified.tar.xz');
 const response=await fetch(MEDIA_INSPECTOR_CI_BUILD.url,{signal:AbortSignal.timeout(120000)});
 if(!response.ok||!response.body||!['github.com','release-assets.githubusercontent.com'].includes(new URL(response.url).hostname))throw new Error('Pinned media decoder download unavailable.');
 const file=await open(archive,'wx',0o600),hash=createHash('sha256');let bytes=0;
 try{for await(const chunk of response.body){bytes+=chunk.length;if(bytes>MEDIA_INSPECTOR_CI_BUILD.bytes)throw new Error('Pinned media decoder size mismatch.');hash.update(chunk);await file.write(chunk);}}finally{await file.close();}
 if(bytes!==MEDIA_INSPECTOR_CI_BUILD.bytes||hash.digest('hex')!==MEDIA_INSPECTOR_CI_BUILD.sha256)throw new Error('Pinned media decoder checksum mismatch.');
 // Extract only two exact trusted members after verification into a fresh dir.
 execute('/usr/bin/tar',['-xJf',archive,'-C',directory,'--no-same-owner','--no-same-permissions','--strip-components=2',MEDIA_INSPECTOR_CI_BUILD.package+'/bin/ffmpeg',MEDIA_INSPECTOR_CI_BUILD.package+'/bin/ffprobe']);
 const paths={ffmpegPath:join(directory,'ffmpeg'),ffprobePath:join(directory,'ffprobe')};
 for(const binary of Object.values(paths)){
  const info=await lstat(binary);if(!info.isFile()||info.isSymbolicLink()||info.nlink!==1)throw new Error('Invalid pinned decoder member.');await chmod(binary,0o500);
  if(!execute(binary,['-version']).includes(MEDIA_INSPECTOR_CI_BUILD.version)||!execute(binary,['-hide_banner','-h','protocol=fd']).includes('fd AVOptions:'))throw new Error('Pinned decoder version or fd capability mismatch.');
 }
 // Require actual seekable fd input, not merely help-text capability claims.
 const fixture=await open(fileURLToPath(new URL('../../tests/fixtures/media/synthetic.png',import.meta.url)),'r');
 try{
  const probe=JSON.parse(execute(paths.ffprobePath,['-v','error','-protocol_whitelist','fd','-f','png_pipe','-fd','0','-show_entries','stream=codec_name,width,height','-of','json','fd:'],fixture.fd));
  if(probe.streams?.length!==1||probe.streams[0].codec_name!=='png'||probe.streams[0].width!==16||probe.streams[0].height!==16)throw new Error('Pinned decoder fd smoke check failed.');
 }finally{await fixture.close();}
 // A later CI step runs all seven real formats and the corruption/limit tests.
 // This bundle requires glibc; it is NOT a proven isolated production runtime.
 if(process.env.GITHUB_ENV){
  const values=[['COATRIA_TEST_FFMPEG_PATH',paths.ffmpegPath],['COATRIA_TEST_FFPROBE_PATH',paths.ffprobePath]];
  if(values.some(([,value])=>/[\r\n]/.test(value)))throw new Error('Invalid CI environment path.');
  await appendFile(process.env.GITHUB_ENV,values.map(([key,value])=>key+'='+value+'\n').join(''));
 }
 console.log(JSON.stringify({prepared:true,version:MEDIA_INSPECTOR_CI_BUILD.version,sha256:MEDIA_INSPECTOR_CI_BUILD.sha256,fdSmokeCheck:true,productionSandboxQualified:false,...paths}));
 return paths;
}

if(process.argv[1]&&import.meta.url===pathToFileURL(resolve(process.argv[1])).href){
 try{await prepareMediaInspectorCI();}catch(error){console.error(error instanceof Error?error.message:'Pinned decoder preparation failed.');process.exitCode=1;}
}
