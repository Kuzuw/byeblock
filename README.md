# ByeBlock

ByeBlock lets you play SoundCloud tracks that are geoblocked ("Not available in your country") or cut to a 30-second preview where you live.

This is a 2026 rewrite of [jariz/byeblock](https://github.com/jariz/byeblock) (2016), which stopped working years ago: SoundCloud rebuilt its web app, Chrome removed Manifest V2, and the original `geoblock.lol` server is gone.

## How it works

1. A small script runs inside soundcloud.com before the web app loads and watches its calls to `api-v2.soundcloud.com`.
2. When a response contains tracks with policy `BLOCK` or `SNIP`, ByeBlock asks **your proxy server** (running in another country) for the same tracks.
3. If they are playable there, their stream info is merged in, so the player shows and plays the full track.
4. When the player asks for the stream URL, that request also goes through the proxy. The audio itself is downloaded straight from SoundCloud's CDN, so playback stays as fast as normal.

Only two kinds of requests ever reach the proxy: track lookups (`/tracks`) and stream URL resolution (`/media/soundcloud:tracks:…`). Your SoundCloud login and cookies are never sent to it.

## What changed from the 2016 version

| | 2016 | 2026 |
|---|---|---|
| Manifest | V2, blocking `webRequest`, synchronous XHR | V3, MAIN-world content script, service worker |
| Hooking | Patched hard-coded webpack module numbers (`59`, `265`) | Patches API responses, so it does not depend on SoundCloud's bundle layout |
| Server | Hard-coded `geoblock.lol` (offline) | Your own server, set in the popup |
| Server code | Express + 4 dependencies, separate repo | One file, zero dependencies, Docker and Fly.io config included |
| Browsers | Chrome | Chrome / Edge / Brave (111+) and Firefox (128+) |
| Permissions | Always-on access to `a-v2.sndcdn.com` | `storage` plus access to the proxy you choose, requested when you save it |
| Extras | — | Toggle on/off, connection test, optional access token, badge counter, dark mode, tests and CI |

## Install

### 1. Run a proxy server

The server must run in a country where the tracks you want are available (the US usually works best).

**Easiest: Vercel, one click, free.** Functions run in Washington, D.C. (`iad1`) by default.

[![Deploy with Vercel](https://vercel.com/button)](https://vercel.com/new/clone?repository-url=https%3A%2F%2Fgithub.com%2FKuzuw%2Fbyeblock&project-name=byeblock-proxy&repository-name=byeblock-proxy)

Sign in with GitHub, press *Create*, wait about a minute, then copy the `https://….vercel.app` address into the ByeBlock popup. To limit use to yourself, add an `ACCESS_TOKEN` environment variable in the Vercel project settings, redeploy, and enter the same token in the popup.

**Fly.io** (pick any region):

```sh
cd server
fly launch --no-deploy --copy-config --name my-byeblock   # set primary_region in fly.toml first, e.g. "iad"
fly secrets set ACCESS_TOKEN=$(openssl rand -hex 24)
fly deploy
```

**Docker**, on any VPS:

```sh
docker build -t byeblock-proxy server
docker run -d -p 8787:8787 -e ACCESS_TOKEN=change-me -e REGION=us byeblock-proxy
```

**Plain Node.js 20+**:

```sh
ACCESS_TOKEN=change-me node server/server.mjs
```

Put it behind HTTPS (Fly.io does this for you). Setting `ACCESS_TOKEN` is strongly recommended, otherwise anyone who finds the URL can use your server.

| Variable | Default | Meaning |
|---|---|---|
| `PORT` | `8787` | Port to listen on |
| `HOST` | `0.0.0.0` | Interface to bind |
| `ACCESS_TOKEN` | *(none)* | Required `x-byeblock-token` header value |
| `REGION` | `FLY_REGION` or `unknown` | Label shown in the popup's connection test |

### 2. Load the extension

1. Download the zip for your browser from [Releases](https://github.com/Kuzuw/byeblock/releases): `byeblock-<version>-chrome.zip` or `byeblock-<version>-firefox.zip` (or run `npm run package`).
2. **Chrome / Edge / Brave:** extract it, open `chrome://extensions`, enable *Developer mode*, click *Load unpacked*, and pick the extracted folder. Cloning the repo and loading its root folder works too.
   **Firefox:** open `about:debugging#/runtime/this-firefox`, click *Load Temporary Add-on…*, and pick the Firefox zip.
3. Click the ByeBlock icon, enter your server URL and token, press **Test**, then **Save**, and allow access when the browser asks.
4. Reload SoundCloud. The badge counts how many tracks were unblocked in that tab.

## Development

No dependencies to install. Requires Node.js 20+.

```sh
npm test          # unit tests + a simulated browser run of the page hook + server tests
npm run check     # validates manifest, file references and script syntax
npm run package   # builds dist/byeblock-<version>-{chrome,firefox}.zip
npm run proxy     # starts the proxy locally on :8787
```

```
manifest.json
src/
  core.js         pure helpers (shared by page hook, background and tests)
  page-hook.js    runs in soundcloud.com's own JS world, wraps fetch/XHR
  bridge.js       isolated content script, passes messages to the background
  background.js   service worker; the only part that talks to your proxy
  popup.*         settings UI
scripts/
  firefox-manifest.mjs  derives the Firefox manifest (background.scripts) from manifest.json
server/
  server.mjs      the proxy (zero dependencies)
api/index.js      Vercel entry point for the same proxy (see vercel.json)
test/
```

Publishing a release (or pushing a `v*` tag) makes CI build both zips and attach them to it.

## Limitations

- It can only unblock tracks that are available in your proxy's country. Tracks blocked worldwide stay blocked.
- SoundCloud may change its API at any time. The logic only depends on the `policy`, `media.transcodings` and `track_authorization` fields of track objects, but if those change, this breaks too.
- If SoundCloud starts tying CDN stream URLs to the requesting region, audio would have to be proxied as well, which this version does not do.
- Respect SoundCloud's terms and the rights holders in your country. This is provided as-is, for personal use.

## Contributors

- [Kuzuw](https://github.com/Kuzuw): 2.0 rewrite and maintenance
- [Jari Zwarts (jariz)](https://github.com/jariz): original idea and implementation (2016)

MIT licensed, see [LICENSE.md](LICENSE.md).
