# CUTOS production deployment — exact checklist

This document exists because a correct repository and a working production site
turned out to be different things, and nothing in the system could tell them
apart. Everything below is either a setting you must apply by hand in the
Zeabur dashboard (which no code in this repo can read or change) or a command
you can run to get a definitive answer.

**Nobody working on this repo has access to the Zeabur dashboard.** Every item
in §2 has to be checked by a human. §1 and §5 are the parts you can verify from
a terminal in under a minute.

---

## 1. First: is production even running the current build?

Run this against the live site before changing anything.

```sh
curl -s https://<your-app>.zeabur.app/api/version
```

Expected on a current build:

```json
{
  "gitSha": "…",
  "gitShaShort": "…",
  "gitBranch": "main",
  "buildTime": "2026-…",
  "appVersion": "0.1.0",
  "uploadProtocolVersion": 2,
  "source": "env:ZEABUR_GIT_COMMIT_SHA",
  "environment": "production",
  "nodeVersion": "v22…"
}
```

How to read it:

| Result | Meaning |
| --- | --- |
| `404` | The deployment predates this build entirely. **Production is stale.** |
| `uploadProtocolVersion` is `1` or missing | The deployment predates PR #12. Uploads still buffer the whole file in memory. **Production is stale.** |
| `gitSha` ≠ the commit you expect on `main` | Zeabur is building a different commit — see §2.1 and §2.9. |
| `gitBranch` ≠ `main` | Zeabur is deploying the wrong branch — see §2.1. |
| `gitSha` is `null` and `source` is `"unknown"` | The build could not determine its commit. Non-fatal, but §2.6 fixes it. |

There is a second, independent check that needs no endpoint at all. The
pre-PR#12 UI showed a single never-resolving string during upload:

```sh
curl -s https://<your-app>.zeabur.app/ | grep -c "正在上傳並讀取影片"
```

`0` is correct. Anything above `0` means the deployment is running code from
before PR #12 (commit `5d46c97`), which deleted that string. This is the
strongest available evidence and it works even against a build with no
`/api/version`.

---

## 2. Zeabur settings to check by hand

### 2.1 Deployment branch and commit

- Service → **Settings → Git**: the deployed branch must be `main`.
- Confirm the latest deployment's commit matches `origin/main`.
- If the branch is right but the commit is old, Zeabur did not pick up the
  push — trigger a manual redeploy and see §2.9.

### 2.2 Root directory

- Must be the **repository root** (`/` or empty), **not** `apps/web`.
- This is a pnpm workspace. Building from `apps/web` cannot resolve the
  `workspace:*` dependencies (`@cutos/media`, `@cutos/storage`, …) and the
  build will fail or, worse, silently serve a stale image.

### 2.3 Build and start commands

If Zeabur is using its auto-detected Node buildpack:

| Setting | Value |
| --- | --- |
| Install | `pnpm install --frozen-lockfile` |
| Build | `pnpm build` |
| Start | `pnpm start` |

`pnpm start` runs `next start -H 0.0.0.0`, and Next reads `PORT` from the
environment, so no port flag is needed.

**Strongly preferred: build from the `Dockerfile` in the repository root
instead** (Service → Settings → **Build → Dockerfile**). See §3 for why this is
not optional in practice.

### 2.4 Persistent volume — the setting that loses people's videos

- Service → **Volumes**: mount a persistent volume, e.g. at `/data`.
- Without one, uploaded videos, the SQLite databases and all exported media live
  in the container's writable layer and are **destroyed on every redeploy and
  every restart**. The site appears to work until it restarts, then every
  project is gone.
- Size it for real use: a 500 MB upload limit plus exports means tens of GB, not
  hundreds of MB.

### 2.5 Environment variables

Required:

| Variable | Value | Why |
| --- | --- | --- |
| `CUTOS_DATA_DIR` | `/data` (the volume mount path from §2.4) | Where uploads, SQLite and exports live. Must be on the persistent volume. |

Recommended, and specific to the platform's ingress limits:

