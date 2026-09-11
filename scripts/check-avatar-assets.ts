import { readFile } from 'node:fs/promises';
import { AVATAR_CATALOG } from '../src/lib/avatar-catalog';
import { avatarAssetPath, MAX_AVATAR_BYTES } from '../src/lib/avatar-assets';

// Public-source CI can build without the licensed pack. Every Vercel upload must
// include it; this prevents a later Git-only deployment silently losing avatars.
async function main() {
if (process.env.VERCEL || process.env.COATRIA_REQUIRE_AVATAR_ASSETS === '1') {
  if (!AVATAR_CATALOG.length) throw new Error('The release character catalog is empty.');
  for (const avatar of AVATAR_CATALOG) {
    const bytes = await readFile(avatarAssetPath(avatar.id));
    if (bytes.length < 20 || bytes.length > MAX_AVATAR_BYTES || bytes.readUInt32LE(0) !== 0x46546c67 || bytes.readUInt32LE(4) !== 2 || bytes.readUInt32LE(8) !== bytes.length) throw new Error(`Invalid runtime character: ${avatar.id}`);
    const document = JSON.parse(bytes.subarray(20, 20 + bytes.readUInt32LE(12)).toString('utf8'));
    const clips = new Set((document.animations || []).map((clip: { name: string }) => clip.name));
    if ([avatar.idleClip,avatar.walkClip,avatar.runClip,avatar.sitClip,avatar.waveClip,avatar.danceClip].filter(Boolean).some(clip=>!clips.has(clip)) || !document.skins?.length) throw new Error(`Missing rig or locomotion clips: ${avatar.id}`);
    if ([...(document.images || []), ...(document.buffers || [])].some(item => item.uri)) throw new Error(`Runtime character must be self-contained: ${avatar.id}`);
    const preview = await readFile(avatarAssetPath(avatar.id, 'preview'));
    if (preview.length < 20 || preview.length > 256 * 1024 || !preview.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]))) throw new Error(`Missing or invalid character preview: ${avatar.id}`);
  }
  console.log(`Verified ${AVATAR_CATALOG.length} private, rigged runtime characters.`);
} else console.log('Source-only build: licensed character bundle is checked when deploying to Vercel.');
}
main().catch(error => { console.error(error instanceof Error ? error.message : 'Character bundle validation failed.'); process.exitCode = 1; });
