/** M1 native fixture adapter only. Production execution is deliberately absent.
 * No storage/provider access, worker authority or qualification is implied. */
import {createHash} from 'node:crypto';
import {spawn} from 'node:child_process';
import {constants} from 'node:fs';
import {lstat,open,realpath,mkdtemp,rm,type FileHandle} from 'node:fs/promises';
import {isAbsolute,resolve,join} from 'node:path';
import {tmpdir} from 'node:os';
import {inspectPreparationSource} from './higgsfield-image-preparation-source';
import {validatePreparedPng} from './higgsfield-image-preparation-png';
import {IMAGE_PREPARATION_POLICY as policy,ImagePreparationError,preparationFail as fail,
  preparationDigest,preparationDimensions,type PreparationSource,type ImagePreparationCode} from './higgsfield-image-preparation-policy';

export {ImagePreparationError} from './higgsfield-image-preparation-policy';
export type ImagePreparationInput = {path:string;expectedBytes:number;expectedSha256:string;signal?:AbortSignal};
export type ImagePreparationOptions = {nativeTestMode?:true;ffmpegPath?:string;ffmpegSha256?:string;timeoutMs?:number};
export type PreparedReferenceImage = {bytes:Buffer;source:PreparationSource;recipeHash:string;output:{
  width:number;height:number;sha256:string;bytes:number;format:'png';pixelFormat:'rgba8';metadataRemoved:true;
}};
const orientationFilters = Object.freeze({1:'null',2:'hflip',3:'hflip,vflip',4:'vflip',5:'transpose=0',6:'transpose=1',7:'transpose=3',8:'transpose=2'});
// Keep every execution-affecting flag in the versioned recipe identity. Source
// demuxer, orientation and output size are derived only from validated bytes.
const inputFlags = ['-nostdin','-hide_banner','-v','warning','-max_alloc',String(policy.maxAllocationBytes),
  '-threads','1','-max_pixels',String(policy.sourceMaxPixels),'-protocol_whitelist','fd,pipe',
  '-probesize','5242880','-analyzeduration','5000000','-err_detect','explode','-xerror','-noautorotate'] as const;
const outputFlags = ['-map','0:v:0','-an','-sn','-dn','-map_metadata','-1','-map_chapters','-1',
  '-threads','1','-filter_threads','1','-filter_complex_threads','1','-c:v','png','-pix_fmt','rgba',
  '-compression_level','9','-pred','mixed','-flags','+bitexact','-fflags','+bitexact','-f','image2pipe','pipe:1'] as const;
const filterRecipe = Object.freeze({sideData:'sidedata=mode=delete',scaleFlags:'lanczos',jpegRange:':in_range=full:out_range=full',pixels:'format=rgba',aspect:'setsar=1',
  // Color declarations were already checked against the supported sRGB source
  // profile. Clear only their frame tags after pixel conversion, preventing the
  // encoder from adding ancillary color chunks to the fixed untagged output.
  colorTags:'setparams=range=full:color_primaries=unknown:color_trc=unknown:colorspace=unknown'});
const diagnosticPatterns = Object.freeze({
  jpeg:/^\[swscaler @ (?:0x)?[a-fA-F0-9]+\] deprecated pixel format used, make sure you did set range correctly\r?\n$/,
  webp:/^(?:\[webp @ (?:0x)?[a-fA-F0-9]+\] skipping unsupported chunk: XMP \r?\n){1,2}$/,
});
export const IMAGE_PREPARATION_RECIPE_HASH = preparationDigest(JSON.stringify({policy,inputFlags,outputFlags,orientationFilters,
  filterRecipe,diagnostics:{jpeg:diagnosticPatterns.jpeg.source,webp:diagnosticPatterns.webp.source},validation:'png-rgba8-exact-zlib-v1'}));

export function isAllowedPreparationDiagnostic(format:PreparationSource['format'],bytes:Buffer):boolean {
  if (!bytes.length) return true;
  if (bytes.length > policy.maxStderrBytes || format !== 'jpeg' && format !== 'webp') return false;
  return diagnosticPatterns[format].test(bytes.toString('utf8'));
}

/** The sole binary-transform command. Neither native fixtures nor a qualified
 * sandbox accept filters, paths, protocols, tools or flags from a request. */
export function fixedImagePreparationCommand(source:PreparationSource) {
  if (!source || Object.keys(source).sort().join(',') !== 'format,height,orientation,width' ||
      !['png','jpeg','webp'].includes(source.format) || !Number.isInteger(source.orientation) ||
      source.orientation < 1 || source.orientation > 8) fail('PREPARATION_INPUT_INVALID');
  const rotated = source.orientation >= 5;
  const size = preparationDimensions(rotated ? source.height : source.width,rotated ? source.width : source.height);
  const demuxer = source.format === 'jpeg' ? 'jpeg_pipe' : source.format + '_pipe';
  const decoder = source.format === 'jpeg' ? 'mjpeg' : source.format;
  const filter = `${filterRecipe.sideData},${orientationFilters[source.orientation]},scale=${size.width}:${size.height}:flags=${filterRecipe.scaleFlags}${source.format === 'jpeg' ? filterRecipe.jpegRange : ''},${filterRecipe.pixels},${filterRecipe.aspect},${filterRecipe.colorTags}`;
  return Object.freeze({size:Object.freeze(size),args:Object.freeze([...inputFlags,'-format_whitelist',demuxer,'-codec_whitelist',decoder,
    '-f',demuxer,'-fd','0','-i','fd:','-vf',filter,...outputFlags])});
}

