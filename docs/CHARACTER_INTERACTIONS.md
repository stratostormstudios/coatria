# Character movement, emotes, reactions, and seating

## Authored animation inventory

The original installed City Characters models contained only `Idle`, `Walk`, `Sit`, and `Wave`. Inspection of the purchased Blender source found compatible `Adult_Run` and family-specific `DanceIdle` actions. The private export pipeline now includes all six canonical clips in the 12 curated characters. No purchased files are committed to the repository.

| Runtime clip | Source and behavior |
| --- | --- |
| `Idle` | Family `IdleLookAround`; normal standing idle |
| `Walk` | `Adult_Walk` on the compatible 44-joint rigs; 1.3333 seconds |
| `Run` | Actual `Adult_Run`; 0.6667 seconds |
| `Sit` | Family `SitTableIdle`; 3.0667-second seated idle |
| `Wave` | Family `WaveHello`; one-shot, 5.6333 seconds for the tested adult and 7.4333 seconds for the senior |
| `Dance` | Family `DanceIdle`; repeats only within the acknowledged interaction lifetime. Tested adult clip is 9.5 seconds; senior clip is 3.5 seconds. |

The shared avatar catalog declares clip names and authored gait speeds. Walking pace is `0.9505`, and running pace is `3.6093`, in exported model units per second. Runtime playback divides actual root speed by the authored pace multiplied by the model's normalization scale. Hip translation and skeletal curves remain intact.

The renderer gates every authored action on the clip actually present in the loaded GLB. A model without `Run` uses its walking clip for faster movement and labels that control **Fast walk**. Missing Wave, Dance, or Sit clips disable the corresponding authored action instead of inventing poses. Bot appearance remains distinct.

## Controls

| Input | Result |
| --- | --- |
| Single left-click on open floor | Walk to that position using the collision grid |
| Single left-click on a person or furniture | Preserve the existing selection and context actions |
| Double left-click on open floor | Run to the floor target; two clicks within 500 ms and 14 screen pixels |
| Double right-click | Teleport to a valid floor destination |
| Left drag / right drag | Preserve orbit / pan; a drag does not count as a movement click |
| Character actions → Walk, Run, or Teleport | Select the mode for subsequent floor taps and arrow keys |
| Arrow keys with the scene focused | Move one metre; selected Teleport mode uses a two-metre step |
| Shift + arrow key | Request faster movement |
| Character actions → Wave / Dance | Request the available authored emote |
| Character actions → reaction | Show an acknowledged emoji above the character |
| Selected supported chair → Sit in this chair | Walk to its calibrated approach and request the seat |
| Character actions → chair picker | Keyboard/touch equivalent for selecting a supported chair |
| Stand up or a new movement request | Leave the chair through its safe approach and release the seat |
| Escape while navigating | Stop the local path and cancel a pending seat intent; it does not silently leave a committed chair |

Walking cruise speed is **2.1 metres/second**; running is **3.8 metres/second**, with acceleration, braking, turning, and walk/run pose blending. These speeds are separate from authored clip playback rates. Reduced-motion navigation changes position without playing a travel animation.

Movement rays intersect the horizontal floor plane at world `Y = 0.08`. They do not use a desk, chair, or wall surface as the destination. Teleport requires a finite point inside the navigation bounds and outside furniture clearance; it never silently moves an invalid target to a different nearest point. Walking retains the existing nearest-open routing behavior. Teleport bypasses the walking path, but it does not open audio rooms, grant access, or change authorization.

The character menu fits the minimum mobile scene height and scrolls when necessary. Its buttons retain native keyboard focus and accessible labels. The menu does not intercept orbit/pan gestures on the canvas.

## Presence and callback contract

The wrapper passes `options.seats = getOfficeSeats(layout, floor)` and includes the viewer's own row in `options.presence`. An initial seated row is retained while its private character model loads, then applied once the real Sit clip is available. A legacy row that omits `seatId` does not erase an acknowledged local seat; modern API rows explicitly use `null` when standing.

Continuous movement uses:

```ts
options.onMove({
  x, z,
  motionMode: 'walk' | 'run' | 'teleport',
  seatId: null
});
```

Explicit commands use a separate promise-returning callback:

```ts
const ownPresence = await options.onInteraction({
  seatId: layoutItemId,
  x: approach.x,
  z: approach.z,
  motionMode: 'walk'
});

await options.onInteraction({
  interaction: {type: 'emote', value: 'wave' | 'dance'}
});

await options.onInteraction({
  interaction: {
    type: 'reaction',
    value: 'wave' | 'applause' | 'heart' | 'idea' | 'celebrate' | 'coffee'
  }
});
```

