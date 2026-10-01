import test from 'node:test';
import assert from 'node:assert/strict';
import {createHash} from 'node:crypto';
import {spawnSync} from 'node:child_process';
import {access, link, mkdtemp, readFile, realpath, rm, writeFile} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join, resolve, sep} from 'node:path';
import {deflateSync, inflateSync} from 'node:zlib';
import {prepareReferenceImage} from '../src/lib/higgsfield-image-preparation';
import {ImagePreparationError, type ImagePreparationCode} from '../src/lib/higgsfield-image-preparation-policy';

const hash = (bytes: Buffer) => createHash('sha256').update(bytes).digest('hex');
const signature = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]);
const privateMarker = 'PRIVATE_SYNTHETIC_METADATA_ONLY';
type Pixel = readonly [number, number, number, number];
const colors: readonly Pixel[] = [[240, 20, 30, 255], [20, 220, 40, 192], [20, 40, 230, 128], [230, 200, 20, 64]];

// The fixture encoder and output decoder deliberately do not import production
// parsing/validation helpers: acceptance is based on independently read pixels.
function crc32(bytes: Buffer) {
  let crc = 0xffffffff;
  for (const byte of bytes) {
    crc ^= byte;
    for (let bit = 0; bit < 8; bit++) crc = (crc >>> 1) ^ ((crc & 1) ? 0xedb88320 : 0);
  }
  return (crc ^ 0xffffffff) >>> 0;
}
function chunk(type: string, data: Buffer) {
  const bytes = Buffer.alloc(data.length + 12);
  bytes.writeUInt32BE(data.length); bytes.write(type, 4, 'ascii'); data.copy(bytes, 8);
  bytes.writeUInt32BE(crc32(bytes.subarray(4, -4)), bytes.length - 4);
  return bytes;
}
function png(width: number, height: number, metadata = true, opaque = false, orientation = 1) {
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(width); ihdr.writeUInt32BE(height, 4); ihdr[8] = 8; ihdr[9] = 6;
  const rows = Buffer.alloc((width * 4 + 1) * height);
  for (let y = 0; y < height; y++) for (let x = 0; x < width; x++) {
    const color = colors[(y >= height / 2 ? 2 : 0) + (x >= width / 2 ? 1 : 0)];
    const offset = y * (width * 4 + 1) + 1 + x * 4;
    rows[offset] = color[0]; rows[offset + 1] = color[1]; rows[offset + 2] = color[2]; rows[offset + 3] = opaque ? 255 : color[3];
  }
  return Buffer.concat([signature, chunk('IHDR', ihdr), ...(metadata ? [chunk('tEXt', Buffer.from('Description\0' + privateMarker)), chunk('eXIf', exif(orientation))] : []), chunk('IDAT', deflateSync(rows)), chunk('IEND', Buffer.alloc(0))]);
}
function exif(orientation: number) {
  const description = Buffer.from(privateMarker + '\0');
  const gps = Math.ceil((50 + description.length) / 2) * 2, rationals = gps + 66;
  const bytes = Buffer.alloc(rationals + 48);
  bytes.write('II'); bytes.writeUInt16LE(42, 2); bytes.writeUInt32LE(8, 4); bytes.writeUInt16LE(3, 8);
  bytes.writeUInt16LE(0x010e, 10); bytes.writeUInt16LE(2, 12); bytes.writeUInt32LE(description.length, 14); bytes.writeUInt32LE(50, 18);
  bytes.writeUInt16LE(0x0112, 22); bytes.writeUInt16LE(3, 24); bytes.writeUInt32LE(1, 26); bytes.writeUInt16LE(orientation, 30);
  bytes.writeUInt16LE(0x8825, 34); bytes.writeUInt16LE(4, 36); bytes.writeUInt32LE(1, 38); bytes.writeUInt32LE(gps, 42);
  description.copy(bytes, 50); bytes.writeUInt16LE(5, gps);
  const entries = [[0, 1, 4, 0x00000302], [1, 2, 2, 78], [2, 5, 3, rationals], [3, 2, 2, 69], [4, 5, 3, rationals + 24]];
  for (let i = 0; i < entries.length; i++) { const entry = gps + 2 + i * 12, [tag, type, count, value] = entries[i]; bytes.writeUInt16LE(tag, entry); bytes.writeUInt16LE(type, entry + 2); bytes.writeUInt32LE(count, entry + 4); bytes.writeUInt32LE(value, entry + 8); }
  for (let i = 0; i < 6; i++) { bytes.writeUInt32LE([48, 51, 30, 2, 17, 40][i], rationals + i * 8); bytes.writeUInt32LE(1, rationals + i * 8 + 4); }
  return bytes;
}
function jpegMetadata(jpeg: Buffer, orientation: number) {
  assert.deepEqual(jpeg.subarray(0, 2), Buffer.from([0xff, 0xd8]));
  function app1(payload: Buffer) { const header = Buffer.alloc(4); header[0] = 0xff; header[1] = 0xe1; header.writeUInt16BE(payload.length + 2, 2); return Buffer.concat([header, payload]); }
  return Buffer.concat([jpeg.subarray(0, 2), app1(Buffer.concat([Buffer.from('Exif\0\0'), exif(orientation)])), app1(Buffer.from('http://ns.adobe.com/xap/1.0/\0<x:xmpmeta>' + privateMarker + '</x:xmpmeta>')), jpeg.subarray(2)]);
}
function riffChunk(type: string, data: Buffer) {
  const header = Buffer.alloc(8); header.write(type, 'ascii'); header.writeUInt32LE(data.length, 4);
  return Buffer.concat([header, data, ...(data.length % 2 ? [Buffer.alloc(1)] : [])]);
}
function webpMetadata(webp: Buffer, width: number, height: number, orientation = 1) {
  assert.equal(webp.toString('ascii', 0, 4), 'RIFF'); assert.equal(webp.toString('ascii', 8, 12), 'WEBP');
  const chunks: Buffer[] = [];
  let hasExtended = false;
  for (let offset = 12; offset < webp.length;) {
    const length = webp.readUInt32LE(offset + 4), end = offset + 8 + length + (length % 2);
    const copied = Buffer.from(webp.subarray(offset, end));
    if (copied.toString('ascii', 0, 4) === 'VP8X') { copied[8] |= 0x0c; hasExtended = true; }
    chunks.push(copied); offset = end;
  }
  if (!hasExtended) { const extended = Buffer.alloc(10); extended[0] = 0x10 | 0x08 | 0x04; extended.writeUIntLE(width - 1, 4, 3); extended.writeUIntLE(height - 1, 7, 3); chunks.unshift(riffChunk('VP8X', extended)); }
  chunks.push(riffChunk('EXIF', exif(orientation)), riffChunk('XMP ', Buffer.from('<x:xmpmeta>' + privateMarker + '</x:xmpmeta>')));
  const body = Buffer.concat([Buffer.from('WEBP'), ...chunks]), header = Buffer.alloc(8); header.write('RIFF'); header.writeUInt32LE(body.length, 4);
  return Buffer.concat([header, body]);
}
function decodeOutput(bytes: Buffer) {
  assert.deepEqual(bytes.subarray(0, 8), signature);
  const names: string[] = [], compressed: Buffer[] = [];
  let width = 0, height = 0, offset = 8, ended = false;
  while (offset < bytes.length) {
    assert.ok(offset + 12 <= bytes.length, 'Complete PNG chunk framing');
    const length = bytes.readUInt32BE(offset), end = offset + 12 + length, type = bytes.toString('ascii', offset + 4, offset + 8);
    assert.ok(end <= bytes.length); assert.ok(['IHDR', 'IDAT', 'IEND'].includes(type), 'No metadata chunk: ' + type);
    assert.equal(bytes.readUInt32BE(end - 4), crc32(bytes.subarray(offset + 4, end - 4)), 'Independent CRC');
    const data = bytes.subarray(offset + 8, end - 4);
    if (type === 'IHDR') { assert.equal(names.length, 0); assert.equal(length, 13); width = data.readUInt32BE(); height = data.readUInt32BE(4); assert.deepEqual([...data.subarray(8)], [8, 6, 0, 0, 0]); }
    if (type === 'IDAT') { assert.ok(names.length && !ended); assert.ok(names.at(-1) === 'IHDR' || names.at(-1) === 'IDAT'); compressed.push(data); }
    if (type === 'IEND') { assert.equal(length, 0); assert.equal(names.at(-1), 'IDAT'); assert.equal(end, bytes.length, 'No trailing payload'); ended = true; }
    names.push(type); offset = end;
  }
  assert.ok(ended); assert.equal(names[0], 'IHDR'); assert.equal(names.at(-1), 'IEND');
  const stride = width * 4, raw = inflateSync(Buffer.concat(compressed), {maxOutputLength: (stride + 1) * height + 1});
  assert.equal(raw.length, (stride + 1) * height, 'Exactly one complete image');
  const pixels = Buffer.alloc(stride * height);
  const paeth = (a: number, b: number, c: number) => { const p = a + b - c, pa = Math.abs(p - a), pb = Math.abs(p - b), pc = Math.abs(p - c); return pa <= pb && pa <= pc ? a : pb <= pc ? b : c; };
  for (let y = 0; y < height; y++) {
    const filter = raw[y * (stride + 1)]; assert.ok(filter <= 4);
    for (let x = 0; x < stride; x++) {
      const index = y * stride + x, left = x >= 4 ? pixels[index - 4] : 0, above = y ? pixels[index - stride] : 0, diagonal = y && x >= 4 ? pixels[index - stride - 4] : 0;
      const predictor = [0, left, above, Math.floor((left + above) / 2), paeth(left, above, diagonal)][filter];
      pixels[index] = (raw[y * (stride + 1) + 1 + x] + predictor) & 255;
    }
  }
  return {width, height, pixels, names};
}
function assertQuadrants(decoded: ReturnType<typeof decodeOutput>, order = [0, 1, 2, 3], tolerance = 0, opaque = false) {
  for (let quadrant = 0; quadrant < 4; quadrant++) {
    const x = Math.floor(decoded.width * (quadrant % 2 ? 0.75 : 0.25)), y = Math.floor(decoded.height * (quadrant >= 2 ? 0.75 : 0.25));
    const actual = decoded.pixels.subarray((y * decoded.width + x) * 4, (y * decoded.width + x) * 4 + 4), expected = colors[order[quadrant]];
    for (let channel = 0; channel < 4; channel++) assert.ok(Math.abs(actual[channel] - (channel === 3 && opaque ? 255 : expected[channel])) <= tolerance, `Quadrant ${quadrant}, channel ${channel}: ${actual[channel]} expected ${channel === 3 && opaque ? 255 : expected[channel]}`);
  }
}
function otherPng(colorType: 0 | 2 | 3 | 4) {
  const width = 24, height = 16, channels = colorType === 2 ? 3 : colorType === 4 ? 2 : 1, gray = [32, 96, 160, 224];
  const ihdr = Buffer.alloc(13); ihdr.writeUInt32BE(width); ihdr.writeUInt32BE(height, 4); ihdr[8] = 8; ihdr[9] = colorType;
  const rows = Buffer.alloc((width * channels + 1) * height), expected = Buffer.alloc(width * height * 4);
  for (let y = 0; y < height; y++) for (let x = 0; x < width; x++) {
    const quadrant = (y >= height / 2 ? 2 : 0) + (x >= width / 2 ? 1 : 0), offset = y * (width * channels + 1) + 1 + x * channels, color = colors[quadrant];
    const samples = colorType === 0 ? [gray[quadrant]] : colorType === 2 ? color.slice(0, 3) : colorType === 3 ? [quadrant] : [gray[quadrant], color[3]];
    rows.set(samples, offset);
    expected.set(colorType === 0 || colorType === 4 ? [gray[quadrant], gray[quadrant], gray[quadrant], colorType === 0 ? 255 : color[3]] : [color[0], color[1], color[2], colorType === 2 ? 255 : color[3]], (y * width + x) * 4);
  }
  const palette = colorType === 3 ? [chunk('PLTE', Buffer.from(colors.flatMap(color => color.slice(0, 3)))), chunk('tRNS', Buffer.from(colors.map(color => color[3])))] : [];
  return {bytes: Buffer.concat([signature, chunk('IHDR', ihdr), ...palette, chunk('IDAT', deflateSync(rows)), chunk('IEND', Buffer.alloc(0))]), expected, width, height};
}

