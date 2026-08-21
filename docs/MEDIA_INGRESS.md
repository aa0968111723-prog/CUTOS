# Media ingress: streaming, resumable upload

How a video gets from a phone into a CUTOS project, and why it is shaped this way.

## The failure this replaces

The original path was one multipart request:

```
Request.formData() → File → file.arrayBuffer() → Buffer.from() → writeFile()
                          → probeMetadata()  (ffprobe, inline)
                          → project response
```

Three problems compounded:

1. **Whole-file RAM.** `formData()` materialized the part, `arrayBuffer()` copied it, and
   `Buffer.from()` copied it again. A 300 MB video meant roughly a gigabyte of resident heap
   in a container sized for far less.
2. **ffprobe inside the request.** The HTTP response waited on a media probe, so the request
   stayed open for as long as the analysis took.
3. **A client that could not fail.** `uploadProject()` was a bare `fetch` — no timeout, no
   abort, no progress. When the network, the proxy or the server stalled, that promise never
   settled, so the UI's single `busy` string ("正在上傳並讀取影片…") stayed on screen forever.
   There was no state in which it could clear, because nothing ever rejected.

The visible symptom — a phone stuck on 「正在上傳並讀取影片…」 — was (3), but (1) and (2) are
what made stalling likely in the first place.

## The pipeline now

```
browser                              server
───────                              ──────
POST   /api/uploads              →   validate size + declared mime, open a durable session
                                 ←   { uploadId, chunkBytes, … }

PATCH  /api/uploads/:id?offset=N →   stream socket → disk, append at N
  (repeat, one bounded chunk)    ←   { receivedBytes }          ~milliseconds each

GET    /api/uploads/:id          →   authoritative receivedBytes (resume / recovery)
DELETE /api/uploads/:id          →   cancel: drop the staged bytes

POST   /api/uploads/:id/finalize →   seal object, sniff container, create project,
                                     enqueue `probe`
                                 ←   { projectId }              returns immediately

                                     probe job → ffprobe → duration/size → mediaStatus: ready
                                     analyze job → silence / waveform / transcript
```

Nothing above ever holds the whole file. Chunks stream from the socket into an append-only
staging file; the checksum is computed by streaming that file from disk at finalize.

### Measured

150 MB pushed through a real `next dev` server in 1 MB chunks:

| | |
|---|---|
| server RSS before | 643 MB |
| server RSS peak during upload | 658 MB |
| `finalize` response time | 0.96 s |

The 15 MB of growth is GC slack, not the file. The old path would have added 150–450 MB.

## Key design decisions

### The upload id is the project id

A session stages its bytes directly at `sources/<uploadId>/original`, which becomes the
project's asset key. So sealing an upload is a `rename`, never a copy of a half-gigabyte
file, and finalize is naturally idempotent — a retried request resolves to the same project
before the idempotency claim even runs.

The key is derived entirely from a server-issued UUID. No part of it comes from the client,
and the client never sees it: `UploadSessionDTO` carries no storage key and no path.

### Upload limits are decoupled from request limits

Two separate numbers, because they answer different questions:

| Variable | Default | What it means |
|---|---|---|
| `CUTOS_MAX_UPLOAD_BYTES` | 500 MB | Largest **file** a user may upload, in total. A CUTOS policy limit. |
| `CUTOS_MAX_REQUEST_BYTES` | 8 MB | Largest **single HTTP body**. Must stay under the platform's real ingress limit. |
| `CUTOS_UPLOAD_CHUNK_BYTES` | 5 MB | Chunk size advertised to the browser; clamped to `CUTOS_MAX_REQUEST_BYTES`. |
| `CUTOS_UPLOAD_SESSION_TTL_MS` | 6 h | How long an unfinished session survives before it is swept. |

This is what makes the 500 MB limit honest. No deployment passes a 500 MB request; every
deployment passes a 5 MB one. `GET /api/uploads` returns the effective numbers so the client
never has to guess.

### Upload and probing are separate

`finalize` stores bytes and returns a project. `probe` is a durable job. The project exists
with `mediaStatus: "uploaded" | "probing" | "ready" | "failed"`, so:

- the home screen lists it as 處理中 instead of blocking;
- a probe failure is **not** a lost upload — the asset is intact and
  `POST /api/projects/:id/probe` re-reads it, with no second upload;
- a re-probe replaces the placeholder timeline only when it is untouched, so re-probing a
  project the user has already edited never discards their edits.

