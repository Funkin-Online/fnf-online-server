const fs = require('fs');
const p = 'game/source/funkin/play/PlayState.hx';
let s = fs.readFileSync(p, 'utf8');
const before = s;
s = s.split('Array<FlxText> = [];').join('Array<flixel.text.FlxText> = [];');
s = s.split('var marker:FlxText = new FlxText(0, 0, 80, \'MISS\');').join('var marker:flixel.text.FlxText = new flixel.text.FlxText(0, 0, 80, \'MISS\');');
if (s === before) {
  console.error('MISS: no FlxText references rewritten');
  process.exit(1);
}
fs.writeFileSync(p, s);
console.log('FlxText qualified');
