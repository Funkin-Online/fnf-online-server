/* =========================================================================
   FNF Online — 1v1 lobby + matchmaking server
   Zero dependencies. Deploy straight to Render (see README.md).

   Design notes
   ------------
   * The FNF client cannot open raw TLS sockets on native targets, so the
     whole protocol is plain HTTPS request/response ("polling"). The client
     polls /api/lobby/state ~4x a second while in a lobby and ~2x a second
     while playing. That is plenty for 1v1 and works behind Render's proxy.
   * All state is in memory. A Render restart (or free-tier sleep) drops
     in-flight lobbies; clients recover by creating a new session.
   * Nothing is trusted from the client except scores, which only matter
     between two consenting friends. Do not reuse this for ranked play.
   ========================================================================= */

'use strict';

const http = require('node:http');
const crypto = require('node:crypto');

// --------------------------------------------------------------------------
// Tunables
// --------------------------------------------------------------------------

const MAX_PLAYERS = 2; // hard 1v1 cap
const LOBBY_IDLE_MS = 10 * 60 * 1000; // empty lobbies are reaped after this
const PLAYER_STALE_MS = 90 * 1000; // no poll for this long -> dropped
const PLAYER_DISCONNECTED_MS = 15 * 1000; // shown as "reconnecting"
const QUEUE_STALE_MS = 60 * 1000; // auto-cancel a stale queue entry
const START_DELAY_MS = 4000; // countdown before phase flips to "playing"
const MAX_JSON_BYTES = 256 * 1024;
const MAX_SONGS = 500;
const MODES = ['score', 'accuracy', 'misses'];

// --------------------------------------------------------------------------
// State
// --------------------------------------------------------------------------

/** @type {Map<string, any>} playerId -> player */
const players = new Map();
/** @type {Map<string, any>} token -> playerId */
const tokens = new Map();
/** @type {Map<string, any>} 6-digit code -> lobby */
const lobbies = new Map();
/** @type {string[]} playerIds waiting for a random match */
let queue = [];

const startedAt = Date.now();

// --------------------------------------------------------------------------
// Helpers
// --------------------------------------------------------------------------

const now = () => Date.now();

function randomToken() {
  return crypto.randomBytes(24).toString('hex');
}

function newCode() {
  for (let attempt = 0; attempt < 500; attempt++) {
    const code = String(crypto.randomInt(0, 1_000_000)).padStart(6, '0');
    if (!lobbies.has(code)) return code;
  }
  // Extremely unlikely; fall back to a timestamp-derived code.
  const code = String(now() % 1_000_000).padStart(6, '0');
  if (!lobbies.has(code)) return code;
  return String(crypto.randomInt(100_000, 999_999));
}

function sanitizeName(raw, fallback) {
  if (typeof raw !== 'string') return fallback;
  const cleaned = raw.replace(/[^\w \-_.!?]/g, '').trim().slice(0, 20);
  return cleaned.length ? cleaned : fallback;
}

function sanitizeSongs(raw) {
  if (!Array.isArray(raw)) return new Map();
  const out = new Map();
  for (const entry of raw.slice(0, MAX_SONGS)) {
    let id = null;
    let name = null;
    if (typeof entry === 'string') {
      id = entry;
      name = entry;
    } else if (entry && typeof entry === 'object') {
      if (typeof entry.id === 'string') id = entry.id;
      if (typeof entry.name === 'string') name = entry.name;
    }
    if (!id) continue;
    out.set(id.slice(0, 120), (name || id).slice(0, 120));
  }
  return out;
}

function newSession(nameRaw) {
  const id = crypto.randomBytes(8).toString('hex');
  const token = randomToken();
  const player = {
    id,
    token,
    name: sanitizeName(nameRaw, `Player ${id.slice(0, 4).toUpperCase()}`),
    lobby: null,
    queuedAt: null,
    lastSeen: now(),
    catalog: new Map(),
  };
  players.set(id, player);
  tokens.set(token, id);
  return player;
}

