/* End-to-end smoke test for the FNF Online server.
   Run: node test/smoke.js   (no dependencies) */

'use strict';

const assert = require('node:assert');
const { createServer } = require('../server.js');

const SONGS = [
  { id: 'bopeebo', name: 'Bopeebo' },
  { id: 'fresh', name: 'Fresh' },
  { id: 'dadbattle', name: 'Dad Battle' },
  { id: 'spookeez', name: 'Spookeez' },
];

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function client(base) {
  let token = null;
  return {
    get token() {
      return token;
    },
    set token(v) {
      token = v;
    },
    async post(path, body = {}) {
      const res = await fetch(base + path, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ token, ...body }),
      });
      const json = await res.json();
      if (json.token) token = json.token;
      return json;
    },
    async ok(path, body) {
      const json = await this.post(path, body);
      assert.ok(json.ok, `${path} failed: ${json.error}`);
      return json;
    },
  };
}

async function main() {
  const server = createServer();
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  const base = `http://127.0.0.1:${server.address().port}`;
  const t = (name) => console.log('  ✓ ' + name);

  console.log('FNF Online server smoke test\n');

  // ---- sessions -----------------------------------------------------------
  const a = client(base);
  const b = client(base);
  const c = client(base);
  const sa = await a.ok('/api/session', { name: 'Alice' });
  assert.match(sa.playerId, /^[0-9a-f]{16}$/);
  assert.match(sa.token, /^[0-9a-f]{48}$/);
  await b.ok('/api/session', { name: 'Bob' });
  await c.ok('/api/session', { name: 'Cara' });
  t('sessions are issued with 16-char ids and 48-char tokens');

  assert.strictEqual((await client(base).post('/api/lobby/create', {})).error.includes('session'), true);
  t('requests without a token are rejected');

  // ---- host / join --------------------------------------------------------
  const created = await a.ok('/api/lobby/create', { songs: SONGS });
  assert.match(created.code, /^\d{6}$/);
  assert.strictEqual(created.lobby.phase, 'picking');
  assert.strictEqual(created.lobby.players.length, 1);
  assert.strictEqual(created.lobby.you.isHost, true);
  t(`host gets a 6 digit code (${created.code})`);

  const badJoin = await b.post('/api/lobby/join', { code: '000000', songs: SONGS });
  assert.strictEqual(badJoin.ok, false);
  assert.match(badJoin.error, /No lobby/);
  t('joining an unknown code fails cleanly');

  const joined = await b.ok('/api/lobby/join', { code: created.code, songs: SONGS });
  assert.strictEqual(joined.lobby.players.length, 2);
  assert.strictEqual(joined.lobby.you.isHost, false);
  assert.strictEqual(joined.lobby.you.side, 'left');
  assert.strictEqual(joined.lobby.you.role, 'opponent');
  assert.strictEqual(joined.lobby.players.find((p) => p.isHost).side, 'right');
  assert.strictEqual(joined.lobby.players.find((p) => p.isHost).role, 'player');
  assert.strictEqual(joined.lobby.difficulty, 'normal');
  assert.deepStrictEqual(joined.lobby.catalog.map((s) => s.id).sort(), SONGS.map((s) => s.id).sort());
  t('guest joins by code; catalog is the shared song list');
  t('host is the player/BF-Pico side; guest is the opponent side');

  const fullJoin = await c.post('/api/lobby/join', { code: created.code, songs: SONGS });
  assert.strictEqual(fullJoin.ok, false);
  assert.match(fullJoin.error, /full/);
  t('a third player cannot join (1v1 cap)');

  // ---- host-only controls -------------------------------------------------
  const guestMode = await b.post('/api/lobby/mode', { mode: 'accuracy' });
  assert.strictEqual(guestMode.ok, false);
  assert.match(guestMode.error, /host/);
  t('only the host can change the win condition');

  const mode = await a.ok('/api/lobby/mode', { mode: 'misses' });
  assert.strictEqual(mode.lobby.mode, 'misses');
  const badMode = await a.post('/api/lobby/mode', { mode: 'bananas' });
  assert.strictEqual(badMode.ok, false);
  t('win condition can be score / accuracy / misses');

  const guestDiff = await b.post('/api/lobby/difficulty', { difficulty: 'hard' });
  assert.strictEqual(guestDiff.ok, false);
  assert.match(guestDiff.error, /host/);
  t('only the host can change the difficulty');

  const hard = await a.ok('/api/lobby/difficulty', { difficulty: 'hard', variation: 'pico' });
  assert.strictEqual(hard.lobby.difficulty, 'hard');
  assert.strictEqual(hard.lobby.variation, 'pico');
  const badDiff = await a.post('/api/lobby/difficulty', { difficulty: 'impossible' });
  assert.strictEqual(badDiff.ok, false);
  t('host can set easy/normal/hard/erect/nightmare and mix variation');

  // ---- picks, ready, auto start ------------------------------------------
  const startNoPicks = await a.post('/api/lobby/start');
  assert.strictEqual(startNoPicks.ok, false);
  assert.match(startNoPicks.error, /pick/);
  t('force start is refused while nobody has picked a song');

  await a.ok('/api/lobby/pick', { songs: ['bopeebo'] });
  const bPicked = await b.ok('/api/lobby/pick', { songs: ['fresh'] });
  assert.strictEqual(bPicked.lobby.mode, 'misses', 'mode survives picks');

  await a.ok('/api/lobby/ready', { ready: true });
  const auto = await b.ok('/api/lobby/ready', { ready: true });
  assert.strictEqual(auto.lobby.phase, 'countdown');
  assert.ok(['bopeebo', 'fresh'].includes(auto.lobby.song.id), 'song must come from the combined pick pool');
  assert.ok(auto.lobby.startAt > Date.now());
  t(`both ready -> random song from both picks (${auto.lobby.song.id})`);
  assert.strictEqual(auto.lobby.song.difficulty, 'hard');
  assert.strictEqual(auto.lobby.song.variation, 'pico');
  t('started song uses the lobby difficulty and mix');

  // ---- play + results -----------------------------------------------------
  const early = await a.post('/api/lobby/result', { score: 1 });
  assert.strictEqual(early.ok, false);
  t('results are rejected during the countdown');

  await sleep(4300);
  const live = await a.ok('/api/lobby/state');
  assert.strictEqual(live.lobby.phase, 'playing');
  t('countdown flips to playing after ~4s');

  const liveHud = await a.ok('/api/lobby/live', {
    score: 1200,
    misses: 1,
    combo: 8,
    animation: 'singLEFT',
    hits: [{ t: 1234, d: 2, h: 1 }],
  });
  const aliceLive = liveHud.lobby.players.find((p) => p.isHost).live;
  assert.strictEqual(aliceLive.score, 1200);
  assert.strictEqual(aliceLive.hits[0].d, 2);
  t('live duel payload round-trips score and note hits');

  await b.ok('/api/lobby/result', { score: 90000, accuracy: 99.1, misses: 2, maxCombo: 80, totalNotes: 100 });
  const afterOne = await a.ok('/api/lobby/state');
  assert.strictEqual(afterOne.lobby.phase, 'playing', 'wait for both results');
  const done = await a.ok('/api/lobby/result', { score: 70000, accuracy: 95.0, misses: 0, maxCombo: 70, totalNotes: 100 });
  assert.strictEqual(done.lobby.phase, 'results');
  assert.strictEqual(done.lobby.winnerId, done.lobby.you.id, 'fewest misses wins in misses mode');
  t('misses mode: fewer misses wins (even with a lower score)');

  // ---- rematch ------------------------------------------------------------
  const rematch = await b.ok('/api/lobby/rematch');
  assert.strictEqual(rematch.lobby.phase, 'picking');
  assert.strictEqual(rematch.lobby.song, null);
  assert.deepStrictEqual(rematch.lobby.you.picks, []);
  t('rematch resets picks, readiness and results');

  // ---- forfeit ------------------------------------------------------------
  await a.ok('/api/lobby/mode', { mode: 'score' });
  await a.ok('/api/lobby/pick', { songs: ['bopeebo'] });
  await b.ok('/api/lobby/ready', { ready: true });
  await a.ok('/api/lobby/ready', { ready: true });
  await sleep(4300);
  await b.ok('/api/lobby/leave');
  const forfeit = await a.ok('/api/lobby/state');
  assert.strictEqual(forfeit.lobby.phase, 'results');
  assert.strictEqual(forfeit.lobby.forfeit, true);
  assert.strictEqual(forfeit.lobby.winnerId, forfeit.lobby.you.id);
  t('opponent leaving mid-song -> forfeit win');

  // ---- matchmaking --------------------------------------------------------
  const q1 = await a.ok('/api/match/find', { songs: SONGS });
  assert.strictEqual(q1.matched, false);
  assert.strictEqual(q1.queued, true);
  const q2 = await b.ok('/api/match/find', { songs: SONGS });
  assert.strictEqual(q2.matched, true);
  assert.match(q2.lobby.code, /^\d{6}$/);
  assert.strictEqual(q2.lobby.matchmade, true);
  assert.strictEqual(q2.lobby.phase, 'picking');
  assert.strictEqual(q2.lobby.mode, 'score');
  assert.strictEqual(q2.lobby.players.length, 2);
  assert.ok(q2.lobby.players.every((p) => !p.ready), 'matchmade players start unready to pick songs');
  t('find match pairs two waiting players in a score-mode lobby');

  const noMode = await b.post('/api/lobby/mode', { mode: 'misses' });
  assert.strictEqual(noMode.ok, false);
  t('matchmade lobbies are locked to score comparison');

  // score comparison
  await a.ok('/api/lobby/pick', { songs: ['fresh'] });
  await b.ok('/api/lobby/pick', { songs: ['fresh'] });
  await a.ok('/api/lobby/ready', { ready: true });
  await b.ok('/api/lobby/ready', { ready: true });
  await sleep(4300);
  await a.ok('/api/lobby/result', { score: 50000, accuracy: 99.9, misses: 0 });
  const scored = await b.ok('/api/lobby/result', { score: 99999, accuracy: 90.0, misses: 9 });
  assert.strictEqual(scored.lobby.winnerId, scored.lobby.you.id);
  t('score mode: highest score wins regardless of accuracy');

  // ---- accuracy mode ------------------------------------------------------
  await b.ok('/api/lobby/rematch');
  // leave the matchmade lobby and make a fresh code lobby so we can change mode
  await a.ok('/api/lobby/leave');
  await b.ok('/api/lobby/leave');
  const lobby2 = await a.ok('/api/lobby/create', { songs: SONGS });
  await b.ok('/api/lobby/join', { code: lobby2.code, songs: SONGS });
  await a.ok('/api/lobby/mode', { mode: 'accuracy' });
  await a.ok('/api/lobby/pick', { songs: ['spookeez'] });
  await b.ok('/api/lobby/pick', { songs: ['spookeez'] });
  await a.ok('/api/lobby/ready', { ready: true });
  await b.ok('/api/lobby/ready', { ready: true });
  await sleep(4300);
  await a.ok('/api/lobby/result', { score: 1000, accuracy: 99.5, misses: 0 });
  const accRes = await b.ok('/api/lobby/result', { score: 500000, accuracy: 88.0, misses: 0 });
  assert.strictEqual(accRes.lobby.winnerId, accRes.lobby.players.find((p) => p.name === 'Alice').id);
  t('accuracy mode: highest accuracy wins regardless of score');

  // ---- dead player (failed song) -----------------------------------------
  await b.ok('/api/lobby/rematch');
  await a.ok('/api/lobby/mode', { mode: 'score' });
  await a.ok('/api/lobby/pick', { songs: ['bopeebo'] });
  await b.ok('/api/lobby/pick', { songs: ['bopeebo'] });
  await a.ok('/api/lobby/ready', { ready: true });
  await b.ok('/api/lobby/ready', { ready: true });
  await sleep(4300);
  await a.ok('/api/lobby/result', { score: 999, accuracy: 99, misses: 0, failed: true });
  const failRes = await b.ok('/api/lobby/result', { score: 1, accuracy: 1, misses: 99, failed: false });
  assert.strictEqual(failRes.lobby.winnerId, failRes.lobby.you.id, 'dying loses even with a higher score');
  t('dying (failed song) always loses');

  // ---- catalog mismatch ---------------------------------------------------
  const solo = client(base);
  await solo.ok('/api/session', {});
  await solo.ok('/api/lobby/leave');
  const mismatch = await solo.ok('/api/match/find', { songs: [{ id: 'exclusive-song', name: 'Exclusive' }] });
  assert.strictEqual(mismatch.matched, false, 'no shared songs -> stays queued');
  t('matchmaking will not pair players with no songs in common');

  console.log('\nAll checks passed.');
  server.close();
  process.exit(0);
}

main().catch((err) => {
  console.error('\nFAILED:', err.message);
  process.exit(1);
});
