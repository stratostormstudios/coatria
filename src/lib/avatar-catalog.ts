/** Public metadata only. Licensed models are served by authenticated API routes. */
export type AvatarDefinition = {
  id: string;
  name: string;
  idleClip: string;
  walkClip: string;
  /** Authored gait speed in exported model units/second; scale with model height. */
  walkSpeed: number;
  runClip?: string;
  runSpeed?: number;
  sitClip?: string;
  waveClip?: string;
  danceClip?: string;
  forwardRotation?: number;
};

// Keep metadata synchronized with the audited, privately deployed model files.
export const AVATAR_CATALOG: readonly AvatarDefinition[] = [
  { id: 'city-023', name: 'Graphite suit', idleClip: 'Idle', walkClip: 'Walk', walkSpeed: 0.9505, runClip: 'Run', runSpeed: 3.6093, sitClip: 'Sit', waveClip: 'Wave', danceClip: 'Dance', forwardRotation: 0 },
  { id: 'city-024', name: 'Charcoal suit', idleClip: 'Idle', walkClip: 'Walk', walkSpeed: 0.9505, runClip: 'Run', runSpeed: 3.6093, sitClip: 'Sit', waveClip: 'Wave', danceClip: 'Dance', forwardRotation: 0 },
  { id: 'city-025', name: 'Brown suit', idleClip: 'Idle', walkClip: 'Walk', walkSpeed: 0.9505, runClip: 'Run', runSpeed: 3.6093, sitClip: 'Sit', waveClip: 'Wave', danceClip: 'Dance', forwardRotation: 0 },
  { id: 'city-026', name: 'Tailored suit', idleClip: 'Idle', walkClip: 'Walk', walkSpeed: 0.9505, runClip: 'Run', runSpeed: 3.6093, sitClip: 'Sit', waveClip: 'Wave', danceClip: 'Dance', forwardRotation: 0 },
  { id: 'city-027', name: 'Slate blazer', idleClip: 'Idle', walkClip: 'Walk', walkSpeed: 0.9505, runClip: 'Run', runSpeed: 3.6093, sitClip: 'Sit', waveClip: 'Wave', danceClip: 'Dance', forwardRotation: 0 },
  { id: 'city-028', name: 'Classic waistcoat', idleClip: 'Idle', walkClip: 'Walk', walkSpeed: 0.9505, runClip: 'Run', runSpeed: 3.6093, sitClip: 'Sit', waveClip: 'Wave', danceClip: 'Dance', forwardRotation: 0 },
  { id: 'city-100', name: 'Coral shirt', idleClip: 'Idle', walkClip: 'Walk', walkSpeed: 0.9505, runClip: 'Run', runSpeed: 3.6093, sitClip: 'Sit', waveClip: 'Wave', danceClip: 'Dance', forwardRotation: 0 },
  { id: 'city-119', name: 'Emerald jacket', idleClip: 'Idle', walkClip: 'Walk', walkSpeed: 0.9505, runClip: 'Run', runSpeed: 3.6093, sitClip: 'Sit', waveClip: 'Wave', danceClip: 'Dance', forwardRotation: 0 },
  { id: 'city-140', name: 'Black blazer', idleClip: 'Idle', walkClip: 'Walk', walkSpeed: 0.9505, runClip: 'Run', runSpeed: 3.6093, sitClip: 'Sit', waveClip: 'Wave', danceClip: 'Dance', forwardRotation: 0 },
  { id: 'city-145', name: 'Coral hoodie', idleClip: 'Idle', walkClip: 'Walk', walkSpeed: 0.9505, runClip: 'Run', runSpeed: 3.6093, sitClip: 'Sit', waveClip: 'Wave', danceClip: 'Dance', forwardRotation: 0 },
  { id: 'city-157', name: 'Sand blazer', idleClip: 'Idle', walkClip: 'Walk', walkSpeed: 0.9505, runClip: 'Run', runSpeed: 3.6093, sitClip: 'Sit', waveClip: 'Wave', danceClip: 'Dance', forwardRotation: 0 },
  { id: 'city-171', name: 'Charcoal casual', idleClip: 'Idle', walkClip: 'Walk', walkSpeed: 0.9505, runClip: 'Run', runSpeed: 3.6093, sitClip: 'Sit', waveClip: 'Wave', danceClip: 'Dance', forwardRotation: 0 },
];

export function getAvatarDefinition(id: string): AvatarDefinition | undefined {
  return AVATAR_CATALOG.find(avatar => avatar.id === id);
}

/** Stable defaults keep an existing identity recognizable without writing a profile. */
export function selectAvatarForUser(userId: string, avatarId?: string | null, catalog: readonly AvatarDefinition[] = AVATAR_CATALOG): AvatarDefinition | undefined {
  const chosen = avatarId ? catalog.find(avatar => avatar.id === avatarId) : undefined;
  if (chosen) return chosen;
  if (!catalog.length) return undefined;
  const sorted = [...catalog].sort((a, b) => a.id < b.id ? -1 : a.id > b.id ? 1 : 0);
  let hash = 2166136261;
  for (let index = 0; index < userId.length; index++) hash = Math.imul(hash ^ userId.charCodeAt(index), 16777619) >>> 0;
  return sorted[hash % sorted.length];
}