function auth(body) {
  const token = typeof body?.token === 'string' ? body.token : null;
  if (!token) return null;
  const id = tokens.get(token);
  if (!id) return null;
  const player = players.get(id);
  if (!player) return null;
  player.lastSeen = now();
  return player;
}

function lobbyPlayers(lobby) {
  return lobby.playerIds.map((id) => players.get(id)).filter(Boolean);
}

function lobbyCatalog(lobby) {
  const list = lobbyPlayers(lobby);
  if (list.length === 0) return new Map();
  // Only songs every connected player owns can be picked.
  let result = new Map(list[0].catalog);
  for (const p of list.slice(1)) {
    for (const id of [...result.keys()]) {
      if (!p.catalog.has(id)) result.delete(id);
    }
  }
  return result;
}

function pickPool(lobby) {
  const pool = new Set();
  for (const set of lobby.picks.values()) {
    for (const id of set) pool.add(id);
  }
  return [...pool];
}

function createLobby(host, { matchmade = false } = {}) {
  const lobby = {
    code: newCode(),
    hostId: host.id,
    mode: 'score', // "find match" always compares score
    phase: 'picking', // picking | countdown | playing | results
    playerIds: [host.id],
    picks: new Map(), // playerId -> Set(songId)
    ready: new Map(), // playerId -> bool
    song: null,
    startAt: 0,
    results: new Map(), // playerId -> stats
    winnerId: null,
    forfeit: false,
    matchmade,
    createdAt: now(),
    updatedAt: now(),
  };
  lobbies.set(lobby.code, lobby);
  host.lobby = lobby.code;
  return lobby;
}

function leaveLobby(player, { silent = false } = {}) {
  if (!player.lobby) return;
  const lobby = lobbies.get(player.lobby);
  player.lobby = null;
  player.queuedAt = null;
  if (!lobby) return;
  lobby.playerIds = lobby.playerIds.filter((id) => id !== player.id);
  lobby.picks.delete(player.id);
  lobby.ready.delete(player.id);
  lobby.results.delete(player.id);
  lobby.updatedAt = now();

  if (lobby.playerIds.length === 0) {
    lobbies.delete(lobby.code);
    return;
  }

  // Host left while somebody was still there: promote the remaining player.
  if (lobby.hostId === player.id) {
    lobby.hostId = lobby.playerIds[0];
  }

  // Opponent bailed mid-song -> the remaining player wins by forfeit.
  if (lobby.phase === 'playing' || lobby.phase === 'countdown') {
    lobby.phase = 'results';
    lobby.forfeit = true;
    lobby.winnerId = lobby.playerIds[0] ?? null;
    lobby.updatedAt = now();
  }

  // Solo lobbies are useless; drop them once the last guest leaves a code lobby.
  if (lobby.playerIds.length < 2 && !lobby.matchmade && lobby.phase === 'results') {
    // keep it so the remaining player can read the scoreboard / rematch
  }
  if (!silent) {
    lobby.ready.set(lobby.hostId, false);
  }
}

function startSong(lobby, forced) {
  if (lobby.phase !== 'picking') return { error: 'Lobby is not picking songs.' };
  const list = lobbyPlayers(lobby);
  if (list.length < 2) return { error: 'Waiting for a second player.' };

  const pool = pickPool(lobby);
  if (pool.length === 0) return { error: 'Both players need to pick at least one song.' };

  const everyoneReady = list.every((p) => lobby.ready.get(p.id) === true);
  if (!forced && !everyoneReady) return { error: 'Both players must be ready.' };

  const catalog = lobbyCatalog(lobby);
  const songId = pool[crypto.randomInt(0, pool.length)];
  lobby.song = { id: songId, name: catalog.get(songId) || songId, difficulty: 'normal' };
  lobby.phase = 'countdown';
  lobby.startAt = now() + START_DELAY_MS;
  lobby.results.clear();
  lobby.winnerId = null;
  lobby.forfeit = false;
  lobby.updatedAt = now();
  return { ok: true };
}