// Public synthetic 96x64 quadrants, encoded once with locally bundled libvips
// 8.18.6: sharp(raw,{raw:{width:96,height:64,channels:3}}).jpeg({progressive:true,
// quality:95,chromaSubsampling:'4:4:4'}). No optional encoder is needed at test time.
const progressiveJpeg = Buffer.from('/9j/2wBDAAIBAQEBAQIBAQECAgICAgQDAgICAgUEBAMEBgUGBgYFBgYGBwkIBgcJBwYGCAsICQoKCgoKBggLDAsKDAkKCgr/2wBDAQICAgICAgUDAwUKBwYHCgoKCgoKCgoKCgoKCgoKCgoKCgoKCgoKCgoKCgoKCgoKCgoKCgoKCgoKCgoKCgoKCgr/wgARCABAAGADAREAAhEBAxEB/8QAFwABAQEBAAAAAAAAAAAAAAAAAAcJCP/EABgBAQEBAQEAAAAAAAAAAAAAAAAJBwYI/9oADAMBAAIQAxAAAAGW5/7aAAFq4+PYAAivYWEAAFq4+PYAAivYWEAAFq4+PYAAivYWEAAFq4+PYAA5XppvAAA0Ij7twAAz3sFiIAA0Ij7twAAz3sFiIAA0Ij7twAAz3sFiIAA0Ij7twAA//8QAFBABAAAAAAAAAAAAAAAAAAAAYP/aAAgBAQABBQJB/8QAFBEBAAAAAAAAAAAAAAAAAAAAYP/aAAgBAwEBPwFB/8QAFBEBAAAAAAAAAAAAAAAAAAAAYP/aAAgBAgEBPwFB/8QAFBABAAAAAAAAAAAAAAAAAAAAYP/aAAgBAQAGPwJB/8QAFBABAAAAAAAAAAAAAAAAAAAAYP/aAAgBAQABPyFB/9oADAMBAAIAAwAAABAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAD/xAAUEQEAAAAAAAAAAAAAAAAAAABg/9oACAEDAQE/EEH/xAAUEQEAAAAAAAAAAAAAAAAAAABg/9oACAECAQE/EEH/xAAUEAEAAAAAAAAAAAAAAAAAAABg/9oACAEBAAE/EEH/2Q==', 'base64');

