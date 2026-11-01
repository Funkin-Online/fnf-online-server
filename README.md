# Funkin Online — V-Slice engine + 1v1 online

A fork of **Friday Night Funkin' V-Slice (FNF 1.0)** rebranded as **Funkin Online**, with:

- the **MERCH** main-menu item replaced by a custom **ONLINE** button,
- **host / join / find match** 1v1 lobbies with 6-digit codes,
- shared song picking (searchable list, one song chosen at random),
- a post-song scoreboard that decides the winner,
- a tiny **Node server** with no dependencies, deployed to **Render**,
- the same web build published to **GitHub Pages**.

```
fnf-online/
├─ game/          the V-Slice source (marker: not committed — huge assets submodule)
├─ server/        the lobby/matchmaking server (Node, zero deps)
├─ docs/          the built HTML5 game — this is what GitHub Pages serves
├─ tools/         build-docs.js: export build -> docs/
├─ render.yaml    Render blueprint
└─ .github/workflows/keepalive.yml   keeps the free Render service awake
```

The deployable content of this folder is **`server/`, `docs/`, `render.yaml` and
`.github/`**. `game/` stays on this machine.

---

## 1. One URL does everything

The Render service is both the lobby server **and** the game host:

| What | Where |
| --- | --- |
| Game (web) | `https://<service>.onrender.com/` |
| Lobby/multiplayer tester | `https://<service>.onrender.com/test` |
| Health check | `https://<service>.onrender.com/healthz` |

GitHub Pages serves the *same* `docs/` bundle as a static mirror at
`https://funkin-online.github.io/fnf-online-server/`. The page is pre-wired to
talk to the Render service for multiplayer, so both URLs can play online.

Nothing has to run on your PC any more.

---

## 2. Deploy the server to Render

The repo `Funkin-Online/fnf-online-server` is already pushed and `render.yaml`
is at its root.

1. <https://dashboard.render.com> → **New +** → **Blueprint**.
2. Pick `Funkin-Online/fnf-online-server`.
3. **Apply.** Render creates the `fnf-online-server` web service with:
   - root dir `server`, runtime Node
   - build `npm install --omit=dev`, start `npm start`
   - health check `/healthz`, plan Free
4. When it goes live, open the URL. `/healthz` answers
   `{"ok":true,...}` and `/` serves the game.

`autoDeploy` is on, so every push to `main` redeploys the service.

**If Render picks a different service name**, the URL changes. Two places
mention it:

- `render.yaml` (`name:`) — only cosmetic for the dashboard;
- `https://fnf-online-server.onrender.com` in `docs/index.html` and
  `tools/build-docs.js` — this is the URL the web game calls.

After changing the name, run `node tools/build-docs.js` and push (or set the
repo variable `FNF_SERVER_URL` and run the **keep-server-awake** workflow once
to confirm the new URL answers).

### Keep it awake

Free services sleep after ~15 minutes idle and the first request then takes
~30 s — longer than the game's 12 s timeout. `.github/workflows/keepalive.yml`
pings `/healthz` every 10 minutes so that stops happening. It needs no setup
unless your service URL differs, in which case set the Actions **variable**
`FNF_SERVER_URL` (Settings → Secrets and variables → Actions → Variables).

Note: GitHub pauses scheduled workflows after 60 days without repo activity.
Push something, or re-run the workflow, to turn it back on.

---

## 3. GitHub Pages

Pages is configured to serve the `main` branch, `/docs` folder:

```
https://funkin-online.github.io/fnf-online-server/
```

`docs/` ships `.nojekyll` so Pages serves every asset byte-for-byte.

To republish after changing the game:

```bat
publish.bat
```

That runs the HTML5 build, rebuilds `docs/`, commits and pushes — Pages and
Render both pick it up. To only rebuild the folder:

```bat
node tools\build-docs.js
```

### Choosing the server in the web build

`docs/index.html` sets

```js
window.FNF_ONLINE_SERVER = 'https://fnf-online-server.onrender.com';
```

before the game starts, so a static host still finds the lobby server. Override
without rebuilding by opening the page with a query string:

```
https://funkin-online.github.io/fnf-online-server/?server=https://my-service.onrender.com
```

The choice is saved in `localStorage`. Clearing the browser's site data goes
back to the baked-in default.

---

## 4. Build the game (only when you change the code)

Requirements: **Haxe 4.3.x**, **Neko**, and the project's haxelibs —
already installed on this machine (`C:\HaxeToolkit`).

```bat
cd game
haxelib run lime build html5 -debug      :: or: windows / mac / linux
```

`publish.bat` does this for you. Output lands in `game/export/debug/html5/bin`.

