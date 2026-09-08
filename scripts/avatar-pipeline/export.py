"""Export owned City Characters locally with Blender5.2; no asset data is distributed with this script."""
import argparse,bpy,json,pathlib,re,statistics,math,sys
from mathutils import Vector
sys.path.insert(0,str(pathlib.Path(__file__).resolve().parent))
from gltf_tools import ensure_private_output,close_loop_seams,inspect_glb

parser=argparse.ArgumentParser()
parser.add_argument('--blend',type=pathlib.Path,required=True)
parser.add_argument('--output-dir',type=pathlib.Path,required=True)
parser.add_argument('--audit-dir',type=pathlib.Path,required=True)
parser.add_argument('--git-command',default='git')
parser.add_argument('--ids',nargs='+',default=['city-023','city-024','city-025','city-026','city-027','city-028','city-100','city-119','city-140','city-145','city-157','city-171'])
args=parser.parse_args(sys.argv[sys.argv.index('--')+1:] if '--' in sys.argv else [])
allowed={23,24,25,26,27,28,100,119,140,145,157,171}
ids=[int(i.removeprefix('city-')) for i in args.ids]
assert set(ids)<=allowed and len(ids)==len(set(ids)),'Unknown or duplicate avatar ID'
assert args.blend.is_file(),'Purchased .blend file missing'
runtime=ensure_private_output(args.output_dir,args.git_command)
out=ensure_private_output(args.audit_dir,args.git_command)
assert runtime!=args.blend.resolve().parent,'Preserve the original source directory'
bpy.ops.wm.open_mainfile(filepath=str(args.blend.resolve()),use_scripts=False)
rigs=[next(o for o in bpy.data.objects if o.type=='ARMATURE' and re.match(r'^Skeleton_'+str(n)+r'(?:_|$)',o.name)) for n in ids]
keep=set(rigs)
for r in rigs:keep.update(r.children_recursive)
bpy.data.batch_remove([o for o in bpy.data.objects if o not in keep])
for c in bpy.data.collections:c.hide_render=False;c.hide_viewport=False
def unexclude(lc):
 lc.exclude=False;lc.hide_viewport=False
 for c in lc.children:unexclude(c)
unexclude(bpy.context.view_layer.layer_collection)
for o in keep:o.hide_viewport=False;o.hide_set(False)
palette=bpy.data.images['Textures_4.png'];palette.scale(256,256)
palette.filepath_raw=str(out/'runtime-palette.png');palette.file_format='PNG';palette.save()
runtime_palette=bpy.data.images.load(str(out/'runtime-palette.png'),check_existing=False)
fabric=bpy.data.images['Fabric_9.png'];fabric.scale(512,512);fabric.filepath_raw=str(out/'runtime-fabric.png');fabric.file_format='PNG';fabric.save()
runtime_fabric=bpy.data.images.load(str(out/'runtime-fabric.png'),check_existing=False)
for material in bpy.data.materials:
 if material.node_tree:
  for node in material.node_tree.nodes:
   if node.type=='TEX_IMAGE' and node.image==palette:node.image=runtime_palette
   if node.type=='TEX_IMAGE' and node.image==fabric:node.image=runtime_fabric
