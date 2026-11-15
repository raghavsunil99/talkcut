// Export benchmark: how the export recipe scales with the number of cuts.
//   node scripts/bench-export.js [minutes=60] [cuts=50,200,800] [height=360]
// Makes a test-pattern source of that length (cached in the system temp folder), then renders
// it with N evenly spread cuts using the app's own recipe (render-plan.js) and prints wall time,
// peak memory of ffmpeg and the output length.
const { execFileSync, spawnSync } = require('node:child_process');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const ffmpeg = require('ffmpeg-static');
const { buildRenderArgs } = require('../src/renderer/render-plan.js');
const { snapRanges } = require('../src/renderer/edits.js');

const minutes = Number(process.argv[2] ?? 60);
const cutCounts = String(process.argv[3] ?? '50,200,800').split(',').map(Number);
const height = Number(process.argv[4] ?? 360);
const width = Math.round((height * 16) / 9 / 2) * 2;
const duration = minutes * 60;

const dir = path.join(os.tmpdir(), 'talkcut-bench');
fs.mkdirSync(dir, { recursive: true });
const source = path.join(dir, `source-${minutes}m-${height}p.mp4`);
if (!fs.existsSync(source)) {
  console.log(`Making a ${minutes}-minute ${width}x${height} source…`);
  execFileSync(ffmpeg, [
    '-hide_banner', '-y', '-f', 'lavfi', '-i', `testsrc=size=${width}x${height}:rate=30`, '-f', 'lavfi', '-i', 'sine=frequency=300:sample_rate=48000',
    '-t', String(duration), '-pix_fmt', 'yuv420p', '-c:v', 'libx264', '-preset', 'ultrafast', '-c:a', 'aac', source,
  ], { stdio: 'ignore' });
}

// N cuts of 0.5 s spread evenly: N + 1 kept ranges.
function rangesWithCuts(n) {
  const step = duration / (n + 1);
  const ranges = [];
  let start = 0;
  for (let i = 1; i <= n; i++) {
    const cut = i * step;
    ranges.push([start, cut]);
    start = cut + 0.5;
  }
  ranges.push([start, duration]);
  return ranges;
}

function probeDuration(file) {
  const r = spawnSync(ffmpeg, ['-hide_banner', '-i', file], { encoding: 'utf8' });
  const m = /Duration: (\d+):(\d+):([\d.]+)/.exec(r.stderr);
  return m ? Number(m[1]) * 3600 + Number(m[2]) * 60 + Number(m[3]) : NaN;
}

console.log(`cuts  ranges  graph KB   seconds   peak MB   out s   expected s`);
for (const n of cutCounts) {
  const ranges = rangesWithCuts(n);
  const output = path.join(dir, `out-${n}.mp4`);
  const { args } = buildRenderArgs({ input: source, output, ranges, hasVideo: true, hasAudio: true, duration, width, height, fps: 30, filterPath: (p) => `'${p}'` });
  const graph = args[args.indexOf('-filter_complex') + 1];
  const t0 = Date.now();
  // /usr/bin/time -l reports ffmpeg's peak memory on macOS.
  const r = spawnSync('/usr/bin/time', ['-l', ffmpeg, ...args], { encoding: 'utf8', maxBuffer: 1 << 28 });
  const secs = (Date.now() - t0) / 1000;
  const rss = /(\d+)\s+maximum resident set size/.exec(r.stderr);
  const expected = snapRanges(ranges, 30).reduce((s, [a, b]) => s + (b - a), 0);
  const ok = r.status === 0;
  console.log([
    String(n).padStart(4), String(ranges.length).padStart(7), (graph.length / 1024).toFixed(0).padStart(9),
    (ok ? secs.toFixed(1) : 'FAILED').padStart(9), (rss ? (Number(rss[1]) / 1048576).toFixed(0) : '?').padStart(9),
    (ok ? probeDuration(output).toFixed(2) : '-').padStart(7), expected.toFixed(2).padStart(12),
  ].join(' '));
  if (!ok) console.log(r.stderr.split('\n').filter((l) => /error|Error|failed/i.test(l)).slice(-5).join('\n'));
  fs.rmSync(output, { force: true });
}
