/** Pure preparation policy. This does not authorize storage, sharing, or execution. */
import {createHash} from 'node:crypto';

export const IMAGE_PREPARATION_POLICY = Object.freeze({
  version: 1,
  sourceMaxBytes: 32 * 1024 ** 2,
  sourceMaxDimension: 8192,
  sourceMaxPixels: 32_000_000,
  outputMaxBytes: 10 * 1024 ** 2,
  outputMaxDimension: 2048,
  timeoutMs: 30_000,
  maxAllocationBytes: 256 * 1024 ** 2,
  maxStderrBytes: 64 * 1024,
  maxContainerChunks: 4096,
  outputFormat: 'png',
  outputPixels: 'rgba8',
  resize: 'lanczos; rounded aspect ratio; no enlargement',
  orientation: 'EXIF 1-8 baked before resize; no automatic decoder rotation',
  color: 'untagged or standard sRGB only; no ICC conversion; reject other color profiles',
  jpegRange: 'full input and output range; standard JPEG YCbCr/RGB interpretation',
  alpha: 'preserve straight alpha',
  metadata: 'IHDR + contiguous IDAT + IEND only; remove only encoder pHYs',
} as const);

export type ImagePreparationCode = 'PREPARATION_UNAVAILABLE' | 'PREPARATION_INPUT_INVALID' |
  'PREPARATION_BYTES_CHANGED' | 'PREPARATION_UNSUPPORTED' | 'PREPARATION_LIMIT_EXCEEDED' |
  'PREPARATION_DECODE_FAILED' | 'PREPARATION_OUTPUT_INVALID' | 'PREPARATION_ABORTED' | 'PREPARATION_TIMEOUT' | 'PREPARATION_CLEANUP_FAILED';
const messages: Record<ImagePreparationCode, string> = {
  PREPARATION_UNAVAILABLE: 'A qualified image preparation executor is unavailable.',
  PREPARATION_INPUT_INVALID: 'Select one exact supported image from a private regular file.',
  PREPARATION_BYTES_CHANGED: 'The source image no longer matches the selected bytes.',
  PREPARATION_UNSUPPORTED: 'This image structure, color profile, or orientation is unsupported.',
  PREPARATION_LIMIT_EXCEEDED: 'The image exceeds the preparation limits.',
  PREPARATION_DECODE_FAILED: 'The complete image could not be decoded and transformed.',
  PREPARATION_OUTPUT_INVALID: 'The prepared image did not pass complete output validation.',
  PREPARATION_ABORTED: 'Image preparation was stopped.',
  PREPARATION_TIMEOUT: 'Image preparation exceeded its time limit.',
  PREPARATION_CLEANUP_FAILED: 'Image preparation cleanup could not be confirmed.',
};
export class ImagePreparationError extends Error {
  constructor(readonly code: ImagePreparationCode) { super(messages[code]); this.name = 'ImagePreparationError'; }
}
export function preparationFail(code: ImagePreparationCode): never { throw new ImagePreparationError(code); }
export type PreparationSource = {format: 'png' | 'jpeg' | 'webp'; width: number; height: number; orientation: 1|2|3|4|5|6|7|8};
export function preparationDimensions(width: number, height: number) {
  if (!Number.isSafeInteger(width) || !Number.isSafeInteger(height) || width < 1 || height < 1 ||
      width > IMAGE_PREPARATION_POLICY.sourceMaxDimension || height > IMAGE_PREPARATION_POLICY.sourceMaxDimension ||
      width * height > IMAGE_PREPARATION_POLICY.sourceMaxPixels) preparationFail('PREPARATION_LIMIT_EXCEEDED');
  const ratio = Math.min(1, IMAGE_PREPARATION_POLICY.outputMaxDimension / Math.max(width, height));
  return {width: Math.max(1, Math.round(width * ratio)), height: Math.max(1, Math.round(height * ratio))};
}
export function preparationDigest(bytes: Buffer | string) { return createHash('sha256').update(bytes).digest('hex'); }