type Options = NonNullable<Parameters<typeof prepareReferenceImage>[1]>;
let installedOptions: Promise<Options> | undefined;
function options() {
  installedOptions ??= (async () => {
    const fallback = process.platform === 'win32' ? join(process.env.LOCALAPPDATA ?? '', 'Microsoft', 'WinGet', 'Links', 'ffmpeg.exe') : '/usr/bin/ffmpeg';
    const ffmpegPath = await realpath(process.env.COATRIA_TEST_FFMPEG_PATH ?? fallback);
    return {nativeTestMode: true as const, ffmpegPath, ffmpegSha256: hash(await readFile(ffmpegPath))};
  })();
  return installedOptions;
}
async function encode(bytes: Buffer, format: 'jpeg' | 'webp') {
  const configuration = await options();
  const result = spawnSync(configuration.ffmpegPath!, ['-hide_banner', '-v', 'error', '-nostdin', '-i', 'pipe:0', '-frames:v', '1', ...(format === 'jpeg' ? ['-c:v', 'mjpeg', '-q:v', '2', '-pix_fmt', 'yuvj444p', '-f', 'image2pipe'] : ['-c:v', 'libwebp', '-lossless', '1', '-pix_fmt', 'rgba', '-f', 'webp']), 'pipe:1'], {input: bytes, shell: false, windowsHide: true, timeout: 10_000, maxBuffer: 16 * 1024 ** 2});
  assert.ifError(result.error); assert.equal(result.status, 0, String(result.stderr)); assert.equal(result.stderr.length, 0);
  return result.stdout;
}
async function scratch(run: (directory: string) => Promise<void>) {
  const directory = await mkdtemp(join(tmpdir(), 'coatria-image-preparation-'));
  try { await run(directory); } finally { assert.ok(resolve(directory).startsWith(resolve(tmpdir()) + sep)); await rm(directory, {recursive: true, force: true}); }
}
async function input(directory: string, bytes: Buffer, name = 'private-source.image') {
  const path = join(directory, name); await writeFile(path, bytes, {mode: 0o600});
  return {path, expectedBytes: bytes.length, expectedSha256: hash(bytes)};
}
function rejects(code: ImagePreparationCode | ImagePreparationCode[]) {
  return (error: unknown) => { assert.ok(error instanceof ImagePreparationError); assert.ok((Array.isArray(code) ? code : [code]).includes(error.code), error.code); assert.doesNotMatch(error.message, /PRIVATE_SYNTHETIC|private-source|private-credential|https?:|ffmpeg|[A-Z]:\\/i); return true; };
}
async function assertResult(selected: Awaited<ReturnType<typeof input>>, original: Buffer, result: Awaited<ReturnType<typeof prepareReferenceImage>>, width: number, height: number) {
  assert.deepEqual(await readFile(selected.path), original, 'The selected original remains byte-identical');
  assert.equal(hash(await readFile(selected.path)), selected.expectedSha256);
  assert.equal(Buffer.isBuffer(result.bytes), true); assert.ok(result.bytes.some(byte => byte > 127), 'Binary bytes are retained');
  assert.deepEqual(result.output, {width, height, sha256: hash(result.bytes), bytes: result.bytes.length, format: 'png', pixelFormat: 'rgba8', metadataRemoved: true});
  assert.match(result.recipeHash, /^[a-f0-9]{64}$/); assert.ok(result.bytes.length <= 10 * 1024 ** 2);
  assert.equal(result.bytes.includes(Buffer.from(privateMarker)), false);
  const decoded = decodeOutput(result.bytes); assert.equal(decoded.width, width); assert.equal(decoded.height, height); return decoded;
}

