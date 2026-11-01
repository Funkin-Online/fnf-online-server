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
const os = require('node:os');
const fs = require('node:fs');
const path = require('node:path');

// --------------------------------------------------------------------------
// Tunables
// --------------------------------------------------------------------------

const MAX_PLAYERS = 2; // hard 1v1 cap
const LOBBY_IDLE_MS = 10 * 60 * 1000; // empty lobbies are reaped after this
const PLAYER_STALE_MS = 5 * 60 * 1000; // no poll for 5 minutes -> dropped
const PLAYER_DISCONNECTED_MS = 30 * 1000; // shown as "reconnecting"
const QUEUE_STALE_MS = 60 * 1000; // auto-cancel a stale queue entry
const START_DELAY_MS = 5000; // wait after both sides load, before the song
const LOAD_TIMEOUT_MS = 45000; // start anyway if a client never reports loaded
                                         // (a cold 16 MB bundle on a phone can take 30 s+)
const MAX_JSON_BYTES = 256 * 1024;
const MAX_SONGS = 500;
const MODES = ['score', 'accuracy', 'misses'];
const DIFFICULTIES = ['easy', 'normal', 'hard', 'erect', 'nightmare'];
const VARIATIONS = ['default', 'pico', 'erect', 'bf'];

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

function getLocalIps() {
  const nets = os.networkInterfaces();
  const list = [];
  for (const name of Object.keys(nets)) {
    const isVirtual = /virtual|vbox|vmware|vethernet|hyper-v|default switch/i.test(name);
    for (const net of nets[name] || []) {
      if ((net.family === 'IPv4' || net.family === 4) && !net.internal) {
        const isVirtualIp = isVirtual || net.address.startsWith('192.168.56.') || net.address.startsWith('169.254.');
        const isWifi = /wi-?fi|wlan|wireless/i.test(name);
        const isEth = /ethernet|eth|en/i.test(name);
        list.push({
          address: net.address,
          name,
          priority: isVirtualIp ? 0 : (isWifi ? 3 : (isEth ? 2 : 1)),
        });
      }
    }
  }
  list.sort((a, b) => b.priority - a.priority);
  return list.map((item) => item.address);
}

const MIME_TYPES = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'application/javascript; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.gif': 'image/gif',
  '.svg': 'image/svg+xml',
  '.ogg': 'audio/ogg',
  '.mp3': 'audio/mpeg',
  '.wav': 'audio/wav',
  '.ttf': 'font/ttf',
  '.otf': 'font/otf',
  '.woff': 'font/woff',
  '.woff2': 'font/woff2',
  '.wasm': 'application/wasm',
  '.map': 'application/json',
  '.txt': 'text/plain; charset=utf-8',
};

function tryServeFile(res, filePath, headOnly = false) {
  try {
    if (!fs.existsSync(filePath)) return false;
    const stat = fs.statSync(filePath);
    if (!stat.isFile()) return false;
    const ext = path.extname(filePath).toLowerCase();
    const contentType = MIME_TYPES[ext] || 'application/octet-stream';
    res.writeHead(200, {
      'content-type': contentType,
      'content-length': stat.size,
      'access-control-allow-origin': '*',
      // Always revalidate: a cached 16 MB game bundle hides every new build.
      'cache-control': 'no-cache, must-revalidate',
    });
    if (headOnly) res.end();
    else fs.createReadStream(filePath).pipe(res);
    return true;
  } catch {
    return false;
  }
}

// --------------------------------------------------------------------------
// Same-origin adoption
//
// GitHub Pages serves these files statically, so the page keeps whatever server
// URL tools/build-docs.js baked in. When THIS server serves them instead (Render,
// LAN, localhost), the page should talk to the origin that served it -- that way
// any Render hostname works without rebuilding or editing the game.
// --------------------------------------------------------------------------

const ORIGIN_MARKER = 'FNF_ONLINE_SERVER=window.FNF_ONLINE_SERVER||window.location.origin';
const ORIGIN_SCRIPT = '<script type="text/javascript">window.' + ORIGIN_MARKER + ';</script>';

