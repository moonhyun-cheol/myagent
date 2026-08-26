/**
 * Extract still frames from attached videos for vision LLMs.
 * Prefer bundled/runtime ffmpeg; auto-install essentials on first miss (Windows).
 */
import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, readdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { randomUUID } from 'node:crypto';

export const VIDEO_EXTENSIONS = new Set([
  'mp4',
  'webm',
  'mov',
  'mkv',
  'avi',
  'm4v',
  'mpeg',
  'mpg',
]);

const MAX_VIDEO_BYTES = 80_000_000;
const MAX_FRAME_BYTES = 2_500_000;
const DEFAULT_FRAME_COUNT = 4;

let autoInstallAttempted = false;

export function isVideoAttachment(name: string, mime?: string): boolean {
  const m = (mime ?? '').toLowerCase();
  if (m.startsWith('video/')) return true;
  const ext = name.includes('.') ? name.split('.').pop()!.toLowerCase() : '';
  return VIDEO_EXTENSIONS.has(ext);
}

export function findFfmpegBinary(cqrRoot?: string): string | null {
  const candidates: string[] = [];
  if (cqrRoot) {
    candidates.push(
      path.join(cqrRoot, 'runtime', 'ffmpeg', 'ffmpeg.exe'),
      path.join(cqrRoot, 'runtime', 'ffmpeg', 'bin', 'ffmpeg.exe'),
      path.join(cqrRoot, 'runtime', 'ffmpeg', 'ffmpeg'),
      path.join(cqrRoot, 'runtime', 'ffmpeg', 'bin', 'ffmpeg'),
    );
  }
  for (const p of candidates) {
    if (existsSync(p)) return p;
  }
  const which = spawnSync(process.platform === 'win32' ? 'where' : 'which', ['ffmpeg'], {
    encoding: 'utf8',
    windowsHide: true,
    timeout: 5_000,
  });
  const line = (which.stdout ?? '').split(/\r?\n/).map((s) => s.trim()).find(Boolean);
  if (line && existsSync(line)) return line;
  const probe = spawnSync('ffmpeg', ['-version'], {
    encoding: 'utf8',
    windowsHide: true,
    timeout: 5_000,
  });
  if (probe.status === 0) return 'ffmpeg';
  return null;
}

/**
 * Download ffmpeg essentials into runtime/ffmpeg when missing.
 * Uses tools/bootstrap-ffmpeg.ps1 (shipped in delta). Disable with CQR_FFMPEG_AUTO=0.
 */
export function ensureFfmpegBinary(cqrRoot?: string): string | null {
  const existing = findFfmpegBinary(cqrRoot);
  if (existing) return existing;
  if (!cqrRoot || process.env.CQR_FFMPEG_AUTO === '0') return null;
  if (process.platform !== 'win32') return null;
  if (autoInstallAttempted) return findFfmpegBinary(cqrRoot);

  autoInstallAttempted = true;
  const ps1 = path.join(cqrRoot, 'tools', 'bootstrap-ffmpeg.ps1');
  if (!existsSync(ps1)) {
    return null;
  }
  mkdirSync(path.join(cqrRoot, 'runtime', 'ffmpeg'), { recursive: true });
  const r = spawnSync(
    'powershell',
    ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', ps1, '-Root', cqrRoot, '-SkipIfExists'],
    { encoding: 'utf8', windowsHide: true, timeout: 300_000 },
  );
  if (r.status !== 0) return null;
  return findFfmpegBinary(cqrRoot);
}

function findFfprobeBinary(ffmpegPath: string, cqrRoot?: string): string | null {
  if (cqrRoot) {
    for (const p of [
      path.join(cqrRoot, 'runtime', 'ffmpeg', 'ffprobe.exe'),
      path.join(cqrRoot, 'runtime', 'ffmpeg', 'bin', 'ffprobe.exe'),
      path.join(cqrRoot, 'runtime', 'ffmpeg', 'ffprobe'),
      path.join(cqrRoot, 'runtime', 'ffmpeg', 'bin', 'ffprobe'),
    ]) {
      if (existsSync(p)) return p;
    }
  }
  if (ffmpegPath !== 'ffmpeg') {
    const sibling = path.join(path.dirname(ffmpegPath), process.platform === 'win32' ? 'ffprobe.exe' : 'ffprobe');
    if (existsSync(sibling)) return sibling;
  }
  const probe = spawnSync('ffprobe', ['-version'], {
    encoding: 'utf8',
    windowsHide: true,
    timeout: 5_000,
  });
  return probe.status === 0 ? 'ffprobe' : null;
}

