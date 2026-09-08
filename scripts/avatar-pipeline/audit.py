"""Inspect a purchased archive without extraction, or validate locally exported runtime GLBs."""
import argparse
import collections
import json
import pathlib
import zipfile
from gltf_tools import decode_glb, inspect_glb

parser = argparse.ArgumentParser()
parser.add_argument('--source-zip', type=pathlib.Path)
parser.add_argument('--models', type=pathlib.Path)
parser.add_argument('--report', type=pathlib.Path, required=True)
args = parser.parse_args()
assert args.source_zip or args.models, 'Provide --source-zip and/or --models'
report = {}
if args.source_zip:
    with zipfile.ZipFile(args.source_zip) as archive:
        entries = archive.infolist()
        models = []
        for entry in entries:
            if '/300_Characters/' not in entry.filename or not entry.filename.endswith('.glb'):
                continue
            raw = archive.read(entry)
            document, _ = decode_glb(raw)
            item = inspect_glb(raw)
            item['file'] = pathlib.PurePosixPath(entry.filename).name
            item['jointNames'] = [[document['nodes'][i].get('name') for i in skin['joints']] for skin in document.get('skins', [])]
            models.append(item)
        report['source'] = {'entries': len(entries), 'uncompressedBytes': sum(e.file_size for e in entries),
                            'characters': models, 'animatedCharacters': sum(bool(m['animations']) for m in models)}
if args.models:
    models = [{'id': p.stem, **inspect_glb(p.read_bytes(), require_runtime=True)} for p in sorted(args.models.glob('city-*.glb'))]
    assert models, 'No runtime GLBs found'
    report['runtime'] = {'models': models, 'totalBytes': sum(m['bytes'] for m in models)}
args.report.parent.mkdir(parents=True, exist_ok=True)
args.report.write_text(json.dumps(report, indent=2))
print(json.dumps({'sourceCharacters': len(report.get('source', {}).get('characters', [])),
                  'runtimeModels': len(report.get('runtime', {}).get('models', [])),
                  'runtimeBytes': report.get('runtime', {}).get('totalBytes', 0)}))