| Variable | Suggested | Why |
| --- | --- | --- |
| `CUTOS_MAX_REQUEST_BYTES` | `8388608` (8 MB) | Must stay **below** whatever Zeabur's proxy accepts for a single request body. Too high and every chunk returns 413. |
| `CUTOS_UPLOAD_CHUNK_BYTES` | `5242880` (5 MB) | Chunk size handed to the browser. Must be ≤ `CUTOS_MAX_REQUEST_BYTES`; the server clamps it and `/api/health` reports `CHUNK_CLAMPED` if it had to. |
| `CUTOS_MAX_UPLOAD_BYTES` | `524288000` (500 MB) | Total file-size ceiling. Independent of the per-request limit — that decoupling is what lets a 500 MB video through an 8 MB ingress. |
| `NODE_ENV` | `production` | |

Do **not** set `CUTOS_STORE=memory` in production; `/api/health` reports it as
degraded because every project is lost on restart.

Optional:

| Variable | When |
| --- | --- |
| `CUTOS_FFMPEG_PATH` / `CUTOS_FFPROBE_PATH` | Only if the binaries are not on `PATH`. |
| `CUTOS_DATA_DIR_EPHEMERAL=0` | Silences the ephemeral-storage warning when you know the mount is durable but the path looks temporary. |
| `CUTOS_SKIP_PREFLIGHT=1` | Skips startup validation. Not recommended — it exists for tests. |

`ZEABUR_GIT_COMMIT_SHA` and `ZEABUR_GIT_BRANCH` are injected by the platform;
`/api/version` picks them up automatically if they are present. Nothing to set.

### 2.6 ffmpeg and ffprobe — the setting that breaks every upload

**A generic Node buildpack does not install ffmpeg.** CUTOS is a video editor:
without `ffprobe` every upload is accepted, stored, and then fails to probe. The
user sees their video upload successfully and then get no duration, no timeline
and no preview.

Confirm with:

```sh
curl -s https://<your-app>.zeabur.app/api/health | grep -o '"name":"ffprobe","status":"[a-z]*"'
```

If this is anything other than `"status":"ok"`, use the Dockerfile (§3). There
is no environment variable that can conjure a missing binary.

### 2.7 Memory

- Give the service at least **1 GB**, preferably 2 GB.
- ffmpeg export and analysis are memory-hungry. An OOM kill mid-probe is the
  ordinary way a project ends up stuck in `probing` forever (the runtime
  reconciles those back to a retryable `failed`, but the export still died).

### 2.8 Health checks

- Point any platform health check at **`/api/ready`**, not `/api/health`.
- `/api/ready` answers 503 when the deployment genuinely cannot do video work.
- `/api/health` deliberately answers **200 even when subsystems are down**, so
  the report stays readable during an outage. Pointing a restart-on-failure
  probe at it would never restart; pointing one at it with `?strict=1` would.

### 2.9 Redeploy cache and watch paths

- If Zeabur has **watch paths** / path filters configured, make sure they do not
  exclude the directories that actually changed. A filter of `apps/web/**` will
  silently skip a push that only touched `packages/**` or the `Dockerfile` — the
  push succeeds, no deployment happens, and production stays on the old commit
  with no error anywhere. **This is a leading candidate for why production is
  stale.**
- Clear the build cache and redeploy after changing the build method, the root
  directory, or the Dockerfile.
- After any redeploy, re-run §1. Do not trust the dashboard's "deployed" badge
  on its own — `/api/version` is the authority.

---

## 3. Use the Dockerfile

The repository root contains a `Dockerfile` that:

- installs `ffmpeg` (providing both `ffmpeg` and `ffprobe`) and verifies both
  run during the image build, so a broken image fails at build time rather than
  at a user's first upload;
- installs the workspace with `--frozen-lockfile`;
- accepts `ZEABUR_GIT_COMMIT_SHA` / `ZEABUR_GIT_BRANCH` as build args so
  `/api/version` can report the commit even though the image has no `.git`;
- defaults `CUTOS_DATA_DIR` to `/data` (still mount a volume there — §2.4);
- runs as a non-root user;
- starts with `pnpm start`, the same command used in development and CI.

In Zeabur: Service → Settings → Build → **Dockerfile**, with the root directory
set to the repository root.