// Missing binaries fail this suite. CI installs its pinned fd-capable build;
// local runs may select one explicitly using COATRIA_TEST_FFMPEG_PATH.
test('real preparation binary is installed, hash-pinned and supports seekable input descriptors', async () => {
  const installed = await options();
  const result = spawnSync(installed.ffmpegPath!, ['-hide_banner', '-h', 'protocol=fd'], {shell: false, windowsHide: true, encoding: 'utf8', timeout: 10_000, maxBuffer: 65_536});
  assert.ifError(result.error); assert.equal(result.status, 0); assert.match(result.stdout + result.stderr, /fd AVOptions:/); assert.match(installed.ffmpegSha256!, /^[a-f0-9]{64}$/);
});

test('real PNG keeps small pixels and straight alpha while removing text and EXIF without changing the original', async () => scratch(async directory => {
  const original = png(96, 64), selected = await input(directory, original), result = await prepareReferenceImage(selected, await options());
  assert.ok(original.includes(Buffer.from(privateMarker))); assert.deepEqual(result.source, {format: 'png', width: 96, height: 64, orientation: 1});
  assertQuadrants(await assertResult(selected, original, result, 96, 64));
}));

test('real oversized PNG uses rounded aspect ratio, bounded long edge and unchanged straight alpha', {timeout: 60_000}, async () => scratch(async directory => {
  const original = png(3001, 1000), selected = await input(directory, original), result = await prepareReferenceImage(selected, await options());
  assert.deepEqual(result.source, {format: 'png', width: 3001, height: 1000, orientation: 1});
  assertQuadrants(await assertResult(selected, original, result, 2048, 682), undefined, 1);
}));

