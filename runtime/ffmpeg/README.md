# Optional: ffmpeg for video keyframes

CQR extracts still frames from attached videos (`mp4` / `webm` / `mov` / …) and sends them to the vision model.

## Auto-install (preferred)

On first video attachment, if `ffmpeg` is missing, CQR runs:

```
tools/bootstrap-ffmpeg.ps1 -Root <install> -SkipIfExists
```

This downloads Gyan essentials into `runtime/ffmpeg/` (internet required). Disable with `CQR_FFMPEG_AUTO=0`.

Manual:

```
powershell -File tools\bootstrap-ffmpeg.ps1 -Root .
```

## Manual drop-in

```
runtime/ffmpeg/ffmpeg.exe
runtime/ffmpeg/ffprobe.exe   (recommended)
```

or `runtime/ffmpeg/bin/...`

## Not in delta zip

ffmpeg binaries stay under `runtime/` (preserved across UPDATE). Only the bootstrap script ships in delta.

## Not used

`liang121/video-summarizer` (Claude Code plugin) is **not** bundled.