### The ONLINE button art

The atlas lives in the assets submodule, so a submodule update can wipe it.
A backup is kept in `online-art-backup/` and copied back by the build script.

To regenerate it from the source PNG:

```bat
powershell -ExecutionPolicy Bypass -File game\tools\make-online-atlas.ps1 ^
  -Source "C:\Users\bencr\Downloads\New Project (23).png"
```

---

## 5. Running the server locally (optional)

Not required any more — this is only for offline development.

```bat
cd server
npm start
:: http://localhost:8080  — game, tester and API on one port
```

Opening the game from `http://localhost:8080/` makes the client use that origin
as the server automatically. `server.txt` is written with your LAN IP for other
devices; `OPEN_FIREWALL.bat` opens port 8080 once, as Administrator.

---

## 6. How the online flow works

```
Main menu ──ONLINE──▶ ONLINE menu
                       ├─ HOST GAME      -> 6-digit code, wait for a friend
                       ├─ JOIN WITH CODE -> type the code
                       └─ FIND MATCH     -> queue, paired with the next player
                                │
                                ▼
                             LOBBY
             share code · pick songs (search) · SPACE ready
             host: ←/→ win condition = SCORE / ACCURACY / MISSES
                                │  both ready + at least one pick each
                                ▼
                  server picks ONE song at random from both picks
                                │
                                ▼
                          PlayState (normal FNF)
                                │  song ends (or you die)
                                ▼
                       ONLINE RESULTS  (poll for the opponent)
                     winner by the lobby's win condition · ENTER rematch
```

**Win conditions**

| Mode | Winner |
| --- | --- |
| Score | highest score |
| Accuracy | highest weighted accuracy |
| Misses | fewest misses |
| any | a player who dies (fails the song) always loses |

`FIND MATCH` lobbies are locked to **score**. Host lobbies can switch mode.

**Matchmaking** only pairs players whose installed song lists overlap, so a
match can always be played.

---

## 7. Server API

All endpoints are `POST` with JSON; pass `token` from `/api/session`.

| Endpoint | Body | Notes |
| --- | --- | --- |
| `/api/session` | `{name?}` | returns `playerId`, `token` |
| `/api/lobby/create` | `{songs:[{id,name}]}` | returns 6-digit `code` |
| `/api/lobby/join` | `{code, songs}` | 1v1 cap |
| `/api/match/find` | `{songs}` | pairs with the next compatible waiter |
| `/api/match/cancel` | | leave the queue |
| `/api/lobby/state` | | full lobby snapshot + `countdownMs`/`serverTime` |
| `/api/lobby/pick` | `{songs:[id]}` | replaces your picks, un-readies you |
| `/api/lobby/ready` | `{ready}` | both ready ⇒ song starts |
| `/api/lobby/mode` | `{mode}` | `score` / `accuracy` / `misses`, host only |
| `/api/lobby/difficulty` | `{difficulty, variation}` | host only |
| `/api/lobby/start` | | force start (host) |
| `/api/lobby/live` | `{score,misses,combo,animation,hits}` | in-song duel HUD |
| `/api/lobby/result` | `{score,accuracy,misses,maxCombo,totalNotes,failed}` | both must submit |
| `/api/lobby/rematch` | | back to picking |
| `/api/lobby/leave` | | leaving mid-song = forfeit |
| `/healthz` | | Render health check |

CORS is `*` on every response and `OPTIONS` preflights are answered, so a page
on `github.io` can call the Render service directly.

Run the test suite:

```bat
cd server
npm test
```

It boots the server on a random port and walks two players through host/join,
mode switching, random song selection, all three win conditions, forfeits,
rematches and matchmaking.

---

## 8. Hosting reality check

- **Render free tier** sleeps after 15 minutes idle; the keep-alive workflow
  fixes that. Lobbies are in memory: a redeploy or a sleep mid-match loses the
  lobby (the client makes a fresh session and you re-host).
- **GitHub Pages** is static only — it cannot run the lobby server, which is why
  the web build points at Render. Pages sites are capped around 1 GB; `docs/`
  deliberately drops the cutscene videos (~130 MB) to stay well under.
- **Cutscenes**: the web build has no `assets/videos`, so story-mode videos do
  not play there. The Windows build from `game/` still has them.
- **Bandwidth**: each player downloads only the assets for the song they play,
  not the whole 650 MB folder.

## 9. Known limitations (v1)

- 1v1 only (the server enforces `MAX_PLAYERS = 2`).
- Both players need the same song installed and roughly the same game version.
- Keyboard-driven menus (no mobile/touch UI yet).
- No accounts: a "session" is an in-memory token, so lobbies are friend-code
  only.
