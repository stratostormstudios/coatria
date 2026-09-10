# The 50-person studio

The `OFFICE_50_PRESET` in `src/lib/office-presets.ts` furnishes a **30 × 20 m floor** with **50 distinct workstations**. Each workstation has its own purchased desk model and task-chair model, an individual label, a standing approach point, and a chair position. This is a furniture and navigation preset; its station records are not employee assignments.

Five neighborhoods of ten stations occupy five bays in a three-column, two-row arrangement. The sixth bay is an open project lounge. A welcome lounge, two smaller conversation groups in the commons, and a quiet lounge occupy the south side. Floor finishes distinguish areas without erecting tall walls that would obstruct the office view.

```text
NORTH
┌─────────────────────────────────────────────────────────┐
│ Atelier · 10      Studio · 10       Product · 10         │
│ 01–10             11–20             21–30                │
│                                                         │
│            continuous cross aisle                       │
│                                                         │
│ Engineering · 10 Operations · 10  Project lounge · 8     │
│ 31–40             41–50             open meeting area    │
│                                                         │
│            continuous south cross aisle                 │
│                                                         │
│ Welcome lounge   Commons / entrance   Quiet lounge      │
└─────────────────────────────────────────────────────────┘
SOUTH
```

## Furniture inventory

The preset contains **148 objects using 25 distinct catalog assets**. It fits the bounded 180-object editor limit with 32 spare placements.

| Category | Objects | Purpose |
| --- | ---: | --- |
| Desks | 50 | One per workstation |
| Seating | 64 | 50 task chairs and 14 shared chairs/sofas |
| Tables | 6 | Shared lounge and conversation tables |
| Storage | 7 | Shared cabinets and shelves |
| Plants | 8 | Shared-area planting |
| Lighting | 2 | Reading lamps |
| Architecture | 11 | 9 walkable floor finishes and 2 low dividers |

The 14 shared seating objects include sofas. Shared-zone capacity metadata describes the intended arrangement, not a count of independent chair models or an enforced call capacity. There are 139 solid objects and nine non-collidable finishes. Uniform furniture retains its catalog dimensions; only floor finishes and low dividers use independent footprint sizing.

## Coordinates and interaction

`layout` uses the existing percentage-based `LayoutItem` contract. Rotation is a quarter turn, and `w`/`h` already describe the rotated axis-aligned footprint. The preset uses allowlisted `assetId` references and contains no model, texture, or preview bytes.

`workstations` provides:

- `id`, `label`, and `zoneId` for stable identification.
- `deskId` and `chairId` referencing exactly one placed model each.
- `approach`, a reachable standing position suitable for navigation and a test participant's starting position.
- `seat`, the center of the chair model. It lies inside the chair obstacle and must not be used as an ordinary walking target.
- `facing`, a radian angle with +Z forward, directed from the chair toward the desk.

`approach`, `seat`, `spawn`, and zone `meetingPoint` coordinates are centered renderer metres: floor `(0, 0)` at its top-left converts to world `(-15, -10)`. Zone and aisle `bounds` use top-left floor metres. Zone bounds describe the visible arrangement; meeting points can sit at its open edge.

The entrance is at floor `(15, 18.8)` / world `(0, 8.8)`. Each ten-station neighborhood has two rows of five inward-facing desks, with chairs on the outer edges. Standing approach lanes remain behind those chairs. Two vertical circulation paths connect the north, middle, and south cross aisles to the entrance.

## Verification and limits

`tests/office-presets.test.ts` verifies the complete floor write against the application schema, exact station counts, unique IDs, catalog references, native furniture dimensions, floor containment, and absence of overlapping solid footprints. It checks all 50 approach points, the entrance, and every zone meeting point against the renderer's 0.3 m obstacle padding and 0.45 m perimeter margin.

The declared aisle rectangles describe clear positions for an avatar's center **after** obstacle padding. Their narrowest dimension is at least 0.6 m. A conservative four-neighbor occupancy test uses the renderer's approximately 0.38 m grid, including segment checks, and proves connectivity from the entrance to all 50 approaches and every shared-zone meeting point.

These checks establish usable virtual geometry. They do not certify physical-building accessibility, evacuation rules, automatic seated animation, reservation/assignment behavior, server capacity, or a 50-person audio/video call. The metadata does not create authenticated meeting-room records or grant room access. Renderer and presence performance with 50 simultaneous participants require their separate benchmark and integration checks.