test('all eight real JPEG EXIF orientations are baked into pixels before metadata removal', {timeout: 90_000}, async t => scratch(async directory => {
  const originalJpeg = await encode(png(96, 64, false, true), 'jpeg');
  const expected = [[0, 1, 2, 3], [1, 0, 3, 2], [3, 2, 1, 0], [2, 3, 0, 1], [0, 2, 1, 3], [2, 0, 3, 1], [3, 1, 2, 0], [1, 3, 0, 2]];
  for (let orientation = 1; orientation <= 8; orientation++) await t.test('orientation ' + orientation, async () => {
    const original = jpegMetadata(originalJpeg, orientation), selected = await input(directory, original, `orientation-${orientation}.jpeg`), result = await prepareReferenceImage(selected, await options());
    assert.ok(original.includes(Buffer.from(privateMarker))); assert.deepEqual(result.source, {format: 'jpeg', width: 96, height: 64, orientation});
    assertQuadrants(await assertResult(selected, original, result, orientation >= 5 ? 64 : 96, orientation >= 5 ? 96 : 64), expected[orientation - 1], 12, true);
  });
}));

test('real lossless WebP keeps alpha and pixel regions but discards EXIF and XMP', async () => scratch(async directory => {
  const original = webpMetadata(await encode(png(96, 64, false), 'webp'), 96, 64), selected = await input(directory, original), result = await prepareReferenceImage(selected, await options());
  assert.ok(original.includes(Buffer.from(privateMarker))); assert.deepEqual(result.source, {format: 'webp', width: 96, height: 64, orientation: 1});
  assertQuadrants(await assertResult(selected, original, result, 96, 64));
}));