function decodePath(rawPath) {
  let decoded = rawPath;
  try {
    decoded = decodeURIComponent(rawPath);
  } catch {
    // keep the raw path when it is not valid percent-encoding
  }
  return decoded.replace(/\0/g, '');
}

function tryServeGameFile(res, filePath, headOnly = false) {
  if (path.extname(filePath).toLowerCase() !== '.html') return tryServeFile(res, filePath, headOnly);
  try {
    if (!fs.existsSync(filePath) || !fs.statSync(filePath).isFile()) return false;
    let html = fs.readFileSync(filePath, 'utf8');
    if (html.indexOf(ORIGIN_MARKER) === -1) {
      const head = /<head[^>]*>/i.exec(html);
      const at = head ? head.index + head[0].length : 0;
      html = html.slice(0, at) + '\n\t' + ORIGIN_SCRIPT + html.slice(at);
    }
    res.writeHead(200, {
      'content-type': 'text/html; charset=utf-8',
      'content-length': Buffer.byteLength(html),
      'access-control-allow-origin': '*',
      'cache-control': 'no-cache',
    });
    if (headOnly) res.end();
    else res.end(html);
    return true;
  } catch {
    return false;
  }
}

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

function sanitizeHits(raw) {
  if (!Array.isArray(raw)) return [];
  const out = [];
  for (const hit of raw.slice(-48)) {
    if (!hit || typeof hit !== 'object') continue;
    out.push({
      t: Math.max(0, Math.min(10_000_000, Math.round(Number(hit.t) || 0))),
      d: Math.max(0, Math.min(3, Math.round(Number(hit.d) || 0))),
      h: hit.h ? 1 : 0,
    });
  }
  return out;
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
    difficulty: 'normal',
    variation: 'default',
    phase: 'picking', // picking | countdown | playing | results
    playerIds: [host.id],
    picks: new Map(), // playerId -> Set(songId)
    ready: new Map(), // playerId -> bool
    loaded: new Set(), // playerId -> true once their client has the song loaded
    song: null,
    startAt: 0,
    results: new Map(), // playerId -> stats
    live: new Map(), // playerId -> current in-song HUD state
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
  // 'loading' counts as started: leaving now must still end the match.
  if (lobby.phase === 'playing' || lobby.phase === 'countdown' || lobby.phase === 'loading') {
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
  lobby.song = {
    id: songId,
    name: catalog.get(songId) || songId,
    difficulty: lobby.difficulty || 'normal',
    variation: lobby.variation || 'default',
  };
  // Do not start the clock yet: a client that is still preloading the chart
  // would join the song mid-way. Wait for every side to report loaded.
  lobby.phase = 'loading';
  lobby.startAt = 0;
  lobby.loaded = new Set();
  lobby.loadingSince = now();
  lobby.results.clear();
  lobby.live.clear();
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

function allSidesLoaded(lobby) {
  const list = lobbyPlayers(lobby);
  if (list.length < 2) return false;
  return list.every((p) => lobby.loaded && lobby.loaded.has(p.id));
}

/** loading -> countdown, but only once every client has the song loaded. */
function advanceLoading(lobby) {
  if (lobby.phase !== 'loading') return;

  // A player who never reports (closed tab, dead phone, dropped request) must
  // not pin the other player on a loading screen.
  const waited = now() - (lobby.loadingSince || now());
  if (!allSidesLoaded(lobby) && waited < LOAD_TIMEOUT_MS) return;

  lobby.phase = 'countdown';
  lobby.startAt = now() + START_DELAY_MS;
  lobby.updatedAt = now();
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
      side: you === lobby.hostId ? 'right' : 'left',
      role: you === lobby.hostId ? 'player' : 'opponent',
    },
    players: list.map((p) => ({
      id: p.id,
      name: p.name,
      isHost: p.id === lobby.hostId,
      ready: !!lobby.ready.get(p.id),
      loaded: !!(lobby.loaded && lobby.loaded.has(p.id)),
      picks: [...(lobby.picks.get(p.id) ?? [])],
      connected: now() - p.lastSeen < PLAYER_DISCONNECTED_MS,
      stats: lobby.results.get(p.id) ?? null,
      live: lobby.live.get(p.id) ?? { score: 0, misses: 0, combo: 0, animation: 'idle', hits: [] },
      side: p.id === lobby.hostId ? 'right' : 'left',
      role: p.id === lobby.hostId ? 'player' : 'opponent',
    })),
    catalog: [...lobbyCatalog(lobby)].map(([id, name]) => ({ id, name })),
    difficulty: lobby.difficulty || 'normal',
    variation: lobby.variation || 'default',
    song: lobby.song,
    startAt: lobby.startAt,
    serverTime: now(),
    winnerId: lobby.winnerId,
    forfeit: lobby.forfeit,
    matchmade: lobby.matchmade,
    countdownMs: lobby.phase === 'countdown' ? Math.max(0, lobby.startAt - now()) : 0,
    startDelayMs: START_DELAY_MS,
    loadedCount: lobby.loaded ? lobby.loaded.size : 0,
    playerCount: list.length,
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
  advanceLoading(lobby);
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

  // Expire abandoned queues (no poll for PLAYER_DISCONNECTED_MS).
  queue = queue.filter((id) => {
    const p = players.get(id);
    if (!p) return false;
    if (p.queuedAt == null) return false;
    if (t - p.lastSeen > PLAYER_DISCONNECTED_MS) {
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
    advanceLoading(lobby);
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
      if (lobby.phase === 'playing' || lobby.phase === 'countdown' || lobby.phase === 'loading') return fail(res, 409, 'That match has already started.');
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
        lobby.ready.set(other.id, false);
        lobby.ready.set(player.id, false);
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
    case '/api/lobby/rename': {
      player.name = sanitizeName(body.name, player.name);
      const lobby = roomFor(player);
      return send(res, 200, { ok: true, name: player.name, lobby: lobby ? snapshot(lobby, player) : null });
    }

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
      // While the song loads, the same endpoint carries the "I am ready to play" report.
      if (lobby.phase === 'loading' && body.loaded === true) {
        lobby.loaded.add(player.id);
        advanceLoading(lobby);
        return send(res, 200, { ok: true, lobby: snapshot(lobby, player) });
      }
      if (lobby.phase !== 'picking') return fail(res, 409, 'Cannot change ready state right now.');
      const isReadying = body.ready !== false;
      const myPicks = lobby.picks.get(player.id)?.size || 0;
      if (isReadying && myPicks === 0 && pickPool(lobby).length === 0) {
        return fail(res, 400, 'Pick at least one song before readying up.');
      }
      lobby.ready.set(player.id, isReadying);
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

    case '/api/lobby/difficulty': {
      const lobby = roomFor(player);
      if (!lobby) return fail(res, 404, 'You are not in a lobby.');
      if (player.id !== lobby.hostId) return fail(res, 403, 'Only the host can change the difficulty.');
      if (lobby.phase !== 'picking') return fail(res, 409, 'Cannot change difficulty after the song starts.');
      if (body.difficulty && !DIFFICULTIES.includes(body.difficulty)) {
        return fail(res, 400, `difficulty must be one of ${DIFFICULTIES.join(', ')}`);
      }
      if (body.variation && !VARIATIONS.includes(body.variation)) {
        return fail(res, 400, `variation must be one of ${VARIATIONS.join(', ')}`);
      }
      if (body.difficulty) lobby.difficulty = body.difficulty;
      if (body.variation) lobby.variation = body.variation;
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

    // Lightweight polling channel used by the duel HUD. Clients submit their
    // current tally and receive the opponent's latest state in the snapshot.
    case '/api/lobby/live': {
      const lobby = roomFor(player);
      if (!lobby) return fail(res, 404, 'You are not in a lobby.');
      if (lobby.phase !== 'playing') return fail(res, 409, 'The match is not running.');
      lobby.live.set(player.id, {
        score: Math.max(0, Math.min(100_000_000, Math.round(Number(body.score) || 0))),
        misses: Math.max(0, Math.min(100_000, Math.round(Number(body.misses) || 0))),
        combo: Math.max(0, Math.min(100_000, Math.round(Number(body.combo) || 0))),
        animation: typeof body.animation === 'string' ? body.animation.slice(0, 40) : 'idle',
        hits: sanitizeHits(body.hits),
      });
      lobby.updatedAt = now();
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

    let reqPath;
    try {
      reqPath = new URL(req.url, 'http://localhost').pathname;
    } catch {
      return fail(res, 400, 'Bad URL');
    }

    // Tester endpoint
    if ((reqPath === '/test' || reqPath === '/tester' || reqPath === '/test/' || reqPath === '/tester/') && req.method === 'GET') {
      const page = fs.readFileSync(path.join(__dirname, 'public', 'index.html'), 'utf8');
      res.writeHead(200, { 'content-type': 'text/html; charset=utf-8', 'access-control-allow-origin': '*' });
      return res.end(page);
    }

    // Serve static files or game files on GET requests (non-API)
    if ((req.method === 'GET' || req.method === 'HEAD') && !reqPath.startsWith('/api/') && reqPath !== '/healthz') {
      const headOnly = req.method === 'HEAD';
      // docs/ is the web build that ships in the repo: GitHub Pages serves it
      // and this server serves it too, so one push hosts both.
      const html5Dirs = [
        path.resolve(__dirname, '..', 'docs'),
        path.resolve(__dirname, '..', 'game', 'export', 'release', 'html5', 'bin'),
        path.resolve(__dirname, '..', 'game', 'export', 'debug', 'html5', 'bin'),
      ];

      const relativePath = reqPath === '/' ? '/index.html' : reqPath;
      const decodedPath = decodePath(relativePath);
      const safePath = path.normalize(decodedPath).replace(/^(\.\.[\/\\])+/, '');

      // Check HTML5 game builds first
      for (const dir of html5Dirs) {
        const target = path.join(dir, safePath);
        if (target.startsWith(dir) && tryServeGameFile(res, target, headOnly)) {
          return;
        }
      }

      // Check server public directory
      const publicTarget = path.join(__dirname, 'public', safePath);
      if (publicTarget.startsWith(path.join(__dirname, 'public')) && tryServeFile(res, publicTarget, headOnly)) {
        return;
      }

      // Fallback for root: serve public index.html tester
      if (reqPath === '/') {
        const page = fs.readFileSync(path.join(__dirname, 'public', 'index.html'), 'utf8');
        res.writeHead(200, { 'content-type': 'text/html; charset=utf-8', 'access-control-allow-origin': '*' });
        return res.end(page);
      }

      // A missing file is a 404, not an authentication failure.
      return fail(res, 404, 'Not found');
    }

    route(req, res, reqPath)
      .catch((err) => {
        console.error('[fnf-online] request failed', reqPath, err);
        if (!res.headersSent) fail(res, 400, err.message || 'Bad request');
        else res.end();
      });
  });
}

if (require.main === module) {
  const port = Number(process.env.PORT) || 8080;
  const server = createServer();
  server.listen(port, '0.0.0.0', () => {
    const ips = getLocalIps();
    console.log('\n===============================================================');
    console.log('  FNF ONLINE MULTIPLAYER SERVER');
    console.log('===============================================================');
    console.log(`  Local (this machine):    http://localhost:${port}`);
    if (ips.length > 0) {
      for (const ip of ips) {
        console.log(`  Network (other devices): http://${ip}:${port}`);
      }
    } else {
      console.log(`  Network (other devices): http://<Your-LAN-IP>:${port}`);
    }
    console.log('---------------------------------------------------------------');
    console.log(`  * Tester page:           http://localhost:${port}/test`);
    console.log(`  * Web game (HTML5):      http://localhost:${port}/`);
    console.log('===============================================================\n');

    const primaryIp = ips[0] || 'localhost';
    const serverUrl = `http://${primaryIp}:${port}`;
    try {
      fs.writeFileSync(path.resolve(__dirname, '..', 'server.txt'), serverUrl + '\n', 'utf8');
      fs.writeFileSync(path.resolve(__dirname, '..', 'game', 'server.txt'), serverUrl + '\n', 'utf8');
      console.log(`[fnf-online] Wrote server.txt -> ${serverUrl}\n`);
    } catch (_) {}
  });
  const shutdown = () => server.close(() => process.exit(0));
  process.on('SIGTERM', shutdown);
  process.on('SIGINT', shutdown);
}

module.exports = { createServer, compareResults, MODES, DIFFICULTIES };
