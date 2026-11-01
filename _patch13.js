// Stale-snapshot guard: a lobby snapshot from the previous match must not open
// the start gate. Every match gets a sequence number; the client records the
// sequence it entered with and ignores anything older.
const fs = require('fs');

function edit(file, pairs) {
  let s = fs.readFileSync(file, 'utf8');
  for (const [label, from, to] of pairs) {
    if (!s.includes(from)) {
      console.error('MISS in ' + file + ': ' + label);
      process.exit(1);
    }
    s = s.replace(from, to);
  }
  fs.writeFileSync(file, s);
  console.log('patched ' + file);
}

// ------------------------------------------------------------------- server ---
edit('server/server.js', [
  ['matchSeq on the lobby record',
   "    phase: 'picking', // picking | countdown | playing | results",
   "    phase: 'picking', // picking | countdown | playing | results\n    matchSeq: 0, // bumped for every match, so clients can spot stale snapshots"],
  ['bump the sequence when the match starts',
   "  lobby.phase = 'loading';",
   "  lobby.matchSeq = (lobby.matchSeq || 0) + 1;\n  lobby.phase = 'loading';"],
  ['publish the sequence',
   '    phase: lobby.phase,',
   '    phase: lobby.phase,\n    matchSeq: lobby.matchSeq || 0,'],
]);

// ------------------------------------------------------------ OnlineSession ---
edit('game/source/funkin/online/OnlineSession.hx', [
  ['sequence field',
   '  static var gateStartedAt:Float = 0;',
   `  static var gateStartedAt:Float = 0;

  /** Match sequence we entered with; older snapshots must not open the gate. */
  static var gateSeq:Int = -1;`],
  ['reset captures the sequence',
   `  public static function resetMatchGate():Void
  {
    loadedReported = false;
    gateStartedAt = 0;
  }`,
   `  public static function resetMatchGate():Void
  {
    loadedReported = false;
    gateStartedAt = 0;
    gateSeq = lobby == null ? -1 : Std.int(numberField(lobby, 'matchSeq'));
  }`],
  ['learn the sequence from the ready reply',
   `      var next:Dynamic = Reflect.field(res, 'lobby');
      if (next != null) lobby = next;
    }, function(_:String)
    {
      // A dropped request must not strand the lobby: try again next tick.
      loadedReported = false;`,
   `      var next:Dynamic = Reflect.field(res, 'lobby');
      if (next != null)
      {
        setLobby(next);
        gateSeq = Std.int(numberField(next, 'matchSeq'));
      }
    }, function(_:String)
    {
      // A dropped request must not strand the lobby: try again next tick.
      loadedReported = false;`],
  ['ignore snapshots from an earlier match',
   `    var phase:String = Std.string(Reflect.field(lobby, 'phase') ?? '');
    if (phase == 'playing' || phase == 'results') return true;
    if (phase == 'countdown') return msUntilStart() <= 0;`,
   `    // A snapshot left over from the previous match still says "results" or
    // "playing"; trusting it started the song before the other side had loaded.
    var seq:Int = Std.int(numberField(lobby, 'matchSeq'));
    if (gateSeq >= 0 && seq < gateSeq) return false;

    var phase:String = Std.string(Reflect.field(lobby, 'phase') ?? '');
    if (phase == 'playing' || phase == 'results') return true;
    if (phase == 'countdown') return msUntilStart() <= 0;`],
]);

console.log('stale snapshot guard wired');
