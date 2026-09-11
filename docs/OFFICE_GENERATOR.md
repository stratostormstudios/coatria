# Assisted office generator

Implementation and local verification: 11 September 2026. This document describes the pure layout generator and its geometry checks; it does not establish deployment status.

`src/lib/office-generator.ts` creates editable furniture layouts using the licensed office catalog. It makes no network requests and performs no server writes. The caller previews the result, replaces the local editor draft only after the user chooses it, and uses the existing revision-checked floor save to publish it. Generating a preview does not create audio rooms, assign workstations to employees, purchase assets, or change room permissions.

## API

```ts
import {generateOffice, OfficeGenerationError} from '@/lib/office-generator';

const preset = generateOffice({
  deskCount: 24,
  roomCount: 3,
  style: 'courtyard',
  spaciousness: 'airy',
  seed: 'Coatria',
});
```

| Option | Accepted values | Meaning |
| --- | --- | --- |
| `deskCount` | Whole number, 1–60 | Exactly this many individual desk-and-chair pairs. |
| `roomCount` | Whole number, 0–8 | Exactly this many furnished, two-seat meeting nooks with three low dividers and an open entry. |
| `style` | `courtyard`, `neighborhoods`, `gallery` | Changes grid proportions, shared-space placement, team arrangement and meeting-nook orientation. |
| `spaciousness` | `balanced`, `airy` | Sets desk pitch and inter-bay spacing. Airy is the recommended default. |
| `seed` | Nonempty string up to 64 characters, or safe integer | Reproduces cell choices, furniture palettes, finishes and names. The full options object contributes to the deterministic seed. |

The result is `GeneratedOffice`, compatible with `OfficePreset`. It contains `floor`, percentage-based `layout`, `workstations`, `zones`, `spawn` and `aisles`, plus a copied `options` object, `summary`, `warnings` and `spatialRooms`. Every call returns independent arrays and objects, so editing a draft cannot alter a later generated result. No global random source, clock, browser API or environment-dependent state affects generation.

`OfficeGenerationError` exposes `code`, `message` and `issues: {field, message}[]`. Invalid counts are rejected rather than rounded or reduced. `CAPACITY_EXCEEDED` and `FLOOR_TOO_LARGE` protect the hard limits if the generator's required modules or limits change. All combinations currently accepted by the options contract fit; the caller should still handle these errors without discarding its existing draft.

IDs include a deterministic option hash and a local object or station suffix. Their purpose is stable preview and draft references, not authorization, a globally unique identifier, or a collision-resistant content signature. Saving the entire replacement layout remains a company-scoped operation.

## Layout rules and limits

Work bays hold up to six people in two opposing rows. Counts are distributed across bays so a final bay does not hold a single worker while every other bay is full. Each station has its own desk and calibrated task chair, a standing approach behind that chair, and a facing direction toward the desk. Workstation chairs are restricted to `office-chair-001`, `office-chair-009` and `office-chair-012`.

Furniture keeps its catalog width and depth. Quarter-turn rotations swap those physical dimensions. Only assets explicitly marked `resize: 'footprint'`—floor finishes and divider panels—receive independent footprint dimensions; their authored source height remains intact. Floor finishes use a nominal 0.001 m catalog height, while the purchased surfaces can be effectively planar. All objects reference public catalog metadata. The generator contains no purchased mesh, texture or preview bytes.

Each meeting nook uses seven objects: three low divider panels, two calibrated `office-chair-006` visitor chairs, a coffee table and a non-collidable floor finish. The 5.4 m wide nooks leave a passage behind both visitor chairs for their runtime seating approaches, including collision padding. The panels form a U, with an entry at least 5.1 m wide. Openings face an adjacent circulation lane. These are spatial furniture arrangements, with neither acoustic isolation nor private access controls. `spatialRooms` records the zone ID, external entry point, entry width and the three divider IDs so previews and tests can inspect the opening explicitly.

The floor is automatically sized within 8–40 m per side. A bay is 5.8 × 5.6 m; the layout uses a bounded search over rectangular grids with up to five rows and five columns. Neighborhood and gallery plans reserve a shared-space bay at four required modules; courtyard plans reserve their central bay at six. Gallery layouts add a 1.2 m wider horizontal promenade. Smaller courtyard requests use compact rectangular arrangements: 12 desks and two nooks occupy 16.5 × 16.1 m rather than forcing a three-by-three grid. Their description does not promise a dedicated central court.

