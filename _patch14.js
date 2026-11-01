// The other player's performance, live: every judged note is sent, and misses
// pop up over the opponent's side of the screen.
const fs = require('fs');
const p = 'game/source/funkin/play/PlayState.hx';
let s = fs.readFileSync(p, 'utf8');

function swap(label, from, to) {
  if (!s.includes(from)) {
    console.error('MISS: ' + label);
    process.exit(1);
  }
  s = s.replace(from, to);
  console.log('patched: ' + label);
}

swap('marker field',
  '  var onlineStartPending:Bool = false;',
  `  var onlineStartPending:Bool = false;

  /** Floating markers for the other player's misses. */
  var onlineMissMarkers:Array<FlxText> = [];`);

swap('send hits',
  `    // Calling event.cancelEvent() skips all the other logic! Neat!
    if (event.eventCanceled) return;
    // Display the hit on the strums`,
  `    // Calling event.cancelEvent() skips all the other logic! Neat!
    if (event.eventCanceled) return;

    // Tell the other side this note landed on our lane.
    if (note.scoreable) funkin.online.OnlineSession.recordHit(note.noteData.time, note.noteData.getDirection(), true);

    // Display the hit on the strums`);

swap('send misses',
  '  function onNoteMiss(note:NoteSprite, playSound:Bool = false, healthChange:Float):Void\n  {',
  `  function onNoteMiss(note:NoteSprite, playSound:Bool = false, healthChange:Float):Void
  {
    // The other player should see this one get away from us.
    funkin.online.OnlineSession.recordHit(note.noteData.time, note.noteData.getDirection(), false);
`);

swap('draw remote misses',
  `  /**
     * Updates the values of the health bar.
     */
  function updateHealthBar():Void`,
  `  /**
     * Draws the other player's misses over their side of the screen, so a 1v1 is
     * something you can watch happen rather than read off the results screen.
     */
  function updateOnlineRemoteHits():Void
  {
    if (!funkin.online.OnlineSession.inMatch) return;

    var fresh:Array<Dynamic> = funkin.online.OnlineSession.consumeRemoteHits();
    for (event in fresh)
    {
      if (funkin.online.OnlineSession.numberField(event, 'h') >= 1) continue; // hits are silent

      var lane:Int = Std.int(funkin.online.OnlineSession.numberField(event, 'd'));
      var marker:FlxText = new FlxText(0, 0, 80, 'MISS');
      marker.setFormat(null, 16, 0xFFFF5C5C);
      marker.x = opponentStrumline.x + 12 + lane * 62;
      marker.y = opponentStrumline.y - 80;
      marker.cameras = [camHUD];
      add(marker);
      onlineMissMarkers.push(marker);
    }

    var i:Int = onlineMissMarkers.length - 1;
    while (i >= 0)
    {
      var marker:FlxText = onlineMissMarkers[i];
      marker.y -= 1.2;
      marker.alpha -= 0.04;
      if (marker.alpha <= 0)
      {
        remove(marker);
        marker.kill();
        onlineMissMarkers.splice(i, 1);
      }
      i--;
    }
  }

  /**
     * Updates the values of the health bar.
     */
  function updateHealthBar():Void`);

swap('call it each HUD tick',
  `            + '  Combo: \${Std.int(funkin.online.OnlineSession.numberField(rival, 'combo'))}';
        }
      }`,
  `            + '  Combo: \${Std.int(funkin.online.OnlineSession.numberField(rival, 'combo'))}';
        }
        updateOnlineRemoteHits();
      }`);

fs.writeFileSync(p, s);
console.log('live opponent feedback wired');
