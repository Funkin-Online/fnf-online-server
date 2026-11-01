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
 *   3. rewrites docs/index.html so the page tells the game which lobby server
 *      to use (window.FNF_ONLINE_SERVER) and warms a sleeping Render service
 *   4. writes .nojekyll so Pages serves every asset verbatim
 *
 * The server URL comes from FNF_SERVER_URL, or the Render name used by
 * render.yaml. Change it here and re-run to point the web build elsewhere.
 */

'use strict';

const fs = require('node:fs');
const path = require('node:path');

const ROOT = path.resolve(__dirname, '..');
const SRC = path.join(ROOT, 'game', 'export', 'debug', 'html5', 'bin');
const OUT = path.join(ROOT, 'docs');

const SERVER_URL = (process.env.FNF_SERVER_URL || 'https://fnf-online-server.onrender.com').replace(/\/+$/, '');

// Cutscene videos only: 130 MB that the online flow never loads.
const SKIP_DIRS = new Set([path.join('assets', 'videos')]);
const SKIP_EXT = new Set(['.map']);

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

const BOOTSTRAP = (url) => `	<!-- FNF Online: which lobby server this page talks to.
	     Change this one line and re-run tools/build-docs.js to point the web
	     build somewhere else, or open the page with ?server=https://your-host
	     to switch without rebuilding (the choice is remembered). -->
	<script type="text/javascript">
		window.FNF_ONLINE_SERVER = window.FNF_ONLINE_SERVER || '${url}';
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
			// A free Render service sleeps; start waking it while assets download.
			try {
				if (window.FNF_ONLINE_SERVER) {
					fetch(window.FNF_ONLINE_SERVER + '/healthz', { mode: 'no-cors', cache: 'no-store' }).catch(function () {});
				}
			} catch (e) {}
		})();
	</script>

`;

function writeIndex() {
  const file = path.join(OUT, 'index.html');
  let html = fs.readFileSync(file, 'utf8');
  const tag = '<script type="text/javascript" src="./FunkinOnline.js"></script>';
  if (!html.includes(tag)) {
    throw new Error('index.html has no FunkinOnline.js script tag — did the Lime build change?');
  }
  // Strip a bootstrap from an earlier run so re-running stays idempotent.
  html = html.replace(/[ \t]*<!-- FNF Online: which lobby server[\s\S]*?<\/script>\r?\n\r?\n/, '');
  html = html.replace(tag, BOOTSTRAP(SERVER_URL) + tag);
  fs.writeFileSync(file, html);
}

function main() {
  if (!fs.existsSync(path.join(SRC, 'index.html'))) {
    console.error(`No web build at ${SRC}\nRun: cd game && haxelib run lime build html5 -debug`);
    process.exit(1);
  }

  fs.rmSync(OUT, { recursive: true, force: true });
  fs.mkdirSync(OUT, { recursive: true });

  const { files, bytes } = walk(SRC);
  writeIndex();
  fs.writeFileSync(path.join(OUT, '.nojekyll'), '');

  console.log(`docs/ rebuilt from ${path.relative(ROOT, SRC)}`);
  console.log(`  files:  ${files}`);
  console.log(`  size:   ${(bytes / 1024 / 1024).toFixed(1)} MB`);
  console.log(`  server: ${SERVER_URL}`);
}

main();