test('real progressive JPEG fully decodes and honors orientation with the same output policy', async () => scratch(async directory => {
  assert.ok(progressiveJpeg.includes(Buffer.from([0xff, 0xc2])), 'Progressive SOF2 fixture');
  const original = jpegMetadata(progressiveJpeg, 6), selected = await input(directory, original), result = await prepareReferenceImage(selected, await options());
  assert.deepEqual(result.source, {format: 'jpeg', width: 96, height: 64, orientation: 6});
  assertQuadrants(await assertResult(selected, original, result, 64, 96), [2, 0, 3, 1], 12, true);
}));

test('real PNG and WebP EXIF orientation is baked while preserving alpha', async t => scratch(async directory => {
  for (const format of ['png', 'webp'] as const) await t.test(format, async () => {
    const original = format === 'png' ? png(96, 64, true, false, 8) : webpMetadata(await encode(png(96, 64, false), 'webp'), 96, 64, 8);
    const selected = await input(directory, original), result = await prepareReferenceImage(selected, await options());
    assert.deepEqual(result.source, {format, width: 96, height: 64, orientation: 8});
    assertQuadrants(await assertResult(selected, original, result, 64, 96), [1, 3, 0, 2]);
  });
}));

test('real RGB, grayscale, grayscale-alpha and indexed transparency PNGs produce exact RGBA8 pixels', async t => scratch(async directory => {
  for (const colorType of [0, 2, 3, 4] as const) await t.test('color type ' + colorType, async () => {
    const fixture = otherPng(colorType), selected = await input(directory, fixture.bytes), result = await prepareReferenceImage(selected, await options());
    const decoded = await assertResult(selected, fixture.bytes, result, fixture.width, fixture.height);
    assert.deepEqual(decoded.pixels, fixture.expected);
  });
}));

test('standard sRGB PNG color declarations are accepted with unchanged known pixels', async () => scratch(async directory => {
  const base = png(96, 64), gamma = Buffer.alloc(4), chromaticity = Buffer.alloc(32);
  gamma.writeUInt32BE(45455); [31270, 32900, 64000, 33000, 30000, 60000, 15000, 6000].forEach((value, index) => chromaticity.writeUInt32BE(value, index * 4));
  const original = Buffer.concat([base.subarray(0, 33), chunk('gAMA', gamma), chunk('cHRM', chromaticity), chunk('sRGB', Buffer.from([0])), base.subarray(33)]);
  const selected = await input(directory, original), result = await prepareReferenceImage(selected, await options());
  assertQuadrants(await assertResult(selected, original, result, 96, 64));
}));

