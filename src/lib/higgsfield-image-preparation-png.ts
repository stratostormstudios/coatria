import {crc32, inflateSync} from 'node:zlib';
import {IMAGE_PREPARATION_POLICY as policy, preparationFail} from './higgsfield-image-preparation-policy';

const signature = Buffer.from([137,80,78,71,13,10,26,10]);
type Size = {width: number; height: number};

/** Validate the entire fixed RGBA8 output, including the compressed stream.
 * The only optional normalization removes the encoder's physical pixel density;
 * all other ancillary chunks fail. Callers cannot certify metadata removal. */
export function validatePreparedPng(input: Buffer, size: Size, removeEncoderDensity = false): Buffer {
  const fail = () => preparationFail('PREPARATION_OUTPUT_INVALID');
  if (!Buffer.isBuffer(input) || input.length < 57 || input.length > policy.outputMaxBytes ||
      !input.subarray(0,8).equals(signature) || !Number.isSafeInteger(size.width) || !Number.isSafeInteger(size.height) ||
      size.width < 1 || size.height < 1 || Math.max(size.width,size.height) > policy.outputMaxDimension) fail();
  const retained: Buffer[] = [signature], compressed: Buffer[] = [];
  let offset = 8, count = 0, header = false, ended = false, density = false, idat = false;
  while (offset < input.length) {
    if (++count > policy.maxContainerChunks || input.length - offset < 12 || ended) fail();
    const length = input.readUInt32BE(offset), end = offset + length + 12;
    if (end > input.length) fail();
    const type = input.toString('latin1',offset + 4,offset + 8);
    if (crc32(input.subarray(offset + 4,end - 4)) !== input.readUInt32BE(end - 4)) fail();
    const data = input.subarray(offset + 8,end - 4);
    if (!header) {
      if (type !== 'IHDR' || length !== 13 || data.readUInt32BE(0) !== size.width || data.readUInt32BE(4) !== size.height ||
          data[8] !== 8 || data[9] !== 6 || data[10] !== 0 || data[11] !== 0 || data[12] !== 0) fail();
      header = true;
    } else if (type === 'IDAT') {
      if (!length) fail();
      idat = true; compressed.push(data);
    } else if (type === 'IEND') {
      if (length || !idat || end !== input.length) fail();
      ended = true;
    } else if (type === 'pHYs' && removeEncoderDensity) {
      if (density || idat || length !== 9 || data[8] > 1) fail();
      density = true; offset = end; continue;
    } else fail();
    retained.push(input.subarray(offset,end)); offset = end;
  }
  if (!ended) fail();
  // info.bytesWritten is the number of compressed bytes consumed by zlib. An
  // otherwise valid stream followed by a second stream or hidden tail fails.
  const packed = Buffer.concat(compressed), stride = size.width * 4 + 1, expected = stride * size.height;
  try {
    const result = inflateSync(packed,{maxOutputLength: expected,info:true}) as unknown as {buffer:Buffer;engine:{bytesWritten:number}};
    if (result.buffer.length !== expected || result.engine.bytesWritten !== packed.length) fail();
    // All byte values are valid RGBA samples; complete rows with legal PNG
    // filters are sufficient to establish a complete lossless pixel decode.
    for (let row = 0; row < size.height; row++) if (result.buffer[row * stride] > 4) fail();
  } catch { fail(); }
  const output = density ? Buffer.concat(retained) : Buffer.from(input);
  if (density) return validatePreparedPng(output,size);
  return output;
}
