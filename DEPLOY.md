# Upload to Render — these files only

Render cannot take loose file uploads; it deploys from a **Git repo** (or a Docker image).
So put these files in a GitHub repo, then let Render read `render.yaml`.

```
render-upload/
├─ render.yaml            <- Render blueprint (rootDir: server)
└─ server/
   ├─ .gitignore
   ├─ package.json        <- no dependencies at all
   ├─ server.js           <- the whole server
   └─ public/index.html   <- browser tester (open the live URL to use it)
```

## 1. Put them on GitHub

1. Go to <https://github.com/new> → name e.g. `fnf-online` → **Create repository**.
2. On the empty repo page click **uploading an existing file**.
3. Open `render-upload` and drag **`render.yaml`** and the **`server` folder** into the page.
   (Dragging the folder keeps the paths — you must end up with `render.yaml` and `server/`
   side by side at the repo root, not everything flattened into one folder.)
4. Commit.

## 2. Deploy on Render

1. <https://dashboard.render.com> → **New +** → **Blueprint**.
2. Pick the repo → **Apply**.
3. Render creates the `fnf-online-server` web service and gives you a URL like
   `https://fnf-online-server.onrender.com`.

If you prefer a manual service instead of the blueprint:
**New +** → **Web Service** → repo → Root Directory `server`, Runtime **Node**,
Build `npm install --omit=dev`, Start `npm start`, Health Check `/healthz`, plan Free.

## 3. Test it

Open the Render URL in a browser — you get the tester page.
Click **Create lobby**, copy the 6-digit code, open the URL again in an incognito window,
**Join** with that code, pick a song in both, **Ready** in both.

## 4. Point the game at it

`game/source/funkin/online/OnlineConfig.hx`:

```haxe
public static final DEFAULT_SERVER:String = 'https://fnf-online-server.onrender.com';
```

or launch with `set FNF_ONLINE_SERVER=https://your-url.onrender.com`.

Free plan facts: sleeps after 15 minutes idle (first request takes ~30 s, the game
times out at 12 s so just retry), and match state is in memory, so a redeploy during a
match loses the lobby.
