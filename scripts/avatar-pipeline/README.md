# Local avatar pipeline

These scripts contain conversion code only. Supply your own licensed ITHappy City Characters v1.3 source. Never add the purchased `.blend`, ZIPs, textures, GLBs, generated portraits, or resized texture cache to public Git. The exporter and portrait renderer refuse unignored destinations inside a Git checkout. They make no network requests and use no AI processing.

Requires Blender 5.2 (tested with 5.2.0 LTS) and Python 3.11+ for the standalone auditor. Blender provides its own Python; no pip packages are required. Run from the repository root with `blender`, `python`, and `git` on PATH; `--git-command` can name the Git executable explicitly. Add `--python-exit-code 1` so automation fails on Blender script errors.

```sh
python scripts/avatar-pipeline/audit.py --source-zip "/private/City_Characters_glb.zip" --report "/private/audit/archive.json"

blender --background --factory-startup --disable-autoexec --python-exit-code 1 --python scripts/avatar-pipeline/export.py -- --blend "/private/City_Characters_v1.3.blend" --output-dir .runtime-assets/city-characters --audit-dir .runtime-assets/avatar-pipeline-audit

python scripts/avatar-pipeline/audit.py --models .runtime-assets/city-characters --report .runtime-assets/avatar-pipeline-audit/validation.json

blender --background --factory-startup --disable-autoexec --python-exit-code 1 --python scripts/avatar-pipeline/portraits.py -- --models .runtime-assets/city-characters --output-dir .runtime-assets/city-characters
```

The archive auditor reads ZIP entries without extracting them. The exporter opens the purchased `.blend` with script execution disabled and never saves it. `--ids city-023` exports a subset for a quick verification. Default output includes 12 curated models. Existing output for selected IDs is replaced; use a new private output directory to compare versions. Other files are not deleted automatically.

Each runtime model uses one merged skinned mesh, 44 joints, original authored weights with the standard four-influence export limit, and embedded textures. The shared color palette is 256×256; city-157 retains a 512×512 fabric texture. Different clothing/glass materials remain separate when needed. Geometry keeps its original polygon count. Material appearance should be checked in the application after any exporter or lighting change.

The canonical clips are `Idle`, `Walk`, `Run`, `Sit`, `Wave`, and `Dance`. Idle/sit/wave/dance use the supplied adult, plus-size, or senior family clips. All use authored `Adult_Walk` and `Adult_Run` on the compatible 44-joint rig, avoiding accelerated senior shuffle motion. Root translation remains in place and hip sway remains animated. Small terminal hand/finger/arm rotation differences are blended over the last six samples; the audit records each correction. All imported source actions and optional clips are licensed asset content and remain inside the private derivatives.

The contract is Y-up, facing +Z, `forwardRotation: 0`, `walkSpeed: 0.9505`, `runSpeed: 3.6093` in exported model units per second. Pace is an estimate measured from backward foot travel during the lowest 30% of ankle height at 30 fps. Multiply by model scale before choosing runtime animation playback rate. Preserve hip translation when normalizing clips.

The auditor checks self-contained buffers/images, 44 joints, all six clips, finite animation values, retained hip translation, stationary root, loop endpoints, and the 4 MiB per-model budget. It reports SHA256, triangles, draw primitives, textures, and durations. It does not replace visual review, licensing review, or device performance measurements. Inspect idle/walk/run blends, wave/dance playback, calibrated seated poses, feet, direction, skeleton cloning, and teardown in the browser before release. Exporter updates may change byte hashes; compare the structural audit and rendered result.

Paid files are served through authenticated model/portrait routes and included only in the private deployment bundle. A valid purchase and applicable commercial platform license are required; the public scripts grant no asset rights. Keep employee-created assets, marketplace transfers, and any AI input/training use outside this asset license unless separately authorized by its owner.
