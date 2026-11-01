/**
 * Turns the Haxe/Lime HTML5 build into docs/ — the folder GitHub Pages serves
 * and the lobby server also serves, so one push hosts the game everywhere.
 *
 *   node tools/build-docs.js
 *
 * What it does:
 *   1. copies game/export/debug/html5/bin into docs/
 *   2. drops the source map (6 MB) and the cutscene videos (130 MB) — the web
 *      build never plays them online and they blow past the Pages size budget
 *   3. writes three pages from that one build:
 *        index.html   the PC / mobile chooser (tools/landing.html)
 *        play.html    the game, keyboard
 *        mobile.html  the game plus the touch controller (tools/touch-controls.js)
 *   4. writes .nojekyll so Pages serves every asset verbatim
 *
 * One build for both pages on purpose: a native-style mobile compile needs
 * `-Dmobile`, which Lime cannot build for HTML5 (`Type not found : GLObject`),
 * and a second copy of the 644 MB asset folder would break the Pages limit.
 *
 * Every page sets window.FNF_ONLINE_SERVER so a static host still finds the
 * lobby server; FNF_SERVER_URL overrides it.
 */

'use strict';

const fs = require('node:fs');
const path = require('node:path');

const ROOT = path.resolve(__dirname, '..');
const SRC = path.join(ROOT, 'game', 'export', 'debug', 'html5', 'bin');
const OUT = path.join(ROOT, 'docs');
const LANDING = path.join(__dirname, 'landing.html');
const TOUCH = path.join(__dirname, 'touch-controls.js');

const SERVER_URL = (process.env.FNF_SERVER_URL || 'https://fnf-online-server.onrender.com').replace(/\/+$/, '');

// Cutscene videos only: 130 MB that the online flow never loads.
const SKIP_DIRS = new Set([path.join('assets', 'videos')]);
const SKIP_EXT = new Set(['.map']);

const BOOTSTRAP = `	<!-- FNF Online: which lobby server this page talks to.
	     Change this line and re-run tools/build-docs.js to point the build
	     somewhere else, or open the page with ?server=https://your-host
	     to switch without rebuilding (the choice is remembered). -->
	<script type="text/javascript">
		window.FNF_ONLINE_SERVER = window.FNF_ONLINE_SERVER || '${SERVER_URL}';
		(function () {
			try {
				var match = /[?&]server=([^&]+)/.exec(window.location.search);
				if (match) {
					var chosen = decodeURIComponent(match[1]).replace(/\\/+$/, '');
					if (chosen && !/^https?:\\/\\//.test(chosen)) chosen = 'https://' + chosen;
					window.FNF_ONLINE_SERVER = chosen;
					window.localStorage.setItem('fnfOnlineServer', chosen);
				}
			} catch (e) {}
		})();
	</script>

`;

const GAME_TAG = '<script type="text/javascript" src="./FunkinOnline.js"></script>';
const TOUCH_TAG = '\t<script type="text/javascript" src="./touch.js"></script>\r\n';

function walk(dir, relative = '') {
  let files = 0;
  let bytes = 0;
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const rel = path.join(relative, entry.name);
    const from = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      if (SKIP_DIRS.has(rel)) continue;
      const nested = walk(from, rel);
      files += nested.files;
      bytes += nested.bytes;
      continue;
    }
    if (!entry.isFile()) continue;
    if (SKIP_EXT.has(path.extname(entry.name).toLowerCase())) continue;

    const to = path.join(OUT, rel);
    fs.mkdirSync(path.dirname(to), { recursive: true });
    fs.copyFileSync(from, to);
    files += 1;
    bytes += fs.statSync(to).size;
  }
  return { files, bytes };
}

/** Injects the server bootstrap in front of the Lime boot script. */
function gamePage(html) {
  if (!html.includes(GAME_TAG)) {
    throw new Error('index.html has no FunkinOnline.js script tag — did the Lime build change?');
  }
  const stripped = html.replace(/[ \t]*<!-- FNF Online: which lobby server[\s\S]*?<\/script>\r?\n\r?\n/, '');
  return stripped.replace(GAME_TAG, BOOTSTRAP + GAME_TAG);
}

/** Adds the on-screen controller right before the closing body tag. */
function withTouch(html) {
  if (!html.includes('</body>')) throw new Error('index.html has no </body> to hang the touch controller on');
  const out = html.replace('</body>', TOUCH_TAG + '</body>');
  if (!out.includes('./touch.js')) throw new Error('touch controller was not injected into mobile.html');
  return out;
}

function main() {
  if (!fs.existsSync(path.join(SRC, 'index.html'))) {
    console.error(`No web build at ${SRC}\nRun: cd game && haxelib run lime build html5 -debug`);
    process.exit(1);
  }

  fs.rmSync(OUT, { recursive: true, force: true });
  fs.mkdirSync(OUT, { recursive: true });

  const { files, bytes } = walk(SRC);
  const built = gamePage(fs.readFileSync(path.join(SRC, 'index.html'), 'utf8'));

  fs.writeFileSync(path.join(OUT, 'play.html'), built);
  fs.writeFileSync(path.join(OUT, 'mobile.html'), withTouch(built));
  fs.copyFileSync(TOUCH, path.join(OUT, 'touch.js'));

  const landing = fs.readFileSync(LANDING, 'utf8');
  if (!landing.includes('{{SERVER_URL}}')) throw new Error('landing.html lost its {{SERVER_URL}} placeholder');
  fs.writeFileSync(path.join(OUT, 'index.html'), landing.split('{{SERVER_URL}}').join(SERVER_URL));

  fs.writeFileSync(path.join(OUT, '.nojekyll'), '');

  console.log('docs/ rebuilt');
  console.log(`  files:  ${files}`);
  console.log(`  size:   ${(bytes / 1024 / 1024).toFixed(1)} MB`);
  console.log(`  server: ${SERVER_URL}`);
  console.log('  pages:  index.html (chooser), play.html (keyboard), mobile.html (touch)');
}

try {
  main();
} catch (error) {
  console.error(error.message || error);
  process.exit(1);
}