const pathKey = (value:string) => process.platform === 'win32' ? value.toLowerCase() : value;
async function trustedFile(path:string) {
  if (typeof path !== 'string' || !isAbsolute(path) || path.includes('\0') || /^[\\/]{2}/.test(path) ||
      process.platform === 'win32' && path.slice(2).includes(':')) fail('PREPARATION_INPUT_INVALID');
  if (pathKey(await realpath(path)) !== pathKey(resolve(path))) fail('PREPARATION_INPUT_INVALID');
  const before = await lstat(path);
  if (!before.isFile() || before.isSymbolicLink() || before.nlink !== 1) fail('PREPARATION_INPUT_INVALID');
  const file = await open(path,constants.O_RDONLY | (constants.O_NOFOLLOW || 0)), info = await file.stat();
  if (!info.isFile() || info.dev !== before.dev || info.ino !== before.ino) { await file.close(); fail('PREPARATION_INPUT_INVALID'); }
  return file;
}
function stopped(signal:AbortSignal) {
  if (signal.aborted) throw signal.reason instanceof ImagePreparationError ? signal.reason : new ImagePreparationError('PREPARATION_ABORTED');
}
async function exactBytes(file:FileHandle,input:ImagePreparationInput,signal:AbortSignal) {
  stopped(signal); const before = await file.stat();
  if (before.size !== input.expectedBytes) fail('PREPARATION_BYTES_CHANGED');
  const bytes = Buffer.alloc(input.expectedBytes);
  for (let offset = 0; offset < bytes.length;) {
    stopped(signal); const read = await file.read(bytes,offset,Math.min(1024**2,bytes.length-offset),offset);
    if (!read.bytesRead) fail('PREPARATION_BYTES_CHANGED'); offset += read.bytesRead;
  }
  const after = await file.stat();
  if (after.size !== before.size || after.mtimeMs !== before.mtimeMs || preparationDigest(bytes) !== input.expectedSha256) fail('PREPARATION_BYTES_CHANGED');
  return bytes;
}
async function pinnedExecutable(path:string|undefined,sha:string|undefined,signal:AbortSignal) {
  if (!path || !isAbsolute(path) || !sha || !/^[a-f0-9]{64}$/.test(sha)) fail('PREPARATION_UNAVAILABLE');
  let file:FileHandle|undefined;
  try {
    file = await trustedFile(path); const info = await file.stat();
    if (info.size < 1 || info.size > 512 * 1024**2) fail('PREPARATION_UNAVAILABLE');
    const hash = createHash('sha256'), block = Buffer.alloc(1024**2); let position = 0;
    while (position < info.size) {
      stopped(signal); const read = await file.read(block,0,Math.min(block.length,info.size-position),position);
      if (!read.bytesRead) fail('PREPARATION_UNAVAILABLE'); hash.update(block.subarray(0,read.bytesRead));position += read.bytesRead;
    }
    const after = await file.stat();
    if (after.size !== info.size || after.mtimeMs !== info.mtimeMs || hash.digest('hex') !== sha) fail('PREPARATION_UNAVAILABLE');
    return path;
  } catch (error) { if (signal.aborted) stopped(signal); if (error instanceof ImagePreparationError && error.code === 'PREPARATION_TIMEOUT') throw error; fail('PREPARATION_UNAVAILABLE'); }
  finally { await file?.close(); }
}

/** Binary stdout stays outside logs. The native test process gets no inherited
 * credentials and no arbitrary command/filter/URL. This is not OS isolation. */