| Spacing measurement | Balanced | Airy |
| --- | ---: | ---: |
| Desk centre pitch within a three-person row | 1.72 m | 1.90 m |
| Physical gap between adjacent bays | 1.50 m | 1.90 m |
| Declared interior clear navigation band after conservative padding | 0.70 m | 1.10 m |
| Narrowest declared perimeter navigation band | 0.65 m | 0.65 m |

The declared bands already leave room for the renderer's 0.3 m furniture padding and 0.45 m floor-edge restriction; they are avatar-centre navigation regions. They are not a building-code or accessibility certification. `summary.clearAisleWidthM` reports the narrowest declared band, including the perimeter. `summary.mainAisleWidthM` reports the inter-bay band. The physical corridors are wider than either navigation measurement.

The hard limit remains **180 layout objects**. Required furniture is placed before decoration:

1. Two objects per requested workstation.
2. Seven objects per requested meeting nook.
3. Shared lounge furniture, planting and team floor finishes as space and the remaining budget allow.

At 60 desks and eight nooks, the required furniture consumes 176 objects. A basic shared lounge uses the remaining four. Other optional decoration is omitted with a visible warning; the requested desk and nook counts remain exact. Smaller plans use more shared furniture and finishes when space permits. Room-count and balanced-spacing disclosures are returned in `warnings` rather than hidden in implementation comments.

## Curated starting points

`OFFICE_GENERATOR_PRESETS` contains option definitions, not static image layouts. Call `generateOffice(definition.options)` and use the definition's name and description in the chooser.

| Preset | Desks | Meeting nooks | Style | Floor | Objects |
| --- | ---: | ---: | --- | --- | ---: |
| Canopy Court | 24 | 3 | Airy courtyard | 24.2 × 23.6 m | 85 |
| Makers’ Quarter | 36 | 4 | Airy neighborhoods | 31.9 × 23.6 m | 118 |
| Northlight Gallery | 18 | 2 | Airy gallery | 24.2 × 17.3 m | 59 |
| Pocket Studio | 6 | 1 | Balanced neighborhoods | 16.1 × 8.6 m | 20 |

The courtyard reserves its central bay for a planted social area. Neighborhoods group adjacent work bays and place meeting nooks around the perimeter. The gallery separates work bays and meeting areas along an elongated promenade. The smaller studio contains a work bay and an open meeting nook; it does not claim a separate lounge.

The generator is intentionally an assisted first layout. Users can move, resize, rotate or remove furniture in the editor after applying it. Circulation checks apply to the generated result, not arbitrary subsequent edits. Supported chairs in generated layouts already participate in shared seating through `getOfficeSeats(layout, floor)`. Workstation assignment metadata remains descriptive; generating a layout does not assign a desk to an employee. The normal generated floor payload is still `{layout, floor, revision}`.

## Verification

Run `node --import tsx --test tests/office-generator.test.ts` with the installed project dependencies. The focused suite verifies:

- All 3,240 combinations of 1–60 desks, 0–8 nooks, three styles and two spacing levels meet the floor and object limits without reducing counts.
- 120 representative seeded plans pass the actual floor-write schema, keep uniform asset dimensions, contain no overlapping solid furniture footprints, and leave station approaches, nook entries, meeting points and declared aisle bands clear.
- 48 seeded plans plus the four curated presets connect every station and shared zone to the entrance on a conservative four-neighbor grid at the renderer's 0.38 m sampling, with segment collision tests and the renderer's padding.
- Every workstation references a distinct desk and an approved task chair, with its seat at the chair centre, its facing direction toward the desk, and its walkable approach behind the chair.
- The shared `getOfficeSeats` helper independently resolves every generated workstation chair and both visitor chairs in every nook. Its runtime approaches remain clear and connected under renderer collision padding across 48 representative seeded plans.
- Input errors, deterministic replay, independent mutable outputs, style differences, budget disclosures and exact maximum-capacity counts.

These are deterministic geometry tests. They do not measure rendering speed, GPU memory, live multiplayer capacity, physical ergonomics, legal building compliance or the operation of audio rooms. Browser preview, editor undo/save integration and production rollout require their own checks.