If Zeabur does not pass git build args automatically, add them under build
arguments:

```
ZEABUR_GIT_COMMIT_SHA=$ZEABUR_GIT_COMMIT_SHA
ZEABUR_GIT_BRANCH=$ZEABUR_GIT_BRANCH
```

This is only for the build-time stamp; the runtime environment variables are
read first regardless, so `/api/version` still reports correctly without it.

---

## 4. What each endpoint is for

| Endpoint | Purpose | Status codes |
| --- | --- | --- |
| `GET /api/version` | Which commit and upload protocol is running | 200 |
| `GET /api/health` | Per-subsystem report with reasons and remedies | 200 always; `?strict=1` → 503 when down; `?fresh=1` skips the 30 s ffmpeg cache |
| `GET /api/ready` | Can this deployment do video work | 200 ready / 503 not |

`/api/health` reports on: `app`, `dataDirWritable`, `database`, `storage`,
`uploadSubsystem`, `jobWorker`, `ffprobe`, `ffmpeg`.

`/api/ready` distinguishes two capabilities:

- `canAcceptUploads` — storage, database, data directory, upload staging. When
  this is false the UI **blocks the upload button** and shows a configuration
  error, because bytes sent to this deployment would be destroyed.
- `canProcessMedia` — ffprobe, ffmpeg, job worker. When this is false the UI
  shows a **warning but still allows uploads**: the bytes are safe, the project
  is created, and the workspace opens. The user is not locked out.

The same information is available in the UI behind the **系統狀態** button in
the header. Its dot turns amber or red on its own when a subsystem is unhealthy.

---

## 5. Verify the deployment end to end

There is a real smoke test in the repository. It uploads an actual 2-second
H.264 file in chunks, finalizes it, waits for the probe job, opens the project,
and asks for a byte range the way a `<video>` element does. Nothing is mocked.

```sh
pnpm smoke https://<your-app>.zeabur.app
# or: node scripts/production-smoke.mjs https://<your-app>.zeabur.app
```

It exits non-zero if any required step fails, and prints the build it tested
against. A passing run means a person can upload a video to that URL and reach
the workspace.

It deletes the project it created, so it is safe to run against production.

---

## 6. Startup validation

The server validates itself at boot, before it serves a request, and logs every
result. On a healthy deployment:

```
{"level":"info","msg":"CUTOS startup preflight","gitSha":"…","dataDir":"/data",…}
{"level":"info","msg":"preflight ok: dataDirWritable",…}
{"level":"info","msg":"preflight ok: ffprobe",…}
{"level":"info","msg":"CUTOS preflight passed; ready to accept video work"}
```

On a broken one, each failure is logged at `error` with a reason, a summary and
a remedy:

```
{"level":"error","msg":"preflight FAILED: dataDirWritable",
 "reason":"DATA_DIR_UNCREATABLE",
 "summary":"Could not create the data directory at /etc/…",
 "remedy":"Set CUTOS_DATA_DIR to a path on a persistent volume the container can write to.",
 "detail":{"error":"ENOTDIR: not a directory, mkdir '/etc/…'"}}
{"level":"error","msg":"CUTOS is NOT ready to accept video work","failing":["dataDirWritable",…]}
```

The preflight never exits the process. A server that refuses to boot cannot
serve `/api/health`, which is the tool you need to find out why it will not
boot — so it reports and keeps serving.

---

## 7. Quick triage

| Symptom | Look at |
| --- | --- |
| Upload spinner never finishes on a phone | §1 — production is almost certainly a pre-PR#12 build |
| Upload completes, then no duration/timeline/preview | §2.6 — ffprobe is missing |
| Projects vanish after a redeploy | §2.4 and §2.5 — no persistent volume, or `CUTOS_DATA_DIR` not pointing at it |
| Every chunk returns 413 | §2.5 — `CUTOS_UPLOAD_CHUNK_BYTES` above the ingress limit |
| Pushes to `main` do not deploy | §2.9 — watch paths, or the wrong branch |
| Export fails on larger videos | §2.7 — raise memory |
| `/api/version` 404s | The deployment predates this build entirely |