function probeDurationSec(ffprobe: string, videoPath: string): number | null {
  const r = spawnSync(
    ffprobe,
    ['-v', 'error', '-show_entries', 'format=duration', '-of', 'default=noprint_wrappers=1:nokey=1', videoPath],
    { encoding: 'utf8', windowsHide: true, timeout: 20_000 },
  );
  if (r.status !== 0) return null;
  const n = Number(String(r.stdout ?? '').trim());
  return Number.isFinite(n) && n > 0 ? n : null;
}

function extractAtTimestamp(
  ffmpeg: string,
  videoPath: string,
  seconds: number,
  outPath: string,
): boolean {
  const r = spawnSync(
    ffmpeg,
    [
      '-hide_banner',
      '-loglevel',
      'error',
      '-y',
      '-ss',
      String(Math.max(0, seconds)),
      '-i',
      videoPath,
      '-frames:v',
      '1',
      '-q:v',
      '3',
      '-update',
      '1',
      outPath,
    ],
    { encoding: 'utf8', windowsHide: true, timeout: 60_000 },
  );
  return r.status === 0 && existsSync(outPath);
}

function extractFirstFrames(ffmpeg: string, videoPath: string, outDir: string, count: number): string[] {
  const pattern = path.join(outDir, 'frame_%02d.jpg');
  const r = spawnSync(
    ffmpeg,
    [
      '-hide_banner',
      '-loglevel',
      'error',
      '-y',
      '-i',
      videoPath,
      '-vf',
      'fps=1',
      '-frames:v',
      String(count),
      '-q:v',
      '3',
      pattern,
    ],
    { encoding: 'utf8', windowsHide: true, timeout: 90_000 },
  );
  if (r.status !== 0) return [];
  return readdirSync(outDir)
    .filter((n) => /^frame_\d+\.jpg$/i.test(n))
    .sort()
    .map((n) => path.join(outDir, n));
}

export interface VideoKeyframeResult {
  ok: boolean;
  dataUrls: string[];
  note: string;
  durationSec?: number | null;
}

/**
 * Extract up to `maxFrames` JPEG keyframes as data URLs for multimodal chat.
 */
export function extractVideoKeyframeDataUrls(
  videoPath: string,
  opts?: { cqrRoot?: string; maxFrames?: number; maxBytes?: number },
): VideoKeyframeResult {
  const maxFrames = Math.min(6, Math.max(1, opts?.maxFrames ?? DEFAULT_FRAME_COUNT));
  if (!existsSync(videoPath)) {
    return { ok: false, dataUrls: [], note: 'VIDEO_FILE_MISSING' };
  }
  let ffmpeg = findFfmpegBinary(opts?.cqrRoot);
  if (!ffmpeg) {
    ffmpeg = ensureFfmpegBinary(opts?.cqrRoot);
  }
  if (!ffmpeg) {
    return {
      ok: false,
      dataUrls: [],
      note:
        'FFMPEG_NOT_FOUND — auto-install failed or disabled; place ffmpeg in runtime/ffmpeg/ or run tools/bootstrap-ffmpeg.ps1',
    };
  }

  const workDir = path.join(tmpdir(), `cqr-video-frames-${randomUUID()}`);
  mkdirSync(workDir, { recursive: true });
  try {
    const ffprobe = findFfprobeBinary(ffmpeg, opts?.cqrRoot);
    const duration = ffprobe ? probeDurationSec(ffprobe, videoPath) : null;
    const paths: string[] = [];

    if (duration && duration > 0.5) {
      for (let i = 0; i < maxFrames; i++) {
        const t = duration * ((i + 0.5) / maxFrames);
        const out = path.join(workDir, `k_${String(i).padStart(2, '0')}.jpg`);
        if (extractAtTimestamp(ffmpeg, videoPath, t, out)) paths.push(out);
      }
    }
    if (!paths.length) {
      paths.push(...extractFirstFrames(ffmpeg, videoPath, workDir, maxFrames));
    }

    const dataUrls: string[] = [];
    for (const p of paths) {
      try {
        const bytes = readFileSync(p);
        if (!bytes.length || bytes.length > (opts?.maxBytes ?? MAX_FRAME_BYTES)) continue;
        dataUrls.push(`data:image/jpeg;base64,${bytes.toString('base64')}`);
      } catch {
        /* skip frame */
      }
    }
    if (!dataUrls.length) {
      return {
        ok: false,
        dataUrls: [],
        note: 'FFMPEG_EXTRACT_FAILED',
        durationSec: duration,
      };
    }
    return {
      ok: true,
      dataUrls,
      note: `extracted ${dataUrls.length} frame(s)`,
      durationSec: duration,
    };
  } finally {
    try {
      rmSync(workDir, { recursive: true, force: true });
    } catch {
      /* ignore */
    }
  }
}

export { MAX_VIDEO_BYTES };