The acknowledged presence includes optional `motionMode`, `seatId`, `seat: {x, z, yaw, seatHeight}`, and `interaction: {id, type, value, createdAt, expiresAt}`. The server supplies the interaction ID and eight-second expiry. Heartbeats do not create another interaction. The renderer consumes each ID once and expires its visual state; repeating a heartbeat cannot replay an emote or renew a reaction.

Wave plays once from its elapsed server timestamp. Dance runs only until the acknowledged expiry, looping shorter family clips as necessary. Starting movement fades out an active emote; the server clears an emote when moving or standing. Emoji reactions can remain visible for their remaining lifetime. Their glyphs and keys are allowlisted and rendered as text.

The normal workspace transport serializes explicit commands with movement. A move, Stand, or cancellation that follows an in-flight seat claim must be sent after that claim, even if the character was never seated locally. Acknowledgements from obsolete renderer intents cannot attach a seat or emote after a newer action. Leaving the Office view releases a seat through the transport. Account/company teardown must not issue deferred requests with an obsolete identity; an already committed old-company seat then expires through the server's presence TTL.

An isolated test lab can supply its own local acknowledgement callback without writing simulated people to the API. Without a callback, local emotes/reactions remain a local preview, and the renderer refuses to fabricate an exclusive seat claim.

## Chair calibration and lifecycle

Only audited catalog items are seatable. The current allowlist is:

| Asset | Native cushion height | Default world seat height |
| --- | ---: | ---: |
| `office-chair-001` | 0.45 m | 0.53 m |
| `office-chair-006` | 0.45 m at its sloped cushion center | 0.53 m |
| `office-chair-009` | 0.55 m | 0.63 m |
| `office-chair-012` | 0.48 m | 0.56 m |

The shared server/client helper scales the native height, adds the `0.08 m` floor surface once, and uses the renderer's clockwise layout yaw: `-rotation × π / 180`. Native forward is +Z. The helper supplies an approach behind the chair, beyond its scaled depth and actor clearance. It rejects unsupported furniture and invalid seat dimensions. The renderer additionally path-checks the approach against every current obstacle, so an edited desk or partition can make a chair unavailable until its aisle is cleared.

The sequence is:

1. Check that the loaded rig has Sit and the selected item has a calibrated seat.
2. Walk to the safe approach. No seat reservation is made while approaching.
3. On arrival, request the server's exclusive seat claim. A conflict leaves the character in the aisle and displays the error.
4. On acknowledgement, apply the server seat position and yaw, then blend into the authored seated idle.
5. On movement or Stand, return to the approach, release the seat, and resume navigation. An invalid teleport target does not force a seated person to stand.

The renderer samples the authored Sit pelvis once per loaded model. A translation of the model wrapper places the pelvis approximately **0.12 m above the cushion** while retaining animated hip deltas. It does not zero skeletal axes or manually bend limbs. Sit is an authored seated idle, not a separately authored sit-down/stand-up transition; the renderer blends into/out of it at the chair and approach. Selection proxies and name labels lower with a seated character.

Avatar replacement retains the seat intent and recalibrates the new rig. Remote seated occupants use the same pose and transforms. Leaving or expiring occupants release their own skeletons, reaction elements, and queued movement without disposing another person's shared model resources.

## Inspection and verification

Public renderer methods now include `walkTo(x, z, mode?)`, `teleportTo(x, z)`, `requestSeat(id)`, `stand()`, `react(key)`, and `emote(key)`. Diagnostics add input mode, pending seat state, available emotes, whether an actual Run clip is loaded, per-occupant motion/pose state, seat IDs/heights, seated hip coordinates, run/emote weights, and the last interaction ID. These values aid local testing; they do not grant server permissions.

`tests/browser/character-interactions.spec.ts` loads the actual private GLBs through read-only route fixtures. Its eight cases cover:

- Faster walking and real running, double-click teleport, rejected occupied floor positions, and preserved panning.
- Keyboard/mobile controls, menu fit, reaction display, and Wave cancellation on movement.
- Every supported chair at 0°, 90°, 180°, and 270°, with pelvis/seat alignment and safe standing.
- Approach-before-claim, server conflict, and stale seat acknowledgement cancellation.
- Remote seat occupancy, movement, reaction expiry, and heartbeat ID deduplication.
- Adult and senior Run/Dance bone motion and an authored senior seated pose.
- A chair-height screen projection resolving to the ground below it, plus preserved single-click selection.
- Initially seated model loading, avatar replacement, omitted legacy seat fields, unsupported action-key rejection, and releasing a pending claim.

The focused character (4), floor (6), and private furniture (6) regression suites also passed, alongside TypeScript and JavaScript syntax checks. Seat screenshots are written outside the repository in the test output directories; paid model files remain private. These renderer fixtures do not substitute for the separate API concurrency/authorization tests or the wrapper's serialized transport tests.
