# Coatria office furniture collection

The editor and 3D office use 78 curated objects from the operator's purchased ITHappy Office Rooms pack. They include 16 desks, 22 seats, eight tables, 12 storage pieces, six floor lamps, five partitions, five floor finishes and four composed potted plants. The original archives, Blender source and textures remain outside the repository and are unchanged.

## Using the collection

Open **The office → Edit space**. Search or filter the furniture collection, then drag a card onto the floor or click it to place it near the centre. Cards show actual model previews and authored dimensions. The plan uses separate top-down previews. Select a placed object to move, rotate, duplicate, resize or remove it; **Reset to original size** restores its authored footprint. Changes become shared only after **Save shared floor plan** succeeds.

Furniture scales proportionally in all three dimensions, including when using edge handles or exact width/depth fields. Partitions and floor finishes allow independent width/depth changes while retaining their authored height. This keeps chairs and desks from becoming stretched shapes. Floor finishes are walkable and render beneath furniture. Thin partitions keep their native footprint. Existing procedural workstations, meeting spaces, focus spaces, lounges and plants remain available under **Quick spaces**; existing saved offices are preserved.

Catalogue images load with four requests at a time per preview kind. Filtering prioritizes the visible selection. Models load only when needed, with three concurrent unique downloads, shared geometry/textures and a bounded idle cache. Temporary failures expose retry controls. Unmounting or changing accounts aborts pending work and releases resources.

## Private deployment files

Every ID in `src/lib/office-catalog.ts` requires three files:

```text
.runtime-assets/office-models/office-desk-001.glb
.runtime-assets/office-models/office-desk-001.png
.runtime-assets/office-models/office-desk-001.plan.png
```

The directory is ignored by Git and supplied privately with the licensed Vercel upload. Never put the source archive, models, textures or generated previews in the public repository or under `public/`. The repository does not confer a license to the commercial pack. The pack is not sent to generative AI services.

Authenticated, exact-ID endpoints serve the three runtime files. They reject cross-site and stale-account requests, validate the file structure, enforce byte budgets and return private/no-store responses. Models embed their textures and cannot reference external resource URLs. Browsers necessarily receive model bytes to render them; these controls are access restrictions, not copy protection.

The build requires all 78 models and both preview kinds on Vercel. A source-only checkout can build without licensed files for CI, but cannot substitute for a complete licensed deployment. Next.js explicitly traces the private files into the corresponding server routes. No production database migration, credential change or extra runtime grant is required.

## Reproducible preparation

Extract the purchased separate-GLB archive outside the repository, then run:

```powershell
node scripts/prepare-office-assets.mjs "C:/path/to/Separate_assets_glb"
$env:COATRIA_BROWSER_PATH = "C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe"
node scripts/render-office-previews.mjs
$env:COATRIA_REQUIRE_OFFICE_ASSETS = "1"
node --import tsx scripts/check-office-assets.ts
```

`scripts/office-models.selection.json` records the reviewed source files, composition transforms and measured dimensions. Preparation normalizes the source coordinate system, centres the footprint and grounds each model at zero height. It rejects rigs, animations and external references; this pipeline is for static furniture. Plants combine reviewed pot and leaf objects. Rendering verifies measured geometry against the catalogue before producing isometric and top-down images locally.

To add another object, review its source geometry/materials and performance, add a stable recipe and catalogue definition, regenerate files, verify its dimensions and interactions, and deploy the private bundle. Do not rename an ID already used by a saved floor.

## Measurements and limits

The 78 GLBs contain 31,339 triangles in total and occupy 3,579,948 bytes. The largest single object has 5,384 triangles. Models and both preview sets together occupy approximately 5.0 MiB. These measurements describe asset size, not a multi-user capacity or device frame-rate benchmark.

The current floor remains rectangular, 8–40 metres per axis and limited to 100 placed items. Furniture does not create conversation rooms, grant permissions or automatically assign seats. This release does not add hinged doors, freeform wall construction, automatic sitting, multi-storey buildings or arbitrary model uploads. Uniformly enlarging a desk also enlarges its height; the inspector explains the proportional behavior.

Saved asset items use `type: "asset"` and an allowlisted `assetId` in the existing version 1 floor document. A rollback must understand both version 1 documents and purchased-asset items. An earlier editor that does not recognize asset items is not a compatible rollback target once they have been saved.

## Verification

The local complete Node suite passed 66 of 70 tests with zero failures; four PostgreSQL-specific concurrency/role checks require CI. Browser verification passed 11 isolated furniture-editor cases, the real local database save–reload–3D case, all 15 legacy floor-editor cases, six purchased-model renderer cases and 10 existing renderer/character regressions. Independent checks also verified filtered preview prioritization and revisiting dropped requests. The licensed production build verified all 12 characters and 78 office objects. Release-specific CI, deployment and live results are recorded in [release status](RELEASE_STATUS.md).
