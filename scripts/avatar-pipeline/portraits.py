"""Render private profile portraits from exported GLBs using Blender; no online processing."""
import argparse
import bpy
import pathlib
import sys
from mathutils import Vector
sys.path.insert(0, str(pathlib.Path(__file__).resolve().parent))
from gltf_tools import ensure_private_output

parser = argparse.ArgumentParser()
parser.add_argument('--models', type=pathlib.Path, required=True)
parser.add_argument('--output-dir', type=pathlib.Path, required=True)
parser.add_argument('--git-command', default='git')
args = parser.parse_args(sys.argv[sys.argv.index('--') + 1:] if '--' in sys.argv else [])
output = ensure_private_output(args.output_dir, args.git_command)
models = sorted(args.models.glob('city-*.glb'))
assert models, 'No exported GLBs found'
bpy.data.batch_remove(list(bpy.data.objects))
scene = bpy.context.scene
scene.render.fps = 30
world = bpy.data.worlds.new('PortraitWorld')
scene.world = world
world.use_nodes = True
world.node_tree.nodes['Background'].inputs['Color'].default_value = (.55, .6, .7, 1)
world.node_tree.nodes['Background'].inputs['Strength'].default_value = .6
for name, location, energy, size in [('Key', (3, -4, 5), 550, 4), ('Fill', (-3, -2, 3), 300, 3), ('Rim', (1, 3, 4), 400, 3)]:
    data = bpy.data.lights.new(name, 'AREA')
    data.energy, data.size = energy, size
    obj = bpy.data.objects.new(name, data)
    scene.collection.objects.link(obj)
    obj.location = location
    obj.rotation_euler = (Vector((0, 0, .9)) - obj.location).to_track_quat('-Z', 'Y').to_euler()
data = bpy.data.cameras.new('PortraitCamera')
camera = bpy.data.objects.new('PortraitCamera', data)
scene.collection.objects.link(camera)
scene.camera = camera
camera.location = (2.8, -6, 2.5)
camera.rotation_euler = (Vector((0, 0, .9)) - camera.location).to_track_quat('-Z', 'Y').to_euler()
data.type, data.ortho_scale = 'ORTHO', 2.28
scene.render.engine = 'CYCLES'
scene.cycles.samples = 16
scene.cycles.use_denoising = True
scene.render.resolution_x, scene.render.resolution_y = 160, 200
scene.render.resolution_percentage = 100
scene.render.film_transparent = True
scene.render.image_settings.media_type = 'IMAGE'
scene.render.image_settings.file_format = 'PNG'
scene.render.image_settings.color_mode = 'RGBA'
scene.view_settings.view_transform = 'AgX'
for path in models:
    before, actions = set(bpy.data.objects), set(bpy.data.actions)
    bpy.ops.import_scene.gltf(filepath=str(path.resolve()))
    loaded = set(bpy.data.objects) - before
    rig = next(o for o in loaded if o.type == 'ARMATURE')
    for track in rig.animation_data.nla_tracks:
        track.mute = True
    idle = next(a for a in set(bpy.data.actions) - actions if a.name.startswith('Idle'))
    rig.animation_data.action, rig.animation_data.action_slot = idle, idle.slots[0]
    scene.frame_set(int(idle.frame_range[0]))
    scene.render.filepath = str(output / (path.stem + '.png'))
    bpy.ops.render.render(write_still=True)
    bpy.data.batch_remove(list(loaded))
print('Rendered ' + str(len(models)) + ' private portraits')