function maybeAutoStart(lobby) {
  if (lobby.phase !== 'picking') return;
  const list = lobbyPlayers(lobby);
  if (list.length < 2) return;
  const everyoneReady = list.every((p) => lobby.ready.get(p.id) === true);
  if (!everyoneReady) return;
  if (pickPool(lobby).length === 0) return;
  startSong(lobby, false);
}

function compareResults(lobby) {
  const entries = lobby.playerIds.map((id) => ({ id, stats: lobby.results.get(id) })).filter((e) => e.stats);
  if (entries.length < 2) return;

  let [a, b] = entries;
  // A player who failed (died) always loses, regardless of the mode.
  if (!!a.stats.failed !== !!b.stats.failed) {
    lobby.winnerId = a.stats.failed ? b.id : a.id;
  } else {
    let winner = null;
    if (lobby.mode === 'accuracy') {
      winner = pickBetter(a, b, (s) => s.accuracy, (s) => s.score);
    } else if (lobby.mode === 'misses') {
      winner = pickBetter(a, b, (s) => -s.misses, (s) => s.score);
    } else {
      winner = pickBetter(a, b, (s) => s.score, (s) => s.accuracy);
    }
    lobby.winnerId = winner; // null == draw
  }
  lobby.phase = 'results';
  lobby.updatedAt = now();
}

function pickBetter(a, b, primary, tiebreak) {
  const pa = Number(primary(a.stats)) || 0;
  const pb = Number(primary(b.stats)) || 0;
  if (pa > pb) return a.id;
  if (pb > pa) return b.id;
  const ta = Number(tiebreak(a.stats)) || 0;
  const tb = Number(tiebreak(b.stats)) || 0;
  if (ta > tb) return a.id;
  if (tb > ta) return b.id;
  return null;
}

function snapshot(lobby, viewer) {
  advanceLobby(lobby);
  const list = lobbyPlayers(lobby);
  const you = lobby.playerIds.includes(viewer.id) ? viewer.id : null;
  return {
    code: lobby.code,
    phase: lobby.phase,
    mode: lobby.mode,
    hostId: lobby.hostId,
    you: {
      id: you,
      isHost: you === lobby.hostId,
      ready: !!lobby.ready.get(you),
      picks: [...(lobby.picks.get(you) ?? [])],
    },
    players: list.map((p) => ({
      id: p.id,
      name: p.name,
      isHost: p.id === lobby.hostId,
      ready: !!lobby.ready.get(p.id),
      picks: [...(lobby.picks.get(p.id) ?? [])],
      connected: now() - p.lastSeen < PLAYER_DISCONNECTED_MS,
      stats: lobby.results.get(p.id) ?? null,
    })),
    catalog: [...lobbyCatalog(lobby)].map(([id, name]) => ({ id, name })),
    song: lobby.song,
    startAt: lobby.startAt,
    serverTime: now(),
    winnerId: lobby.winnerId,
    forfeit: lobby.forfeit,
    matchmade: lobby.matchmade,
    countdownMs: lobby.phase === 'countdown' ? Math.max(0, lobby.startAt - now()) : 0,
  };
}

function roomFor(player) {
  if (!player.lobby) return null;
  const lobby = lobbies.get(player.lobby) ?? null;
  if (lobby) advanceLobby(lobby);
  return lobby;
}

/**
 * Polling is the source of truth for the countdown, so a lobby can never be
 * stuck in "countdown" just because the reaper timer has not ticked yet.
 */
function advanceLobby(lobby) {
  if (lobby.phase === 'countdown' && now() >= lobby.startAt) {
    lobby.phase = 'playing';
    lobby.updatedAt = now();
  }
}

