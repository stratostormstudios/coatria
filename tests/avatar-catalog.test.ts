import test from 'node:test';
import assert from 'node:assert/strict';
import { AVATAR_CATALOG, getAvatarDefinition, selectAvatarForUser } from '../src/lib/avatar-catalog';
import { profileInput } from '../src/lib/model';
import { avatarAssetPath } from '../src/lib/avatar-assets';
import { resolve } from 'node:path';

test('avatar choices allow only audited IDs, never paths, URLs or another identity', () => {
  const profile = { name: 'A person', roleTitle: 'Designer', avatarColor: '#abcdef' };
  assert(AVATAR_CATALOG.length >= 6);
  assert.equal(new Set(AVATAR_CATALOG.map(avatar => avatar.id)).size, AVATAR_CATALOG.length);
  for (const avatar of AVATAR_CATALOG) {
    assert.match(avatar.id, /^city-[a-z0-9]+(-[a-z0-9]+)*$/);
    assert(avatar.name && avatar.idleClip && avatar.walkClip && avatar.walkSpeed > 0);
    assert(profileInput.safeParse({ ...profile, avatarId: avatar.id }).success);
    assert.equal(getAvatarDefinition(avatar.id), avatar);
  }
  for (const avatarId of ['city-unlisted', '../private/model', 'https://example.test/model.glb', '', '__proto__', { id: AVATAR_CATALOG[0].id }]) {
    assert.equal(profileInput.safeParse({ ...profile, avatarId }).success, false);
  }
  assert(profileInput.safeParse(profile).success);
  assert(profileInput.safeParse({ ...profile, avatarId: null }).success);
  assert.equal(profileInput.safeParse({ ...profile, avatarId: AVATAR_CATALOG[0].id, userId: 'someone-else' }).success, false);
  for (const avatarId of ['city-unlisted', '../city-023', 'city-023/../../private', '%2e%2e%2fprivate', '__proto__', 'CITY-023']) assert.throws(() => avatarAssetPath(avatarId), /Character not found/);
  assert.equal(avatarAssetPath(AVATAR_CATALOG[0].id), resolve('.runtime-assets', 'city-characters', AVATAR_CATALOG[0].id + '.glb'));
  assert.equal(avatarAssetPath(AVATAR_CATALOG[0].id,'preview'), resolve('.runtime-assets', 'city-characters', AVATAR_CATALOG[0].id + '.png'));
});

test('automatic avatars remain stable across catalog order and honor an explicit choice', () => {
  const person = '2303176b-7c29-49c7-b7e1-fac7cf3a9a19';
  const reversed = [...AVATAR_CATALOG].reverse();
  const automatic = selectAvatarForUser(person);
  assert(automatic);
  assert.equal(selectAvatarForUser(person, null, reversed)?.id, automatic.id);
  assert.equal(selectAvatarForUser(person, 'retired-avatar')?.id, automatic.id);
  const selected = AVATAR_CATALOG.find(avatar => avatar.id !== automatic.id)!;
  assert.equal(selectAvatarForUser(person, selected.id)?.id, selected.id);
  assert.equal(selectAvatarForUser(person, null, []), undefined);
});
