# Test fixtures

`tiny.mp4` — a genuine 2-second H.264/AAC file (160×120, ~16 KB) produced by
ffmpeg. It is committed rather than synthesized at test time so that the
production smoke test can run on a machine that has no ffmpeg — including
against a live deployment, which is the case that matters most.

Regenerate with:

```sh
ffmpeg -y \
  -f lavfi -i "testsrc=size=160x120:rate=10:duration=2" \
  -f lavfi -i "sine=frequency=440:duration=2" \
  -c:v libx264 -preset veryfast -pix_fmt yuv420p \
  -c:a aac -b:a 32k -movflags +faststart \
  apps/web/server/fixtures/tiny.mp4
```
