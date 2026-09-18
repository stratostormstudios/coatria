"""Reviewed Coatria product-turntable profile. No external scenes or scripts."""
import argparse
import array
import hashlib
import json
import math
import pathlib
import sys
import bpy
from mathutils import Vector


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("--spec", required=True)
    parser.add_argument("--output", required=True)
    args = parser.parse_args(sys.argv[sys.argv.index("--") + 1:])
    spec = json.loads(pathlib.Path(args.spec).read_text(encoding="utf-8"))
    if spec["profile"] != "coatria-product-turntable-v1":
        raise ValueError("Unsupported reviewed profile")
    output = pathlib.Path(args.output).resolve()
    (output / "frames").mkdir(exist_ok=False)
    bpy.data.batch_remove(list(bpy.data.objects))
    scene = bpy.context.scene
    scene.render.engine = "CYCLES"
    scene.cycles.device = "CPU"
    scene.cycles.samples = spec["samples"]
    scene.cycles.seed = 1307
    scene.cycles.use_animated_seed = False
    scene.cycles.use_denoising = True
    scene.render.threads_mode = "FIXED"
    scene.render.threads = 2
    scene.render.resolution_x = spec["width"]
    scene.render.resolution_y = spec["height"]
    scene.render.resolution_percentage = 100
    rate = spec["fpsNumerator"] / spec["fpsDenominator"]
    scene.render.fps = round(rate)
    scene.render.fps_base = scene.render.fps / rate
    scene.frame_start = spec["frameStart"]
    scene.frame_end = spec["frameEnd"]
    scene.render.film_transparent = False
    scene.render.image_settings.media_type = "IMAGE"
    scene.render.image_settings.file_format = "OPEN_EXR"
    scene.render.image_settings.color_mode = "RGBA"
    scene.render.image_settings.color_depth = "16"
    scene.render.image_settings.exr_codec = "ZIP"
    scene.view_settings.view_transform = "AgX"
    scene.display_settings.display_device = "sRGB"
    # Blender 5.x supports configurable file working space. Set it explicitly;
    # the EXR is scene-linear, while the PNG uses the AgX display transform.
    bpy.ops.wm.set_working_color_space(working_space=spec["colorSpace"], convert_colors=False)

    def material(name, color, metallic=0.0, roughness=0.4):
        mat = bpy.data.materials.new(name)
        mat.use_nodes = True
        shader = mat.node_tree.nodes.get("Principled BSDF")
        shader.inputs["Base Color"].default_value = (*color, 1)
        shader.inputs["Metallic"].default_value = metallic
        shader.inputs["Roughness"].default_value = roughness
        return mat

    ceramic = material("Warm ivory ceramic", (0.77, 0.68, 0.48), 0.08, 0.23)
    graphite = material("Graphite lid", (0.019, 0.042, 0.039), 0.55, 0.22)
    accent = material("Copper identification band", (0.52, 0.16, 0.056), 0.65, 0.24)
    plinth_mat = material("Pale green stage", (0.25, 0.37, 0.31), 0.08, 0.6)
    backdrop = material("Soft studio background", (0.052, 0.082, 0.072), 0, 0.8)
    turntable = bpy.data.objects.new("Coatria original demo product", None)
    scene.collection.objects.link(turntable)

    def cylinder(name, radius, depth, z, mat, parent=True):
        bpy.ops.mesh.primitive_cylinder_add(vertices=64, radius=radius, depth=depth, location=(0, 0, z))
        obj = bpy.context.object
        obj.name = name
        obj.data.materials.append(mat)
        bevel = obj.modifiers.new("Manufactured softened edge", "BEVEL")
        bevel.width = 0.05
        bevel.segments = 3
        obj.modifiers.new("Weighted normals", "WEIGHTED_NORMAL")
        for face in obj.data.polygons:
            face.use_smooth = True
        if parent:
            obj.parent = turntable
        return obj

    cylinder("Product body", 0.68, 1.7, 1.2, ceramic)
    cylinder("Dark lid", 0.70, 0.22, 2.14, graphite)
    cylinder("Copper collar", 0.687, 0.075, 1.91, accent)
    cylinder("Raised studio plinth", 1.18, 0.25, 0.17, plinth_mat, False)
    # An offset embossed mark makes consecutive rotations visibly distinct.
    bpy.ops.mesh.primitive_cube_add(size=1, location=(0, -0.674, 1.25))
    mark = bpy.context.object
    mark.name = "Original geometric product mark"
    mark.scale = (0.17, 0.027, 0.27)
    mark.rotation_euler.y = math.radians(22)
    mark.data.materials.append(accent)
    mark.parent = turntable
    bevel = mark.modifiers.new("Mark edge", "BEVEL")
    bevel.width, bevel.segments = 0.05, 3
    bpy.ops.mesh.primitive_plane_add(size=200, location=(0, 0, 0))
    bpy.context.object.name = "Studio floor"
    bpy.context.object.data.materials.append(backdrop)

    world = bpy.data.worlds.new("Controlled studio world")
    world.use_nodes = True
    world.node_tree.nodes["Background"].inputs["Color"].default_value = (0.20, 0.25, 0.23, 1)
    world.node_tree.nodes["Background"].inputs["Strength"].default_value = 0.32
    scene.world = world
    for name, position, energy, size, color in [
        ("Key softbox", (3, -4, 6), 700, 4, (1.0, 0.88, 0.70)),
        ("Fill softbox", (-4, -2, 3.5), 450, 4, (0.72, 0.89, 1.0)),
        ("Rim softbox", (1, 4, 4), 900, 3, (1.0, 0.65, 0.35)),
    ]:
        data = bpy.data.lights.new(name, "AREA")
        data.energy, data.size, data.color = energy, size, color
        obj = bpy.data.objects.new(name, data)
        scene.collection.objects.link(obj)
        obj.location = position
        obj.rotation_euler = (Vector((0, 0, 1)) - obj.location).to_track_quat("-Z", "Y").to_euler()
    camera_data = bpy.data.cameras.new("Product camera")
    camera = bpy.data.objects.new("Product camera", camera_data)
    scene.collection.objects.link(camera)
    scene.camera = camera
    camera.location = (3.6, -6, 3.4)
    camera.rotation_euler = (Vector((0, 0, 1.1)) - camera.location).to_track_quat("-Z", "Y").to_euler()
    camera_data.type, camera_data.ortho_scale = "ORTHO", 4.5
    for frame in range(spec["frameStart"], spec["frameEnd"] + 1):
        # Fixed angle as a function of frame identity; a subset renders the
        # same authored pose as that frame in the complete 24-frame turntable.
        turntable.rotation_euler.z = 2 * math.pi * ((frame - 1) % 24) / 24
        turntable.keyframe_insert(data_path="rotation_euler", frame=frame)
    scene.frame_set(spec["frameStart"])
    scene.render.filepath = "//frames/frame-"
    bpy.ops.wm.save_as_mainfile(filepath=str(output / "scene.blend"), compress=False)
    for frame in range(spec["frameStart"], spec["frameEnd"] + 1):
        scene.frame_set(frame)
        scene.render.filepath = str(output / "frames" / f"frame-{frame:04d}.exr")
        bpy.ops.render.render(write_still=True)
        if frame == spec["frameStart"]:
            scene.render.image_settings.file_format = "PNG"
            scene.render.image_settings.color_depth = "8"
            bpy.data.images["Render Result"].save_render(str(output / "review.png"), scene=scene)
            scene.render.image_settings.file_format = "OPEN_EXR"
            scene.render.image_settings.color_depth = "16"
    decoded_frames = []
    for frame in range(spec["frameStart"], spec["frameEnd"] + 1):
        source = output / "frames" / f"frame-{frame:04d}.exr"
        image = bpy.data.images.load(str(source), check_existing=False)
        try:
            if tuple(image.size) != (spec["width"], spec["height"]):
                raise RuntimeError("Decoded frame dimensions differ from the job")
            pixels = array.array("f", [0.0]) * len(image.pixels)
            image.pixels.foreach_get(pixels)
            if not pixels or not all(math.isfinite(value) for value in pixels):
                raise RuntimeError("Decoded frame contains missing or non-finite pixel data")
            decoded_frames.append({"frame": frame, "width": image.size[0],
                                   "height": image.size[1], "finitePixelValues": len(pixels)})
        finally:
            bpy.data.images.remove(image)
    color_root = pathlib.Path(bpy.utils.system_resource("DATAFILES")) / "colormanagement"
    ocio_files = []
    for source in sorted(color_root.rglob("*")):
        if source.is_file():
            ocio_files.append({"path": source.relative_to(color_root).as_posix(),
                               "sha256": hashlib.sha256(source.read_bytes()).hexdigest()})
    config = color_root / "config.ocio"
    if not config.is_file():
        raise RuntimeError("Pinned bundled OpenColorIO configuration is unavailable")
    evidence = {"schemaVersion": 1, "blenderVersion": bpy.app.version_string,
                "blenderBuildHash": bpy.app.build_hash.decode("ascii"),
                "renderEngine": "CYCLES", "device": "CPU", "threads": 2,
                "workingColorSpace": bpy.data.colorspace.working_space,
                "workingSpaceInteropId": bpy.data.colorspace.working_space_interop_id,
                "ocioConfigSha256": hashlib.sha256(config.read_bytes()).hexdigest(),
                "ocioBundleFiles": ocio_files,
                "decodedFrames": decoded_frames,
                "reviewDisplay": "sRGB", "reviewViewTransform": "AgX",
                "fpsNumerator": spec["fpsNumerator"], "fpsDenominator": spec["fpsDenominator"],
                "frameStart": spec["frameStart"], "frameEnd": spec["frameEnd"],
                "width": spec["width"], "height": spec["height"]}
    (output / "blender-evidence.json").write_text(json.dumps(evidence, indent=2) + "\n", encoding="utf-8")


if __name__ == "__main__":
    main()