function tick() {
  const t = now();

  // Drop players that stopped polling entirely.
  for (const [id, p] of players) {
    if (t - p.lastSeen > PLAYER_STALE_MS) {
      leaveLobby(p, { silent: true });
      queue = queue.filter((q) => q !== id);
      tokens.delete(p.token);
      players.delete(id);
    }
  }

  // Expire abandoned queues.
  queue = queue.filter((id) => {
    const p = players.get(id);
    if (!p) return false;
    if (p.queuedAt == null) return false;
    if (t - p.queuedAt > QUEUE_STALE_MS) {
      p.queuedAt = null;
      return false;
    }
    return true;
  });

  // Reap empty lobbies.
  for (const [code, lobby] of lobbies) {
    const elapsed = t - lobby.updatedAt;
    if (lobby.playerIds.length === 0 && elapsed > LOBBY_IDLE_MS) lobbies.delete(code);
    else if (elapsed > LOBBY_IDLE_MS * 6) lobbies.delete(code);
    // Countdown finished -> go live.
    if (lobby.phase === 'countdown' && t >= lobby.startAt) {
      lobby.phase = 'playing';
      lobby.updatedAt = t;
    }
  }
}

const reaper = setInterval(tick, 1000);
if (reaper.unref) reaper.unref();

// --------------------------------------------------------------------------
// HTTP
// --------------------------------------------------------------------------

function send(res, status, payload) {
  const body = JSON.stringify(payload);
  res.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'content-length': Buffer.byteLength(body),
    'access-control-allow-origin': '*',
    'access-control-allow-headers': 'content-type, authorization',
    'access-control-allow-methods': 'GET, POST, OPTIONS',
    'cache-control': 'no-store',
  });
  res.end(body);
}

function fail(res, status, message) {
  send(res, status, { ok: false, error: message });
}

function readJson(req) {
  return new Promise((resolve, reject) => {
    let size = 0;
    const chunks = [];
    req.on('data', (chunk) => {
      size += chunk.length;
      if (size > MAX_JSON_BYTES) {
        reject(new Error('Body too large'));
        req.destroy();
        return;
      }
      chunks.push(chunk);
    });
    req.on('end', () => {
      if (chunks.length === 0) return resolve({});
      try {
        resolve(JSON.parse(Buffer.concat(chunks).toString('utf8')));
      } catch {
        reject(new Error('Invalid JSON'));
      }
    });
    req.on('error', reject);
  });
}

