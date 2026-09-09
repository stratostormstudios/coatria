# Coatria floor design studio

The space editor supports direct mouse, touch-pointer and keyboard manipulation. Administrators can arrange the shared office without editing percentage coordinates. The public 3D office uses the saved floor dimensions, furniture sizes, positions and quarter-turn rotations.

## Editing a floor

- Drag a workstation, meeting space, focus space, lounge or plant from the library onto the floor. A preview shows its drop position. Clicking a library item adds it near the centre instead.
- Drag an object to move it. Select it to reveal eight resize handles; edges change one axis and corners change both. Items stay within the floor.
- Drag the floor's right edge, bottom edge or bottom-right corner to change its dimensions. Exact floor width/depth and object position/size fields use metres. Numeric changes commit on Enter or leaving the field; Escape cancels an unfinished numeric edit.
- The floor ranges from 8 to 40 metres on each side. Resizing it preserves the furniture's physical dimensions and its distance from the top-left corner. Furniture near an edge limits how far the floor can shrink. Very small legacy objects can limit enlargement to preserve their size within the storage format; the properties panel explains that limit.
- The 0.5 metre grid can snap placement, movement and resizing. Hold Alt while dragging to bypass snapping, or turn the grid snap off.
- Rotate a selected object in 90° increments, duplicate it, or remove it. A rotation that cannot fit the floor is refused instead of silently shrinking the object. Overlaps remain possible so people can deliberately compose zones and furnishings.
- Undo/redo groups a complete drag into one change. The last 60 changes are available in the current editor session. Reloading or loading a teammate's saved plan clears this local history.
- Zoom from 50% to 300%, use Fit floor, and pan with the hand tool or Space + drag. On phones the library and properties stack around a scrollable canvas.

Changes are a draft until **Save shared floor plan** succeeds. Leaving with a draft asks whether to discard it. A save in progress does not erase edits made after that save began. Drafts are held in memory; there is no cross-reload or offline draft store.

## Keyboard alternatives

| Action | Control |
| --- | --- |
| Select an object | Tab to its named button, then Enter/Space |
| Move selected object | Arrow keys: 0.1 m; Shift + arrows: 1 m |
| Resize | Focus a resize handle and use arrows, or edit the dimension fields |
| Rotate | R, or the Rotate button |
| Duplicate | Ctrl/Command + D, or Duplicate |
| Remove | Delete/Backspace, or Remove |
| Undo / redo | Ctrl/Command + Z / Shift + Z, or toolbar buttons |
| Save | Ctrl/Command + S, or Save shared floor plan |
| Cancel a drag | Escape |

Editor shortcuts leave text and numeric entry controls alone. Pointer capture keeps an active gesture attached to its original control even when the pointer crosses other elements. Browser pointer cancellation or window focus loss rolls an unfinished drag back. Implementation follows the [MDN Pointer Events guidance](https://developer.mozilla.org/en-US/docs/Web/API/Pointer_events) and [pointer capture API](https://developer.mozilla.org/en-US/docs/Web/API/Element/setPointerCapture).

## Shared saves and compatibility

The workspace API continues to return the furniture array as `layout`. It also returns `floor: {width, depth}` and `layoutRevision`. The editor submits `{layout, floor, revision}`. The server locks the company record, rechecks administrator access, compares the revision and saves the entire document atomically. A stale writer gets HTTP 409 with `LAYOUT_CONFLICT`; its draft stays on screen. Both **Reload saved layout** and **Keep my draft** fetch the latest authorized version before resolving the conflict. A subsequent concurrent edit can still require another decision.

The existing `companies.layout` JSONB field stores a versioned document: `{version: 1, items, floor, revision}`. Legacy arrays are read as a 20 × 16 metre floor at revision 0 and remain intact until successfully saved. New companies use the versioned document. This requires no SQL migration or broader runtime permissions. Unknown stored versions fail explicitly rather than replacing the office with an empty layout. Old editor tabs without a revision receive a reload error.

**Rollback requirement:** once a versioned plan has been saved, use an application build that understands both legacy arrays and version 1 documents. Promoting an older build that assumes the JSONB field is always an array is not a compatible rollback. Preserve the document data when preparing any later migration.

## 3D behavior and limits

The floor slab, exterior, picking surface, camera framing, shadows and walking grid adapt to the saved dimensions. Each furniture group—including its chairs—fits the saved axis-aligned footprint. Quarter-turn rotation transforms its meshes, picking regions and collision boundaries together. Existing presence positions are clamped to the new usable floor. Straight movement segments are checked against obstacles to avoid cutting through corners.

There are at most 100 objects on a rectangular floor. This release does not add freeform wall drawing, multi-storey buildings, automatic seating assignments, arbitrary angles, multi-selection or CAD export. Spatial furniture does not itself create room conversations or grant access.

## Verification

Release checks cover pointer placement, movement, edge/corner/floor resizing, physical dimension preservation, rotation limits, keyboard actions, cancellation, undo/redo, focused-field updates, delayed saves, stale revisions, authorization and mobile overflow. Renderer checks use 8 × 8, 20 × 16, 40 × 40, 8 × 40 and 32 × 12 metre floors, actual geometry bounds, camera framing, collision paths and character lifecycle regressions.

Local verification passed all 15 editor interaction cases, the real HTTP/database save–reload–3D case, six renderer cases, four character regressions, and 12 navigation/workplace/security regressions: 38 distinct browser cases across focused runs. The licensed production build and TypeScript passed. The local Node suite passed 55 of 59 tests with zero failures; all 59 subsequently passed with no skips in [PostgreSQL CI run 34319224150](https://github.com/stratostormstudios/coatria/actions/runs/34319224150). Sampled automated accessibility checks reported zero violations at 1536 × 1100 and 390 × 844 with no horizontal overflow. These checks do not establish full WCAG conformance. The release is live from source `72713f29466d5db255b068de6adf8e075888cdf5`, deployment `dpl_3NDfVX3eCQRuumw5p7wyPXE9FdJo`. The live CSP browser test, HTTPS/database readiness and published-editor fixture smoke test passed. Detailed results are recorded in [release status](RELEASE_STATUS.md). Local screenshots and accessibility results remain outside the public source tree in `C:/CODEX/Agent002/output/floor-editor/`. Purchased character files remain private and unchanged.