### Client state machine

`apps/web/app/lib/upload.ts` replaces the single `busy` string with explicit phases:

```
idle → preparing → uploading → uploaded → probing → ready
                       ↓            ↓         ↓
                   cancelled     failed    failed (canRetryProbe)
```

`ingestVideo()` resolves — it does not reject — for every expected outcome, so a caller
cannot be left busy by a missing `finally`.

Transport is `XMLHttpRequest`, not `fetch`: `fetch` still cannot report upload progress in
shipping browsers, and a progress bar driven by anything other than real bytes is a lie.
Every request carries a deadline, and a stall watchdog aborts a socket that is open but
moving no bytes — the exact shape of the production hang.

Retries are per chunk with exponential backoff. Before retrying, the client asks the server
where it actually got to, so a dropped connection costs the remainder of one chunk rather
than the whole file.

## Security properties

| Risk | Defence |
|---|---|
| Path traversal | Storage keys derive from server-issued UUIDs; `assertValidKey` rejects `..`, absolute and backslash keys; upload ids are pattern-checked before touching a path. |
| Path disclosure | `UploadSessionDTO` carries no storage key. Filenames are display labels only, sanitized of separators and control characters. |
| Forged MIME | The declared content-type is a hint. At finalize the first 4 KB are sniffed against a container allow-list (`packages/media/src/sniff.ts`), and ffprobe is the final gate. |
| Over-sized upload | Enforced against the recorded session, not a header: a chunk is refused on its declared length *and* mid-stream on actual bytes. |
| Incomplete upload treated as media | `finalize` compares staged bytes to the declared size and refuses a short upload. |
| Duplicate finalize | An atomic conditional UPDATE claims the session; the loser replays the winner's project instead of creating a second one. |
| Abandoned sessions | Swept past `expiresAt`, releasing staged bytes. |

## Deploying behind a proxy (Zeabur and similar)

1. **Set `CUTOS_MAX_REQUEST_BYTES` below the platform's body limit.** The default 8 MB is
   safe for common ingress defaults. If the platform is stricter, lower it — the max *file*
   size does not change.
2. **`CUTOS_DATA_DIR` must be a persistent volume.** Sources, staged uploads and the SQLite
   databases all live there. On ephemeral container storage, every redeploy loses them.
3. **Chunk requests are short.** Idle/read timeouts that used to kill a multi-minute upload
   now only have to cover a few seconds per chunk.
4. **ffmpeg and ffprobe must be on `PATH`** in the runtime image, or every probe job fails —
   visibly, as `mediaStatus: "failed"` with a retry button, rather than as a hang.
5. **Sizing:** ingest no longer scales memory with file size, so the container is sized for
   ffmpeg/ffprobe and the Node baseline, not for the largest video a user might pick.

## Resumability and other backends

`ResumableUploadAdapter` (`packages/storage/src/types.ts`) is the contract:

```ts
createUpload({ uploadId, key }) → ResumableUpload
resumeUpload({ uploadId, key }) → ResumableUpload
  .size()                        // durable bytes; the resume offset
  .append(offset, stream, opts)  // rejects a wrong offset with the real one
  .complete()                    // seal → { size, checksum }
  .abort()
```

`LocalStorageAdapter` implements it fully against local disk: the staged file's size *is* the
resume offset, so a restart between chunks costs nothing and needs no separate bookkeeping.
A remote backend maps `createUpload` to S3 `CreateMultipartUpload` (or a GCS resumable
session) and `complete` to `CompleteMultipartUpload`; the routes, the session table and the
client need no changes.

## Tests

| Area | File |
|---|---|
| Resumable adapter, offset/size guards, large-file heap bound | `packages/storage/src/storage.test.ts` |
| Container sniffing, forged MIME | `packages/media/src/sniff.test.ts` |
| Session durability, duplicate finalize, v2→v3 migration | `packages/project-store/src/upload-session.test.ts` |
| Server ingest: size/mime, over-size, offset, resume, probe failure + retry, sweep, sanitization | `apps/web/server/upload.test.ts` |
| Client state machine: progress, cancel, stall, timeout, 413/415/502, always-terminal | `apps/web/app/lib/upload.test.ts` |
| Full HTTP E2E: real routes + real client uploader → playable project, cancel, probe recovery | `apps/web/server/upload-e2e.test.ts` |