test('actual preparation is deterministic for the same pinned source, recipe and binary', async () => scratch(async directory => {
  const selected = await input(directory, png(96, 64)), installed = await options(), first = await prepareReferenceImage(selected, installed), second = await prepareReferenceImage(selected, installed);
  assert.deepEqual(first, second);
}));

test('exact hash/length, private regular input and absolute binary pin are enforced', async () => scratch(async directory => {
  const selected = await input(directory, png(16, 16)), installed = await options();
  await assert.rejects(prepareReferenceImage({...selected, expectedBytes: selected.expectedBytes + 1}, installed), rejects('PREPARATION_BYTES_CHANGED'));
  await assert.rejects(prepareReferenceImage({...selected, expectedSha256: '0'.repeat(64)}, installed), rejects('PREPARATION_BYTES_CHANGED'));
  for (const path of [directory, 'relative.png', 'https://private.invalid/private-credential', '\\\\private-server\\share\\private-source.png']) await assert.rejects(prepareReferenceImage({...selected, path}, installed), rejects('PREPARATION_INPUT_INVALID'));
  const alias = join(directory, 'hard-link.png'); await link(selected.path, alias);
  await assert.rejects(prepareReferenceImage({...selected, path: alias}, installed), rejects('PREPARATION_INPUT_INVALID'));
  await rm(alias);
  for (const override of [{ffmpegSha256: '0'.repeat(64)}, {ffmpegSha256: undefined}, {ffmpegPath: 'ffmpeg'}, {ffmpegPath: join(directory, 'missing-private-credential.exe')}]) await assert.rejects(prepareReferenceImage(selected, {...installed, ...override}), rejects('PREPARATION_UNAVAILABLE'));
}));

test('real entry point rejects malformed/trailing containers, profiles and oversized source claims', async () => scratch(async directory => {
  const original = png(16, 16, false), installed = await options();
  for (const bytes of [Buffer.concat([original, Buffer.from(privateMarker)]), original.subarray(0, original.length - 1), Buffer.from('<html>' + privateMarker + '</html>')]) await assert.rejects(prepareReferenceImage(await input(directory, bytes), installed), rejects(['PREPARATION_UNSUPPORTED', 'PREPARATION_DECODE_FAILED']));
  const ihdr = original.subarray(16, 29);
  for (const [width, height] of [[8193, 1], [8192, 4096]]) { const changed = Buffer.from(ihdr); changed.writeUInt32BE(width); changed.writeUInt32BE(height, 4); const bytes = Buffer.concat([signature, chunk('IHDR', changed), original.subarray(33)]); await assert.rejects(prepareReferenceImage(await input(directory, bytes), installed), rejects('PREPARATION_LIMIT_EXCEEDED')); }
  const profile = Buffer.concat([original.subarray(0, 33), chunk('iCCP', Buffer.concat([Buffer.from('private-profile\0\0'), deflateSync(Buffer.from(privateMarker))])), original.subarray(33)]);
  await assert.rejects(prepareReferenceImage(await input(directory, profile), installed), rejects('PREPARATION_UNSUPPORTED'));
  const oversized = await input(directory, Buffer.alloc(32 * 1024 ** 2 + 1));
  await assert.rejects(prepareReferenceImage(oversized, installed), rejects('PREPARATION_LIMIT_EXCEEDED'));
}));