scene=bpy.context.scene;scene.render.fps=30
report=[]
for number,rig in zip(ids,rigs):
 ident=f'city-{number:03}';source=rig.name
 family='PlusSize' if any(c.name.startswith('PlusSize') for c in rig.children) else 'Senior' if any(c.name.startswith('Senior') for c in rig.children) else 'Adult'
 rig.location=(0,0,0);rig.animation_data_create();rig.animation_data.action=None
 for b in rig.pose.bones:b.matrix_basis.identity()
 scene.frame_set(0);bpy.context.view_layer.update()
 # Merge only meshes of this rig. Geometry, original weights, materials and authored normals survive.
 meshes=[o for o in rig.children_recursive if o.type=='MESH']
 bpy.ops.object.select_all(action='DESELECT')
 for m in meshes:m.select_set(True)
 bpy.context.view_layer.objects.active=meshes[0];bpy.ops.object.join()
 mesh=meshes[0];mesh.name=ident+'-mesh';rig.name=ident+'-rig'
 metrics={'id':ident,'source':source,'family':family,'actions':[],'walkSpeed':None,'forwardRotation':0}
 for public,suffix in [('Idle','IdleLookAround'),('Walk','Walk'),('Sit','SitTableIdle'),('Wave','WaveHello')]:
  authored=('Adult' if public=='Walk' else family)+'_'+suffix;action=bpy.data.actions[authored]
  rig.animation_data.action=action;rig.animation_data.action_slot=action.slots[0]
  first,last=map(int,action.frame_range);samples=[]
  for f in range(first,last+1):
   scene.frame_set(f);bpy.context.view_layer.update()
   samples.append({n:{'head':list(rig.pose.bones[n].head),'rotation':list(rig.pose.bones[n].matrix.to_quaternion())} for n in ['Root','Hips','LeftFoot','RightFoot','LeftToeBase','RightToeBase']})
  start,end=samples[0],samples[-1]
  loop=max((Vector(start[n]['head'])-Vector(end[n]['head'])).length for n in start)
  metrics['actions'].append({'name':public,'source':authored,'frames':[first,last],'duration':(last-first)/30,'sampleCount':len(samples),'loopEndpointPositionError':loop,'rootMaxOffset':max(Vector(s['Root']['head']).length for s in samples),'hipsRange':[[min(s['Hips']['head'][axis] for s in samples),max(s['Hips']['head'][axis] for s in samples)] for axis in range(3)]})
  if public=='Walk':
   speeds=[]
   for foot in ['LeftFoot','RightFoot']:
    heights=[s[foot]['head'][2] for s in samples]; threshold=min(heights)+(max(heights)-min(heights))*.3
    for i in range(1,len(samples)-1):
     if heights[i]<=threshold:
      speed=(samples[i+1][foot]['head'][1]-samples[i-1][foot]['head'][1])*15
      if speed>.1:speeds.append(speed)
   metrics['walkSpeed']=round(statistics.median(speeds),4)
   metrics['walkSpeedMethod']='Median backward foot speed during lowest30%of ankle height, original30fps; calibrated estimate for authored in-place motion.'
  rig.animation_data.action=None
  track=rig.animation_data.nla_tracks.new();track.name=public
  strip=track.strips.new(public,first,action);strip.action_slot=action.slots[0]
  track.mute=True
 # Export NLA tracks as separate canonical clips, not the entire purchased action library.
 scene.frame_set(0)
 bpy.ops.object.select_all(action='DESELECT');rig.select_set(True);mesh.select_set(True);bpy.context.view_layer.objects.active=rig
 bpy.ops.export_scene.gltf(filepath=str(runtime/(ident+'.glb')),export_format='GLB',use_selection=True,export_yup=True,export_animations=True,export_animation_mode='NLA_TRACKS',export_frame_range=False,export_frame_step=1,export_anim_slide_to_zero=True,export_optimize_animation_size=True,export_optimize_animation_keep_anim_armature=False,export_force_sampling=True,export_skins=True,export_leaf_bone=False,export_morph=False,export_cameras=False,export_lights=False,export_image_format='AUTO',export_texcoords=True,export_normals=True,export_tangents=False)
 metrics['loopCorrections']=close_loop_seams(runtime/(ident+'.glb'))
 metrics['validation']=inspect_glb((runtime/(ident+'.glb')).read_bytes(),require_runtime=True)
 metrics['bytes']=(runtime/(ident+'.glb')).stat().st_size
 assert metrics['bytes']<4*1024*1024,'Over runtime asset budget'
 report=[x for x in report if x['id']!=ident]+[metrics]
 (out/'runtime-export-audit.json').write_text(json.dumps(report,indent=2))
 print('EXPORTED '+ident+' '+str(metrics['bytes'])+' '+str(metrics['walkSpeed']),flush=True)
print('EXPORTS_COMPLETE')
