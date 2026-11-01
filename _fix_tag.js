// Repair: GAME_TAG is used to MATCH the source HTML, so it must stay plain.
// The versioned URL belongs only in the output.
const fs = require('fs');
const p = 'tools/build-docs.js';
let s = fs.readFileSync(p, 'utf8');

const from = `const GAME_TAG = '<script type="text/javascript" src="./FunkinOnline.js?v=' + BUNDLE_VERSION + '"></script>';`;
const to = `const GAME_TAG = '<script type="text/javascript" src="./FunkinOnline.js"></script>';
const VERSIONED_TAG = GAME_TAG.replace('./FunkinOnline.js', './FunkinOnline.js?v=' + BUNDLE_VERSION);`;
if (!s.includes(from)) {
  console.error('MISS: versioned tag const');
  process.exit(1);
}
s = s.replace(from, to);

const useFrom = '  return stripped.replace(GAME_TAG, BOOTSTRAP + GAME_TAG);';
const useTo = '  return stripped.replace(GAME_TAG, BOOTSTRAP + VERSIONED_TAG);';
if (!s.includes(useFrom)) {
  console.error('MISS: page tag replacement');
  process.exit(1);
}
s = s.replace(useFrom, useTo);

fs.writeFileSync(p, s);
console.log('match tag restored, output tag versioned');
