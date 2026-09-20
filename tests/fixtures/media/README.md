# Original media inspector fixtures

These tiny files were generated locally from FFmpeg `color` and `sine` sources;
they contain no purchased, customer, provider-generated, or downloaded media.
Generation used the installed `8.1.1-full_build-www.gyan.dev` build, with explicit
argument arrays and one encoder thread. The inspector never generates media.

- `synthetic.png`: red 16×16, one PNG frame.
- `synthetic.jpeg`: green 16×16, one MJPEG frame.
- `synthetic.webp`: blue 16×16, one `libwebp` frame.
- `synthetic.mp4`: red 16×16 at 6 fps, 0.5 seconds, `libx264`, `yuv420p`, faststart.
- `synthetic.mov`: blue 16×16 at 6 fps, 0.5 seconds, `libx264`, `yuv420p`, MOV.
- `synthetic.wav`: 1000 Hz sine, 8000 samples/second, 0.1 seconds, `pcm_s16le`.
- `synthetic.mp3`: 1000 Hz sine, 44100 samples/second, 0.1 seconds, `libmp3lame`.
- `synthetic-short.mp4`: gray 16×16, two frames at 6 fps, same MP4 settings.
- `synthetic-video-audio.mp4`: purple 16×16 at 6 fps for 0.5 seconds plus a
  400 Hz sine at 8000 samples/second, AAC, same MP4 video settings.
- `synthetic-vfr.mp4`: yellow 16×16 source at 10 fps for 0.5 seconds, timestamp
  filter `setpts=if(lt(N\,2)\,N\,N+1)/(10*TB)`, `-fps_mode vfr`, same MP4
  encoder settings. Its decoded frame timeline spans 700 ms; its container
  summary says 600 ms. The test deliberately verifies observed frame timing.

Run `node --import tsx --test tests/higgsfield-media-inspection.test.ts` with
`COATRIA_TEST_FFMPEG_PATH` and `COATRIA_TEST_FFPROBE_PATH` set to trusted absolute
paths. Tests fail rather than skip if decoders or seekable `fd:` input are absent.
Linux CI can explicitly prepare the pinned, checksum-verified build using
`node scripts/hosting/prepare-media-inspector-ci.mjs` in a preceding CI step.
The preparation script is not imported or invoked by the production worker.

Runtime inspection uses only explicitly configured absolute binaries, a minimal
child environment and inherited regular-file descriptor 0, with no input URL or
filename given to FFmpeg. Color values are reported decoder tags, not proof of an
ICC transform or correct grading. Video duration is the decoded visual timeline;
audio duration is decoded sample count divided by its sample rate. Cadence stays
unknown when there are fewer than three frames. Warnings, incomplete MP3 frames,
unknown formats, extra streams, and exceeded budgets fail closed.

**Deployment gap:** process arguments and `max_alloc` do not create a security
sandbox or cap aggregate allocation. Before processing untrusted production
outputs, qualify a separate decoder OS boundary that cannot access worker
credentials, other host files, or a network, and enforce aggregate CPU, address
space/memory, process/file-descriptor, and wall-clock limits. Termination must kill
the complete decoder process group. The service also needs an aggregate cgroup
(or equivalent) for concurrent archive operations. BtbN's Linux bundle requires
glibc; mounting only its executable is not a complete runtime. No Linux sandbox
or production deployment is certified by the native Windows test results.
