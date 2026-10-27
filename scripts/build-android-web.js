// Puts the editor, the Android back end (mobile/bridge.js), fonts and ffmpeg.wasm together in
// mobile/www, which Capacitor packages into the Android app.
const fs = require('node:fs');
const path = require('node:path');

const root = path.join(__dirname, '..');
const out = path.join(root, 'mobile', 'www');
const copy = (from, to) => fs.cpSync(path.join(root, from), path.join(out, to), { recursive: true });

fs.rmSync(out, { recursive: true, force: true });
fs.mkdirSync(out, { recursive: true });
for (const f of fs.readdirSync(path.join(root, 'src', 'renderer'))) if (f !== 'index.html') copy(`src/renderer/${f}`, f);
copy('mobile/bridge.js', 'bridge.js');
copy('mobile/touch.js', 'touch.js');
copy('mobile/mobile.css', 'mobile.css');
copy('mobile/fonts', 'fonts');
copy('node_modules/@ffmpeg/ffmpeg/dist/umd/ffmpeg.js', 'vendor/ffmpeg/ffmpeg.js');
copy('node_modules/@ffmpeg/ffmpeg/dist/umd/814.ffmpeg.js', 'vendor/ffmpeg/814.ffmpeg.js');
copy('node_modules/@ffmpeg/core/dist/umd/ffmpeg-core.js', 'vendor/ffmpeg/ffmpeg-core.js');
copy('node_modules/@ffmpeg/core/dist/umd/ffmpeg-core.wasm', 'vendor/ffmpeg/ffmpeg-core.wasm');

let html = fs.readFileSync(path.join(root, 'src', 'renderer', 'index.html'), 'utf8');
const csp = [
  "default-src 'self'",
  "script-src 'self' 'wasm-unsafe-eval' blob:",
  "worker-src 'self' blob:",
  "style-src 'self'",
  "img-src 'self' data: blob: https://images.pexels.com https://*.pexels.com",
  "media-src 'self' blob: data:",
  "font-src 'self'",
  "connect-src 'self' blob: data: https://api.elevenlabs.io https://api.pexels.com https://*.pexels.com",
].join('; ');
html = html.replace(/<meta http-equiv="Content-Security-Policy"[\s\S]*?>/, `<meta http-equiv="Content-Security-Policy" content="${csp}">\n  <meta name="viewport" content="width=device-width, initial-scale=1, maximum-scale=1, viewport-fit=cover">`);
html = html.replace('<link rel="stylesheet" href="styles.css">', '<link rel="stylesheet" href="styles.css">\n  <link rel="stylesheet" href="mobile.css">');
// The back end has to exist before the editor's scripts run.
const first = html.indexOf('<script src="');
html = `${html.slice(0, first)}<script src="vendor/ffmpeg/ffmpeg.js"></script>\n  <script src="bridge.js"></script>\n  <script src="touch.js"></script>\n  ${html.slice(first)}`;
html = html.replace('<script src="frame.js"></script>', '<script src="frame.js"></script>\n  <script src="render-plan.js"></script>');
fs.writeFileSync(path.join(out, 'index.html'), html);
console.log(`Built ${path.relative(root, out)}`);
