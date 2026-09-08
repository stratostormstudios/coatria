"""Local glTF inspection and small loop corrections. Contains no licensed asset data."""
import collections
import hashlib
import json
import math
import struct
import pathlib
import shutil
import subprocess


def ensure_private_output(path, git_command='git'):
    """Refuse paid output in a Git checkout unless Git confirms the destination is ignored."""
    path = pathlib.Path(path).resolve()
    repository = next((p for p in [path, *path.parents] if (p / '.git').exists()), None)
    if repository:
        command = shutil.which(git_command) or git_command
        result = subprocess.run([command, '-C', str(repository), 'check-ignore', '--quiet', '--',
                                 str((path / 'paid-asset-output.glb').relative_to(repository))], check=False)
        assert result.returncode == 0, 'Paid asset output must be gitignored; use .runtime-assets or a directory outside Git'
    path.mkdir(parents=True, exist_ok=True)
    return path


def decode_glb(raw):
    magic, version, length = struct.unpack_from('<4sII', raw)
    assert magic == b'glTF' and version == 2 and length == len(raw), 'Invalid GLB'
    length, kind = struct.unpack_from('<I4s', raw, 12)
    assert kind == b'JSON', 'Missing JSON chunk'
    return json.loads(raw[20:20 + length]), 28 + length


def accessor(document, raw, index, binary_start):
    item = document['accessors'][index]
    view = document['bufferViews'][item['bufferView']]
    component = {5126: 'f', 5125: 'I', 5123: 'H', 5121: 'B', 5122: 'h', 5120: 'b'}[item['componentType']]
    count = {'SCALAR': 1, 'VEC2': 2, 'VEC3': 3, 'VEC4': 4, 'MAT4': 16}[item['type']]
    fmt = '<' + component * count
    stride = view.get('byteStride', struct.calcsize(fmt))
    start = binary_start + view.get('byteOffset', 0) + item.get('byteOffset', 0)
    return [struct.unpack_from(fmt, raw, start + i * stride) for i in range(item['count'])]


def normalize(q):
    length = math.sqrt(sum(x * x for x in q))
    assert length > 0, 'Invalid quaternion'
    return [x / length for x in q]


def quaternion_error(a, b):
    dot = abs(sum(x * y for x, y in zip(normalize(a), normalize(b))))
    return 2 * math.acos(min(1, dot))


def slerp(a, b, amount):
    a, b = normalize(a), normalize(b)
    dot = sum(x * y for x, y in zip(a, b))
    if dot < 0:
        b = [-x for x in b]
        dot = -dot
    if dot > .9995:
        return normalize([x + (y - x) * amount for x, y in zip(a, b)])
    angle = math.acos(min(1, dot))
    return [(x * math.sin((1 - amount) * angle) + y * math.sin(amount * angle)) / math.sin(angle)
            for x, y in zip(a, b)]


def close_loop_seams(path):
    """Blend terminal authored rotation differences over six samples; preserve translations."""
    raw = bytearray(path.read_bytes())
    document, binary_start = decode_glb(raw)
    references = collections.Counter(s['output'] for a in document['animations'] for s in a['samplers'])
    corrections = []
    for animation in document['animations']:
        for channel in animation['channels']:
            if channel['target']['path'] != 'rotation':
                continue
            sampler = animation['samplers'][channel['sampler']]
            item = document['accessors'][sampler['output']]
            assert item['componentType'] == 5126 and item['type'] == 'VEC4'
            values = accessor(document, raw, sampler['output'], binary_start)
            error = quaternion_error(values[0], values[-1])
            if error <= .001:
                continue
            assert references[sampler['output']] == 1, 'Shared animated accessor requires manual review'
            view = document['bufferViews'][item['bufferView']]
            start = binary_start + view.get('byteOffset', 0) + item.get('byteOffset', 0)
            stride = view.get('byteStride', 16)
            count = len(values)
            steps = min(6, count - 1)
            for index in range(count - steps, count):
                amount = (index - (count - steps) + 1) / steps
                amount = amount * amount * (3 - 2 * amount)
                struct.pack_into('<4f', raw, start + index * stride, *slerp(values[index], values[0], amount))
            corrections.append({'clip': animation['name'], 'bone': document['nodes'][channel['target']['node']]['name'],
                                'originalEndpointAngleRadians': error, 'blendSamples': steps})
    path.write_bytes(raw)
    return corrections


def inspect_glb(raw, require_runtime=False):
    document, binary_start = decode_glb(raw)
    assert all('uri' not in b for b in document.get('buffers', [])), 'External buffer'
    assert all('uri' not in i and 'bufferView' in i for i in document.get('images', [])), 'External image'
    primitives = [p for mesh in document.get('meshes', []) for p in mesh['primitives']]
    assert all(p.get('mode', 4) == 4 for p in primitives), 'Expected triangle primitives'
    triangles = sum(document['accessors'][p['indices']]['count'] // 3 for p in primitives)
    images = []
    for image in document.get('images', []):
        view = document['bufferViews'][image['bufferView']]
        start = binary_start + view.get('byteOffset', 0)
        data = raw[start:start + view['byteLength']]
        images.append({'bytes': len(data), 'mimeType': image['mimeType'],
                       'size': list(struct.unpack('>II', data[16:24])) if data[:8] == b'\x89PNG\r\n\x1a\n' else None})
    animations = []
    for animation in document.get('animations', []):
        duration = rotation_error = translation_error = root_range = 0
        hip_channels = 0
        for channel in animation['channels']:
            sampler = animation['samplers'][channel['sampler']]
            values = accessor(document, raw, sampler['output'], binary_start)
            times = accessor(document, raw, sampler['input'], binary_start)
            assert all(math.isfinite(x) for v in values for x in v), 'Nonfinite animation'
            duration = max(duration, times[-1][0] - times[0][0])
            node = document['nodes'][channel['target']['node']].get('name')
            kind = channel['target']['path']
            if kind == 'rotation':
                rotation_error = max(rotation_error, quaternion_error(values[0], values[-1]))
            if kind == 'translation':
                translation_error = max(translation_error, math.dist(values[0], values[-1]))
                hip_channels += node == 'Hips'
                if node == 'Root':
                    root_range = max(root_range, max(math.dist(values[0], v) for v in values))
        animations.append({'name': animation['name'], 'duration': duration, 'channels': len(animation['channels']),
                           'endpointRotationErrorRad': rotation_error, 'endpointTranslationError': translation_error,
                           'hipsTranslationChannels': hip_channels, 'rootTranslationRange': root_range})
    joints = [len(s['joints']) for s in document.get('skins', [])]
    if require_runtime:
        assert len(raw) <= 4 * 1024 * 1024, 'Model exceeds 4 MiB budget'
        assert joints == [44], 'Unexpected character skeleton'
        assert {a['name'] for a in animations} == {'Idle', 'Walk', 'Sit', 'Wave'}, 'Missing runtime clips'
        assert all(a['hipsTranslationChannels'] == 1 and a['rootTranslationRange'] < .001 for a in animations)
        assert all(a['endpointRotationErrorRad'] < .03 and a['endpointTranslationError'] < .005 for a in animations)
    return {'bytes': len(raw), 'sha256': hashlib.sha256(raw).hexdigest(), 'triangles': triangles,
            'meshes': len(document.get('meshes', [])), 'primitives': len(primitives),
            'materials': [m.get('name') for m in document.get('materials', [])],
            'joints': joints, 'images': images, 'animations': animations}