test('real incompressible legal source hits the binary stdout ceiling without changing the original', {timeout: 60_000}, async () => scratch(async directory => {
  const width = 2048, height = 2048, stride = width * 4 + 1, rows = Buffer.alloc(stride * height), header = Buffer.alloc(13);
  header.writeUInt32BE(width); header.writeUInt32BE(height, 4); header[8] = 8; header[9] = 6;
  let state = 0x619bafe3;
  for (let y = 0; y < height; y++) for (let x = 0; x < width; x++) {
    state ^= state << 13; state ^= state >>> 17; state ^= state << 5;
    rows.writeUInt32LE(state >>> 0, y * stride + 1 + x * 4);
  }
  const original = Buffer.concat([signature, chunk('IHDR', header), chunk('IDAT', deflateSync(rows)), chunk('IEND', Buffer.alloc(0))]);
  assert.ok(original.length > 10 * 1024 ** 2 && original.length < 32 * 1024 ** 2, 'Legal source with incompressible pixels exceeds only the output budget');
  const selected = await input(directory, original);
  await assert.rejects(prepareReferenceImage(selected, await options()), rejects('PREPARATION_LIMIT_EXCEEDED'));
  assert.deepEqual(await readFile(selected.path), original);
  assert.equal(hash(await readFile(selected.path)), selected.expectedSha256);
}));

test('cancellation and stricter deadlines reject with fixed sanitized errors', async () => scratch(async directory => {
  const selected = await input(directory, png(96, 64)), installed = await options(), controller = new AbortController();
  controller.abort(new Error('https://private.invalid/private-credential'));
  await assert.rejects(prepareReferenceImage({...selected, signal: controller.signal}, installed), rejects('PREPARATION_ABORTED'));
  await assert.rejects(prepareReferenceImage(selected, {...installed, timeoutMs: 1}), rejects('PREPARATION_TIMEOUT'));
  for (const timeoutMs of [0, -1, 30_001, Number.NaN]) await assert.rejects(prepareReferenceImage(selected, {...installed, timeoutMs}), rejects('PREPARATION_INPUT_INVALID'));
  const during = new AbortController(), pending = prepareReferenceImage({...selected, signal: during.signal}, installed);
  const timer = setTimeout(() => during.abort(new Error(privateMarker)), 5);
  try { await assert.rejects(pending, rejects('PREPARATION_ABORTED')); } finally { clearTimeout(timer); }
}));

test('native transform requires explicit test mode and is unconditionally refused in production', async () => scratch(async directory => {
  const selected = await input(directory, png(16, 16)), installed = await options();
  await assert.rejects(prepareReferenceImage(selected, {...installed, nativeTestMode: undefined}), rejects('PREPARATION_UNAVAILABLE'));
  const previous = process.env.NODE_ENV;
  try { Object.assign(process.env, {NODE_ENV: 'production'}); await assert.rejects(prepareReferenceImage(selected, installed), rejects('PREPARATION_UNAVAILABLE')); }
  finally { if (previous === undefined) delete (process.env as Record<string, string | undefined>).NODE_ENV; else Object.assign(process.env, {NODE_ENV: previous}); }
}));

test('real transform does not inherit FFREPORT or emit a host file containing private diagnostics', async () => scratch(async directory => {
  const selected = await input(directory, png(96, 64)), installed = await options(), report = join(directory, 'private-credential-report.log'), previous = process.env.FFREPORT;
  process.env.FFREPORT = 'file=' + report.replaceAll('\\', '/').replaceAll(':', '\\:') + ':level=48';
  try {
    const control = spawnSync(installed.ffmpegPath!, ['-v', 'error', '-version'], {shell: false, windowsHide: true, encoding: 'utf8', timeout: 10_000, maxBuffer: 65_536, env: {NODE_ENV: 'production', LANG: 'C', LC_ALL: 'C', FFREPORT: process.env.FFREPORT, ...(process.platform === 'win32' ? {SystemRoot: process.env.SystemRoot, WINDIR: process.env.WINDIR} : {})}});
    assert.ifError(control.error); assert.equal(control.status, 0); await access(report); await rm(report);
    await prepareReferenceImage(selected, installed);
    await assert.rejects(access(report), {code: 'ENOENT'});
  } finally { if (previous === undefined) delete process.env.FFREPORT; else process.env.FFREPORT = previous; }
}));
