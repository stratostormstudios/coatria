# Coatria character collection

The office uses 12 curated characters from the operator's purchased **ITHappy City Characters v1.3** pack. The original Blender file and archives are preserved outside this repository. Only human occupants use the collection; agent characters retain their visibly different robot design and AI labels.

## Runtime assets and licensing boundary

Each catalog ID in `src/lib/avatar-catalog.ts` requires two privately supplied deployment files:

```
.runtime-assets/city-characters/city-023.glb
.runtime-assets/city-characters/city-023.png
```

This directory is ignored by Git. Do not commit the purchased source, models, textures or portraits to the public repository, and do not place them under `public/`. The source-only repository does not grant a license to the commercial pack. Obtain the appropriate commercial license independently from the publisher.

The application serves curated GLBs and portraits through authenticated, exact-ID routes. Responses reject cross-site and stale-account requests, use private/no-store caching, and do not expose arbitrary filesystem paths. A signed-in browser necessarily receives model bytes; this is access control, not copy protection. The application does not expose the source archive, allow standalone asset trading, or use the pack as input to generative AI services.

## Exported collection

Measured on 2026-09-11 after the six-clip export, mesh merging and animation-channel pruning:

| Property | Actual exported bundle |
| --- | --- |
| Characters | 12 |
| Triangles per character | 7,730–11,576 |
| GLB size per character | 838,924–1,030,636 bytes |
| Combined GLBs | 10,932,112 bytes |
| GLBs and portraits combined | 11,099,309 bytes |
| Skin | 44 joints per character |
| Geometry | One merged mesh, 1–4 material primitives |
| Texture | Embedded 256 × 256 palette; Sand blazer also uses a 512 × 512 fabric texture; no external asset URLs |
| Clips | Idle, Walk, Run, Sit, Wave, Dance |
| Portraits | 160 × 200 PNG |

These are asset measurements, not a simultaneous-user or mobile frame-rate benchmark. Large crowds still need visibility budgets, distance-based animation updates and device profiling.

The supplied GLBs had rigs but no animation clips. Clips were exported locally from the purchased Blender source. The three senior variants use the standard supplied Adult_Walk on their matching rest skeleton; their family-specific idle, sitting, waving and dancing remain. The original senior shuffle was unsuitable at the office's normal movement speed. Terminal hand/finger seams are closed over six frames; hip sway is preserved. Exported Walk lasts approximately 1.333 seconds, faces +Z, has no root displacement and has a measured authored gait speed of 0.9505 model units per second.

Run uses the supplied Adult_Run on every compatible rig, with measured authored pace 3.6093 model units per second. Wave is a one-shot emote; Dance uses the supplied family DanceIdle. These six clips drive office locomotion, the Character menu and calibrated task-chair seating. See [character interactions](CHARACTER_INTERACTIONS.md) for controls, shared-state behavior and supported chairs.

## Movement and resource lifetime

The scene normalizes character height to 2.2 world units and scales authored gait speed accordingly. Playback follows actual distance traveled. Acceleration, stopping and yaw are smoothed; idle and walking continuously blend. Remote humans follow bounded, obstacle-aware paths toward presence snapshots. Presence now refreshes approximately every two seconds in the office, so it does not provide frame-by-frame multiplayer synchronization.

One office instance downloads each required appearance once. Geometry and textures are shared, while every human receives an independent cloned skeleton and mixer. Removing one person releases their skeleton; closing the office aborts pending requests and disposes the library. Late responses cannot reattach a character after account/company teardown. Load failures preserve the procedural character and accessible room controls. Reduced-motion settings suppress continuous animation.

## Building and verification

Supply the licensed files privately before any Vercel upload. `npm run build` runs a character-bundle guard whenever `VERCEL` is set; locally use `COATRIA_REQUIRE_AVATAR_ASSETS=1`. The guard requires all catalog models, skins, every declared Idle/Walk/Run/Sit/Wave/Dance clip, portraits, bounded file sizes and embedded resources. A Vercel deployment from a Git checkout without the licensed bundle fails deliberately. Public-source CI may build without it and does not pretend to verify licensed models.

Next.js explicitly traces GLBs into the model function and PNGs into the preview function. Verify the corresponding `.next/server/app/api/avatars/[avatarId]/*/route.js.nft.json` files contain every catalog asset before deployment. `.vercelignore` intentionally permits `.runtime-assets` while excluding credentials, local databases and test output. Use the licensed operator's private local upload workflow until a private artifact store is introduced.

Migration `005_personal_avatars.sql` adds nullable `users.avatar_id`. Apply it with the owner through the migration process or Neon SQL Editor, then grant the runtime role INSERT/UPDATE only on the new avatar column. Do not restore an owner connection to application environment variables. Null means the catalog's deterministic automatic choice; explicit saved choices persist across companies. Updating a name with no character edit must preserve the latest saved avatar.

The browser suite covers independent skeletons, blending, calibrated playback, remote movement, cancellation/disposal and graceful fallback. The licensed profile test additionally verifies portrait loading, saved selection, reload persistence, an authenticated actual-model load and mobile layout. Set `COATRIA_REQUIRE_AVATAR_ASSETS=1` when running that test against a local service with the private bundle.