async function route(req, res, path) {
  const body = req.method === 'POST' ? await readJson(req) : {};

  // Health check for Render.
  if (path === '/healthz') {
    return send(res, 200, {
      ok: true,
      uptimeMs: now() - startedAt,
      players: players.size,
      lobbies: lobbies.size,
      queue: queue.length,
    });
  }

  if (path === '/api/stats') {
    return send(res, 200, { ok: true, players: players.size, lobbies: lobbies.size, queue: queue.length });
  }

  if (path === '/api/session') {
    const player = newSession(body.name);
    return send(res, 200, {
      ok: true,
      playerId: player.id,
      token: player.token,
      name: player.name,
      serverTime: now(),
    });
  }

  const player = auth(body);
  if (!player) return fail(res, 401, 'Unknown or expired session. Call /api/session again.');

  switch (path) {
    // ---- lobby lifecycle -------------------------------------------------
    case '/api/lobby/create': {
      if (player.lobby) leaveLobby(player);
      player.queuedAt = null;
      player.catalog = sanitizeSongs(body.songs);
      const lobby = createLobby(player);
      return send(res, 200, { ok: true, code: lobby.code, lobby: snapshot(lobby, player) });
    }

    case '/api/lobby/join': {
      const raw = typeof body.code === 'string' ? body.code.replace(/\D/g, '') : '';
      const code = raw.padStart(6, '0').slice(-6);
      const lobby = lobbies.get(code);
      if (!lobby) return fail(res, 404, 'No lobby with that code.');
      if (lobby.playerIds.includes(player.id)) {
        player.catalog = sanitizeSongs(body.songs);
        return send(res, 200, { ok: true, lobby: snapshot(lobby, player) });
      }
      if (lobby.playerIds.length >= MAX_PLAYERS) return fail(res, 409, 'That lobby is already full.');
      if (lobby.phase === 'playing' || lobby.phase === 'countdown') return fail(res, 409, 'That match has already started.');
      if (lobby.phase === 'results') return fail(res, 409, 'That match already finished.');

      if (player.lobby) leaveLobby(player);
      player.queuedAt = null;
      player.catalog = sanitizeSongs(body.songs);
      lobby.playerIds.push(player.id);
      lobby.ready.set(player.id, false);
      lobby.updatedAt = now();
      player.lobby = code;
      return send(res, 200, { ok: true, lobby: snapshot(lobby, player) });
    }

    case '/api/lobby/state': {
      const lobby = roomFor(player);
      if (!lobby) return send(res, 200, { ok: true, lobby: null, queued: player.queuedAt != null, serverTime: now() });
      return send(res, 200, { ok: true, lobby: snapshot(lobby, player), queued: false, serverTime: now() });
    }

    case '/api/lobby/leave': {
      leaveLobby(player);
      return send(res, 200, { ok: true });
    }

    // ---- matchmaking -----------------------------------------------------
    case '/api/match/find': {
      if (player.lobby) leaveLobby(player);
      player.catalog = sanitizeSongs(body.songs);

      if (player.catalog.size === 0) return fail(res, 400, 'Send your song catalog first.');

      if (!queue.includes(player.id)) {
        queue.push(player.id);
        player.queuedAt = now();
      }

      // Pair the two oldest compatible waiters.
      const candidates = queue
        .map((id) => players.get(id))
        .filter((p) => p && p.id !== player.id && p.catalog.size > 0);

      for (const other of candidates) {
        // Require at least one shared song.
        let shared = false;
        for (const id of player.catalog.keys()) {
          if (other.catalog.has(id)) {
            shared = true;
            break;
          }
        }
        if (!shared) continue;

        queue = queue.filter((id) => id !== player.id && id !== other.id);
        other.queuedAt = null;
        player.queuedAt = null;
        const lobby = createLobby(other, { matchmade: true });
        lobby.playerIds.push(player.id);
        lobby.ready.set(other.id, true);
        lobby.ready.set(player.id, true);
        player.lobby = lobby.code;
        lobby.mode = 'score';
        lobby.updatedAt = now();
        return send(res, 200, { ok: true, matched: true, lobby: snapshot(lobby, player) });
      }

      return send(res, 200, { ok: true, matched: false, queued: true, position: queue.indexOf(player.id) + 1 });
    }

    case '/api/match/cancel': {
      queue = queue.filter((id) => id !== player.id);
      player.queuedAt = null;
      return send(res, 200, { ok: true });
    }

    // ---- in-lobby actions ------------------------------------------------
    case '/api/lobby/pick': {
      const lobby = roomFor(player);
      if (!lobby) return fail(res, 404, 'You are not in a lobby.');
      if (lobby.phase !== 'picking') return fail(res, 409, 'Songs are locked right now.');
      const catalog = lobbyCatalog(lobby);
      const ids = Array.isArray(body.songs) ? body.songs.filter((s) => typeof s === 'string' && catalog.has(s)) : [];
      lobby.picks.set(player.id, new Set(ids.slice(0, 100)));
      lobby.ready.set(player.id, false); // changing picks un-readies you
      lobby.updatedAt = now();
      return send(res, 200, { ok: true, lobby: snapshot(lobby, player) });
    }

    case '/api/lobby/ready': {
      const lobby = roomFor(player);
      if (!lobby) return fail(res, 404, 'You are not in a lobby.');
      if (lobby.phase !== 'picking') return fail(res, 409, 'Cannot change ready state right now.');
      lobby.ready.set(player.id, body.ready !== false);
      lobby.updatedAt = now();
      maybeAutoStart(lobby);
      return send(res, 200, { ok: true, lobby: snapshot(lobby, player) });
    }

    case '/api/lobby/mode': {
      const lobby = roomFor(player);
      if (!lobby) return fail(res, 404, 'You are not in a lobby.');
      if (player.id !== lobby.hostId) return fail(res, 403, 'Only the host can change the win condition.');
      if (lobby.matchmade) return fail(res, 403, 'Matchmade games always compare score.');
      if (!MODES.includes(body.mode)) return fail(res, 400, `mode must be one of ${MODES.join(', ')}`);
      if (lobby.phase !== 'picking') return fail(res, 409, 'Cannot change the mode after the song starts.');
      lobby.mode = body.mode;
      lobby.updatedAt = now();
      return send(res, 200, { ok: true, lobby: snapshot(lobby, player) });
    }

    case '/api/lobby/start': {
      const lobby = roomFor(player);
      if (!lobby) return fail(res, 404, 'You are not in a lobby.');
      if (player.id !== lobby.hostId) return fail(res, 403, 'Only the host can force start.');
      const result = startSong(lobby, true);
      if (result.error) return fail(res, 409, result.error);
      return send(res, 200, { ok: true, lobby: snapshot(lobby, player) });
    }

    case '/api/lobby/result': {
      const lobby = roomFor(player);
      if (!lobby) return fail(res, 404, 'You are not in a lobby.');
      if (lobby.phase !== 'playing') return fail(res, 409, 'The match is not running.');
      if (lobby.results.has(player.id)) return send(res, 200, { ok: true, lobby: snapshot(lobby, player) });

      lobby.results.set(player.id, {
        score: Math.max(0, Math.min(100_000_000, Math.round(Number(body.score) || 0))),
        accuracy: Math.max(0, Math.min(100, Number(body.accuracy) || 0)),
        misses: Math.max(0, Math.min(100_000, Math.round(Number(body.misses) || 0))),
        maxCombo: Math.max(0, Math.min(100_000, Math.round(Number(body.maxCombo) || 0))),
        totalNotes: Math.max(0, Math.min(100_000, Math.round(Number(body.totalNotes) || 0))),
        failed: !!body.failed,
        submittedAt: now(),
      });
      compareResults(lobby);
      return send(res, 200, { ok: true, lobby: snapshot(lobby, player) });
    }

    // ---- rematch ---------------------------------------------------------
    case '/api/lobby/rematch': {
      const lobby = roomFor(player);
      if (!lobby) return fail(res, 404, 'You are not in a lobby.');
      if (lobby.phase !== 'results') return fail(res, 409, 'The match is still running.');
      lobby.phase = 'picking';
      lobby.song = null;
      lobby.startAt = 0;
      lobby.results.clear();
      lobby.winnerId = null;
      lobby.forfeit = false;
      for (const id of lobby.playerIds) {
        lobby.ready.set(id, false);
        lobby.picks.set(id, new Set());
      }
      lobby.updatedAt = now();
      return send(res, 200, { ok: true, lobby: snapshot(lobby, player) });
    }

    default:
      return fail(res, 404, `Unknown endpoint: ${path}`);
  }
}

