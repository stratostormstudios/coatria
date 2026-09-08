import { readFile, stat } from 'node:fs/promises';
import { resolve } from 'node:path';
import { requireUser } from './auth';
import { AVATAR_CATALOG, getAvatarDefinition } from './avatar-catalog';
import { assertOrigin, errorResponse, fail, json, rateLimit } from './security';

export const MAX_AVATAR_BYTES = 4 * 1024 * 1024;

/** Exact catalog IDs are the only path input accepted by the asset service. */
export function avatarAssetPath(avatarId: string, kind: 'model' | 'preview' = 'model') {
  if (!/^[a-z0-9-]+$/.test(avatarId) || !getAvatarDefinition(avatarId)) fail(404, 'Character not found.');
  return resolve(process.cwd(), '.runtime-assets', 'city-characters', `${avatarId}.${kind === 'preview' ? 'png' : 'glb'}`);
}

export async function handleAvatarRequest(request: Request, avatarId?: string, kind: 'model' | 'preview' = 'model') {
  try {
    if (request.headers.get('sec-fetch-site') === 'cross-site') fail(403, 'Cross-site requests are not allowed.');
    if (request.headers.has('origin')) assertOrigin(request);
    // Authenticate before revealing the catalog, checking files, or returning bytes.
    const user = await requireUser(request);
    if (avatarId === undefined) return json({ avatars: AVATAR_CATALOG });
    const file = avatarAssetPath(avatarId, kind);
    const maxBytes = kind === 'preview' ? 256 * 1024 : MAX_AVATAR_BYTES;
    await rateLimit(`avatar-${kind}:${user.id}`, 120, 60);
    let bytes: Buffer;
    try {
      const info = await stat(file);
      if (!info.isFile() || info.size < 20 || info.size > maxBytes) fail(503, 'This character is temporarily unavailable.', 'AVATAR_UNAVAILABLE');
      bytes = await readFile(file);
    } catch (error) {
      if (error && typeof error === 'object' && 'code' in error && error.code === 'ENOENT') fail(503, 'This character is temporarily unavailable.', 'AVATAR_UNAVAILABLE');
      throw error;
    }
    const valid = bytes.byteLength >= 20 && bytes.byteLength <= maxBytes && (kind === 'preview'
      ? bytes.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]))
      : bytes.readUInt32LE(0) === 0x46546c67 && bytes.readUInt32LE(4) === 2 && bytes.readUInt32LE(8) === bytes.byteLength);
    if (!valid) fail(503, 'This character is temporarily unavailable.', 'AVATAR_UNAVAILABLE');
    return new Response(new Uint8Array(bytes), { headers: {
      'Content-Type': kind === 'preview' ? 'image/png' : 'model/gltf-binary',
      'Content-Length': String(bytes.byteLength),
      'Cache-Control': 'private, no-store',
      'X-Content-Type-Options': 'nosniff',
      'Cross-Origin-Resource-Policy': 'same-origin',
      'Content-Disposition': `inline; filename="${avatarId}.${kind === 'preview' ? 'png' : 'glb'}"`,
      'Vary': 'Cookie, X-Coatria-User'
    } });
  } catch (error) { return errorResponse(error); }
}
