const { spawn } = require("child_process");
const path = require("path");
const fs = require("fs");

// Resolve ffmpeg/ffprobe. Prefer system binaries; fall back to common names.
const FFMPEG = process.env.FFMPEG_PATH || "ffmpeg";
const FFPROBE = process.env.FFPROBE_PATH || "ffprobe";

function run(bin, args) {
  return new Promise((resolve, reject) => {
    const p = spawn(bin, args);
    let err = "";
    p.stderr.on("data", d => (err += d.toString()));
    p.on("close", code => (code === 0 ? resolve() : reject(new Error(`${bin} exited ${code}\n${err.slice(-1500)}`))));
    p.on("error", reject);
  });
}

function probe(file) {
  return new Promise((resolve) => {
    const p = spawn(FFPROBE, [
      "-v", "error",
      "-show_entries", "stream=codec_type,width,height",
      "-of", "json", file
    ]);
    let out = "";
    p.stdout.on("data", d => (out += d.toString()));
    p.on("close", () => {
      try {
        const j = JSON.parse(out);
        const v = (j.streams || []).find(s => s.codec_type === "video") || {};
        const hasAudio = (j.streams || []).some(s => s.codec_type === "audio");
        resolve({ width: v.width || null, height: v.height || null, hasAudio });
      } catch {
        resolve({ width: null, height: null, hasAudio: false });
      }
    });
    p.on("error", () => resolve({ width: null, height: null, hasAudio: false }));
  });
}

/**
 * Overlay a frame PNG onto a video. Pure-black pixels in the frame are keyed out
 * (made transparent) so the video shows through the window, while coloured bars
 * (header/footer/logo) stay on top.
 */
async function applyFrame(videoIn, framePng, videoOut) {
  const fmeta = await probe(framePng);
  const vmeta = await probe(videoIn);
  // Output size = frame size if known, else the video size.
  const W = fmeta.width || vmeta.width || 1080;
  const H = fmeta.height || vmeta.height || 1920;

  const filter =
    `[0:v]scale=${W}:${H},setsar=1[bg];` +
    `[1:v]scale=${W}:${H},colorkey=0x000000:0.12:0.05[fk];` +
    `[bg][fk]overlay=0:0:format=auto[outv]`;

  const args = [
    "-y",
    "-i", videoIn,
    "-i", framePng,
    "-filter_complex", filter,
    "-map", "[outv]"
  ];
  if (vmeta.hasAudio) args.push("-map", "0:a?");
  args.push("-c:v", "libx264", "-pix_fmt", "yuv420p", "-preset", "veryfast", "-crf", "20");
  if (vmeta.hasAudio) args.push("-c:a", "aac");
  args.push(videoOut);

  await run(FFMPEG, args);
  return { W, H };
}

/** Normalize a clip to W×H @30fps with a guaranteed AAC audio track. */
async function normalize(input, output, W, H) {
  const meta = await probe(input);
  const vf =
    `scale=${W}:${H}:force_original_aspect_ratio=decrease,` +
    `pad=${W}:${H}:(ow-iw)/2:(oh-ih)/2:black,setsar=1,fps=30`;

  let args;
  if (meta.hasAudio) {
    args = [
      "-y", "-i", input,
      "-vf", vf,
      "-c:v", "libx264", "-pix_fmt", "yuv420p", "-preset", "veryfast", "-crf", "20",
      "-c:a", "aac", "-ar", "44100", "-ac", "2",
      output
    ];
  } else {
    args = [
      "-y", "-i", input,
      "-f", "lavfi", "-i", "anullsrc=channel_layout=stereo:sample_rate=44100",
      "-shortest",
      "-vf", vf,
      "-map", "0:v", "-map", "1:a",
      "-c:v", "libx264", "-pix_fmt", "yuv420p", "-preset", "veryfast", "-crf", "20",
      "-c:a", "aac",
      output
    ];
  }
  await run(FFMPEG, args);
}

/**
 * Full pipeline: apply frame (optional) then append outro (optional).
 * Returns the path of the final composited file.
 */
async function compose({ videoIn, framePng, outroClip, outDir, baseName }) {
  fs.mkdirSync(outDir, { recursive: true });
  let current = videoIn;
  let W = 1080, H = 1920;

  // 1) Frame overlay
  if (framePng && fs.existsSync(framePng)) {
    const framed = path.join(outDir, `${baseName}_framed.mp4`);
    const dims = await applyFrame(videoIn, framePng, framed);
    W = dims.W; H = dims.H;
    current = framed;
  } else {
    const m = await probe(videoIn);
    W = m.width || 1080; H = m.height || 1920;
  }

  // 2) Append outro
  if (outroClip && fs.existsSync(outroClip)) {
    const n0 = path.join(outDir, `${baseName}_n0.mp4`);
    const n1 = path.join(outDir, `${baseName}_n1.mp4`);
    await normalize(current, n0, W, H);
    await normalize(outroClip, n1, W, H);

    const listFile = path.join(outDir, `${baseName}_list.txt`);
    fs.writeFileSync(listFile, `file '${path.resolve(n0)}'\nfile '${path.resolve(n1)}'\n`);

    const final = path.join(outDir, `${baseName}_final.mp4`);
    await run(FFMPEG, ["-y", "-f", "concat", "-safe", "0", "-i", listFile, "-c", "copy", final]);

    // cleanup intermediates
    [n0, n1, listFile].forEach(f => { try { fs.unlinkSync(f); } catch {} });
    if (current !== videoIn) { try { fs.unlinkSync(current); } catch {} }
    return final;
  }

  // No outro: if we framed, rename framed → final; else copy original.
  const final = path.join(outDir, `${baseName}_final.mp4`);
  if (current !== videoIn) {
    fs.renameSync(current, final);
  } else {
    fs.copyFileSync(videoIn, final);
  }
  return final;
}

module.exports = { compose, applyFrame, probe };