function createServer() {
  return http.createServer((req, res) => {
    if (req.method === 'OPTIONS') {
      res.writeHead(204, {
        'access-control-allow-origin': '*',
        'access-control-allow-headers': 'content-type, authorization',
        'access-control-allow-methods': 'GET, POST, OPTIONS',
        'access-control-max-age': '86400',
      });
      return res.end();
    }

    let path;
    try {
      path = new URL(req.url, 'http://localhost').pathname;
    } catch {
      return fail(res, 400, 'Bad URL');
    }

    // Root serves a tiny manual test client (also handy for poking a deploy).
    if (path === '/' && req.method === 'GET') {
      const page = require('node:fs').readFileSync(require('node:path').join(__dirname, 'public', 'index.html'), 'utf8');
      res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
      return res.end(page);
    }

    route(req, res, path)
      .catch((err) => {
        console.error('[fnf-online] request failed', path, err);
        if (!res.headersSent) fail(res, 400, err.message || 'Bad request');
        else res.end();
      });
  });
}

if (require.main === module) {
  const port = Number(process.env.PORT) || 8080;
  const server = createServer();
  server.listen(port, '0.0.0.0', () => {
    console.log(`[fnf-online] listening on http://0.0.0.0:${port}`);
  });
  const shutdown = () => server.close(() => process.exit(0));
  process.on('SIGTERM', shutdown);
  process.on('SIGINT', shutdown);
}

module.exports = { createServer, compareResults, MODES };