async function nativeBinaryTransform(binary:string,args:string[],file:FileHandle,cwd:string,signal:AbortSignal,format:PreparationSource['format']):Promise<Buffer> {
  stopped(signal);
  return new Promise((done,reject) => {
    const child = spawn(binary,args,{shell:false,windowsHide:true,cwd,stdio:[file.fd,'pipe','pipe'],
      env:{NODE_ENV:'production',LANG:'C',LC_ALL:'C',...(process.platform === 'win32' ? {SystemRoot:process.env.SystemRoot,WINDIR:process.env.WINDIR} : {})}});
    const chunks:Buffer[] = [], diagnostics:Buffer[] = []; let bytes = 0, stderr = 0, reason:ImagePreparationCode|undefined;
    const kill = (code:ImagePreparationCode) => { reason ??= code; child.kill('SIGKILL'); };
    const abort = () => kill(signal.reason instanceof ImagePreparationError ? signal.reason.code : 'PREPARATION_ABORTED');
    signal.addEventListener('abort',abort,{once:true}); if (signal.aborted) abort();
    child.stdout!.on('data',(chunk:Buffer) => { bytes += chunk.length; if (bytes > policy.outputMaxBytes) kill('PREPARATION_LIMIT_EXCEEDED'); else if (!reason) chunks.push(chunk); });
    child.stderr!.on('data',(chunk:Buffer) => { stderr += chunk.length; if (stderr > policy.maxStderrBytes) kill('PREPARATION_LIMIT_EXCEEDED'); else diagnostics.push(chunk); });
    child.on('error',() => { reason ??= 'PREPARATION_UNAVAILABLE'; });
    child.on('close',code => {
      signal.removeEventListener('abort',abort);
      if (reason) return reject(new ImagePreparationError(reason));
      // FFmpeg's JPEG decoder uses the legacy yuvj pixel-format name even with
      // explicit full-range conversion. Permit only its single exact warning;
      // never silence decoder damage warnings by lowering the log level.
      // The bounded WebP parser accepts an XMP metadata chunk. FFmpeg reports
      // ignoring it during probing and decoding; neither notice indicates a
      // damaged image. An extra line or any other chunk warning still fails.
      if (code !== 0 || !isAllowedPreparationDiagnostic(format,Buffer.concat(diagnostics)) || !bytes) return reject(new ImagePreparationError('PREPARATION_DECODE_FAILED'));
      done(Buffer.concat(chunks));
    });
  });
}

export async function prepareReferenceImage(input:ImagePreparationInput,options:ImagePreparationOptions = {}):Promise<PreparedReferenceImage> {
  // A test adapter cannot accidentally become a production fallback, including
  // when a caller supplies perfectly valid pinned binaries and image bytes.
  if (options.nativeTestMode !== true || process.env.NODE_ENV === 'production') fail('PREPARATION_UNAVAILABLE');
  const timeoutMs = options.timeoutMs ?? policy.timeoutMs;
  if (!Number.isSafeInteger(timeoutMs) || timeoutMs < 1 || timeoutMs > policy.timeoutMs ||
      !Number.isSafeInteger(input.expectedBytes) || input.expectedBytes < 1 ||
      !/^[a-f0-9]{64}$/.test(input.expectedSha256)) fail('PREPARATION_INPUT_INVALID');
  if (input.expectedBytes > policy.sourceMaxBytes) fail('PREPARATION_LIMIT_EXCEEDED');
  const deadline = new AbortController(), timer = setTimeout(() => deadline.abort(new ImagePreparationError('PREPARATION_TIMEOUT')),timeoutMs);
  const signal = AbortSignal.any([deadline.signal,...input.signal ? [input.signal] : []]);
  const endsAt = performance.now() + timeoutMs;
  let original:FileHandle|undefined, snapshot:FileHandle|undefined, writer:FileHandle|undefined, directory:string|undefined;
  try {
    stopped(signal); const binary = await pinnedExecutable(options.ffmpegPath,options.ffmpegSha256,signal);
    original = await trustedFile(input.path); const identity = await original.stat();
    const sourceBytes = await exactBytes(original,input,signal), source = inspectPreparationSource(sourceBytes);
    const {size,args} = fixedImagePreparationCommand(source);
    // Feed a private snapshot, never a still-mutable caller path. Only this copy
    // reaches the process; hash/identity of the selected original is rechecked.
    directory = await mkdtemp(join(tmpdir(),'coatria-image-preparation-'));
    const snapshotPath = join(directory,'input');
    writer = await open(snapshotPath,'wx',0o600);
    await writer.writeFile(sourceBytes); await writer.close(); writer = undefined;
    snapshot = await open(snapshotPath,constants.O_RDONLY | (constants.O_NOFOLLOW || 0));
    const encoded = await nativeBinaryTransform(binary,[...args],snapshot,directory,signal,source.format);
    stopped(signal); const bytes = validatePreparedPng(encoded,size,true);
    await exactBytes(original,input,signal); const pathInfo = await lstat(input.path);
    if (pathInfo.dev !== identity.dev || pathInfo.ino !== identity.ino || pathInfo.isSymbolicLink() || pathInfo.nlink !== 1) fail('PREPARATION_BYTES_CHANGED');
    if (performance.now() >= endsAt) fail('PREPARATION_TIMEOUT'); stopped(signal);
    return {bytes,source,recipeHash:IMAGE_PREPARATION_RECIPE_HASH,output:{...size,sha256:preparationDigest(bytes),bytes:bytes.length,
      format:'png',pixelFormat:'rgba8',metadataRemoved:true}};
  } catch (error) {
    if (signal.aborted) stopped(signal);
    if (error instanceof ImagePreparationError) throw error;
    throw new ImagePreparationError('PREPARATION_INPUT_INVALID');
  } finally {
    clearTimeout(timer);
    const closes = await Promise.allSettled([writer?.close(),snapshot?.close(),original?.close()]);
    let cleanupFailed = closes.some(result => result.status === 'rejected');
    // Both close attempts precede removal; a failure must not bypass remaining
    // cleanup or leak a private path through an unsanitized finally exception.
    if (directory) try { await rm(directory,{recursive:true,force:true}); } catch { cleanupFailed = true; }
    if (cleanupFailed) fail('PREPARATION_CLEANUP_FAILED');
  }
}
