# n8n-nodes-downtify

n8n community nodes for [Downtify](https://github.com/henriquesebastiao/downtify), a self-hosted
music downloader. Queue Spotify, Deezer, YouTube Music and SoundCloud links and wait for the
files. You can also read the queue, library, Playlist Monitor and podcasts, and start workflows
when downloads finish.

Requires n8n 2.45.0 or later. Downtify versions checked: **3.8.1** (tested) and **3.11.0** (the
routes and handlers used by these nodes are unchanged).

> This project is not affiliated with or endorsed by Downtify or its authors.

## Installation

**From npm:** Settings → Community Nodes → Install → `n8n-nodes-downtify`.

### Manual installation (Docker)

1. Copy the package file into the container (here named `n8n`):

```bash
docker cp n8n-nodes-downtify-0.1.0.tgz n8n:/tmp/
```

2. Install it in `~/.n8n/nodes`:

```bash
docker exec -it n8n sh -c "mkdir -p ~/.n8n/nodes && cd ~/.n8n/nodes && npm install --legacy-peer-deps /tmp/n8n-nodes-downtify-0.1.0.tgz"
```

3. Restart n8n:

```bash
docker restart n8n
```

## Credentials

Create a **Downtify API** credential:

| Field | Description |
|---|---|
| Authentication | **Username & Password** (default) or **Device Token** |
| Base URL | Address of the Downtify server, for example `http://downtify.local:8000` or `https://music.example.com/downtify`. It must use http(s) and must not contain a user, query or fragment. Trailing slashes are removed. |
| Username, Password | Username & Password only: a Downtify user |
| Device Token | Device Token only: a device token (`dtfy_…`). Leave it empty only if Downtify runs with `DOWNTIFY_DISABLE_AUTH=true`. |

Every request carries a device token as `Authorization: Bearer`.

**Username & Password.** n8n signs in once with `POST /api/auth/token` and stores the device
token it receives in the credential. The token is kept encrypted with the credential and never
sent to the browser. Later runs reuse it. n8n signs in again only when Downtify answers 401 (for
example after the device was revoked) or after you change the Base URL, username or password.
The stored token is sent only to the server and for the user it was issued for. Each sign-in
adds a device named `n8n` in Downtify under Settings → Apps.

**The Test button can add a new device each time.** In n8n 2.45 every credential test runs the
sign-in step, and n8n tests the credential automatically each time you save it. The node keeps the
stored token when Downtify still accepts it. But right after you create or change the credential,
the form does not have the token yet, so each Save or Test there signs in again and adds one more
`n8n` device. Revoke the devices you no longer use under Settings → Apps.

If password sign-in is turned off on the server (`DOWNTIFY_DISABLE_AUTH`, or
`DOWNTIFY_DISABLE_LOCAL_LOGIN` in newer versions), Downtify answers 409: use Device Token.

**Device Token.** Use a token you already have, for example one created with:

```bash
curl -s -X POST http://downtify.local:8000/api/auth/token \
  -H 'Content-Type: application/json' \
  -d '{"username":"n8n","password":"…","device_name":"n8n","platform":"n8n"}'
```

**Use a dedicated non-admin user for n8n.** A device token always has Downtify's *client* scope,
but some lists depend on the user's role: with an admin user's token, the queue and podcast
lists show every user's items. With a normal user, the node sees and triggers only on that
user's downloads.

The credential test calls `GET /api/me`. With Username & Password, a wrong username or password
is reported by the sign-in step. With Device Token, a 401 means the token is wrong or was
revoked, or the server requires a token.

## Node: Downtify

The node uses only endpoints that Downtify allows for a device token. It never pauses or resumes
the queue, deletes files, changes settings or manages users.

| Resource | Operations |
|---|---|
| Download | **Download URL**: resolve a track, album or playlist link, queue its tracks and wait for them |
| Queue | Get Many (status filter), Get State |
| Resolve & Search | Resolve URL, Search Songs, Search (finder: songs, albums, artists), Get Artist Albums (with album/EP/single/compilation type) |
| Library | Get Summary, Get Albums, Get Artists, Get Tracks (artist/album/playlist/text filters), Get Track, Get Playlists, **Find Album** (is an artist + title already in the library?) |
| Playlist Monitor | Get Many (read-only) |
| Podcast | Get Shows, Get Show, Get Episodes, Search, Resolve (preview), **Download Episode** |
| Server | Health, Version, Get Me |
| Custom API Call | Method, relative path, query and JSON body. Only device-token endpoints are allowed. |

Lists support **Return All / Limit** and **Split Into Items** (one item per entry, on by default).
Errors carry Downtify's own message. With *Continue On Fail* the failing item returns `{ error }`.

### Download URL

Download URL calls `GET /api/url/resolve`, then queues the tracks with
`POST /api/download/batch`. For playlists, it sends the playlist link, so Downtify uses a playlist
folder and, if **Generate M3U** is on, an M3U file. Artist links are refused: use **Get Artist
Albums** and download an album link instead.

| Option | Default | |
|---|---|---|
| Wait For Completion | on | Poll the queue until every job of this request has finished |
| Poll Interval / Timeout | 5 s / 3600 s | Minimum 1 s, maximum 24 h (also from expressions). The timeout covers retries too. |
| Retry Failed Tracks | 1 | Queue failed tracks again this many times (0–5) |
| Fail On Error | on | If off, the summary is returned with failed and pending tracks |
| Skip If In Library | off | Albums only: queue nothing if Find Album finds the album; the summary has `skipped: true` |

The node follows only the job IDs that Downtify returns for this request. In Downtify a job ID is
the track's ID. A finished job with the same ID is restarted, and a job that is still running is
shared with this request. Output:

```json
{
  "url": "https://www.deezer.com/album/302127", "kind": "album", "title": "Discovery", "artist": "Daft Punk",
  "status": "completed", "totalTracks": 14, "downloaded": 13, "alreadyPresent": 1,
  "failedCount": 0, "failed": [], "files": ["Daft Punk/Discovery/01 One More Time.mp3"],
  "existingFiles": ["…"], "jobIds": ["3135556", "…"], "retries": 0
}
```

`status` is `completed`, `completedWithErrors`, `queued` (no waiting), `timeout`, `paused` or
`skipped`. After a timeout, the downloads keep running in Downtify.

**"Download again if the file exists"** (Downtify settings): when it is **on** (the Downtify
default), every track is downloaded again and overwrites the existing file, so `alreadyPresent`
stays 0. When it is **off**, Downtify does not download tracks that are already in the library
and counts them as `alreadyPresent` (`existingFiles`). Use **Skip If In Library** to skip a whole
album without queueing anything.

**Paused queue:** a device token cannot resume the queue. If the queue is paused before the
tracks are queued, Download URL and Download Episode fail with a clear message. If it is paused
while the node waits, Download URL fails too, or returns `status: paused` when Fail On Error is
off. An admin must resume the queue in the Downtify web interface.

### Download Episode

Downtify answers only after the episode is saved. **Timeout** (default 1 h, max 24 h) limits
the wait.

## Trigger: Downtify Trigger

Polling trigger. The first run records the current state without firing. In test mode the
trigger returns a real sample.

| Event | Fires when |
|---|---|
| Download Finished | A track job ends `done` (filters: artist, album; optionally without already present tracks) |
| Download Failed | A track job ends `error`, with Downtify's message |
| Batch Finished | Every job of an album in the queue has finished (album title + album artist); with downloaded, already present and failed counts |
| New Podcast Episode Downloaded | An episode of a subscribed show gets a file (filter: show IDs; max shows read per poll) |

Events are deduplicated by job ID + status. When a track is queued again, a new event fires when
it finishes. The trigger only sees what is in Downtify's queue and remembers up to 10,000 entries.

Example item for **Batch Finished**:

```json
{
  "event": "batchFinished", "album": "Discovery", "artist": "Daft Punk", "total": 14,
  "downloaded": 13, "alreadyPresent": 0, "failedCount": 1,
  "failed": [{ "jobId": "3135563", "title": "Digital Love", "artist": "Daft Punk", "message": "Error: …" }],
  "files": ["…"], "jobIds": ["…"]
}
```

## Security

- The token is sent only in the `Authorization: Bearer` header. It is never placed in a URL, and
  it is removed from outputs, errors and messages. A token received by signing in is handled the
  same way.
- The password is sent only in the JSON body of `POST /api/auth/token`, never in a URL, output,
  error or log. Sign-in errors are rebuilt without the original request.
- No redirect is followed. Every request has a timeout and a response size limit (64 MiB),
  enforced by n8n's HTTP client without extra timers.
- Values used in paths (track, show and episode IDs) are validated and encoded. Custom API Call
  refuses absolute URLs, path traversal (also percent-encoded) and endpoints that need an admin
  or a browser.
- Poll interval, timeout, retries, limits and shows per poll are checked even when set by
  expressions. Trigger state is bounded.
- No runtime dependencies.

## Support

If this node saves you time, you can [buy me a coffee](https://buymeacoffee.com/FDalCol).

## License

[MIT](LICENSE) © FDalCol
