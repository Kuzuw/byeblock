#!/usr/bin/env node
/**
 * ByeBlock proxy server.
 *
 * Forwards a small allow-list of SoundCloud api-v2 requests, so the extension
 * can see tracks the way they look from this server's region. It never
 * touches audio: stream URLs it returns point straight at SoundCloud's CDN.
 *
 *   GET /health              -> { ok, region, version, authorized }
 *   GET /api-v2/<path>?<qs>  -> https://api-v2.soundcloud.com/<path>?<qs>
 *
 * Zero dependencies. Node.js 20+.
 *
 * Environment:
 *   PORT          port to listen on (default 8787)
 *   HOST          interface to bind (default 0.0.0.0)
 *   ACCESS_TOKEN  if set, requests must send it in the `x-byeblock-token` header
 *   REGION        label shown by /health (defaults to FLY_REGION or "unknown")
 */
import http from 'node:http';
import { timingSafeEqual } from 'node:crypto';
import { pathToFileURL } from 'node:url';

export const VERSION = '2.0.1';
const UPSTREAM = 'https://api-v2.soundcloud.com';
const UPSTREAM_TIMEOUT_MS = 15000;
const USER_AGENT =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0 Safari/537.36';

const ALLOWED = [
  /^\/tracks$/,
  /^\/tracks\/\d+$/,
  /^\/media\/soundcloud:tracks:\d+\/[\w-]+\/(?:stream|preview)\/[\w-]+$/,
];

/** Only these query parameters are forwarded upstream. */
const ALLOWED_PARAMS = new Set(['ids', 'client_id', 'app_version', 'app_locale', 'track_authorization']);

export function isAllowedPath(pathname) {
  if (typeof pathname !== 'string' || pathname.includes('..') || pathname.includes('//')) return false;
  return ALLOWED.some((re) => re.test(pathname));
}

function tokenMatches(expected, given) {
  if (!expected) return true;
  if (typeof given !== 'string') return false;
  const a = Buffer.from(expected);
  const b = Buffer.from(given);
  return a.length === b.length && timingSafeEqual(a, b);
}

function send(res, status, body, headers = {}) {
  const payload = typeof body === 'string' ? body : JSON.stringify(body);
  res.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'cache-control': 'no-store',
    'access-control-allow-origin': '*',
    'access-control-allow-headers': 'x-byeblock-token',
    ...headers,
  });
  res.end(payload);
}

/** Request handler usable with node:http and with Vercel's Node.js functions. */
export function createHandler(options = {}) {
  const env = options.env || process.env;
  const fetchImpl = options.fetch || globalThis.fetch;
  const token = env.ACCESS_TOKEN || '';
  const region = env.REGION || env.FLY_REGION || (env.VERCEL_REGION ? `vercel-${env.VERCEL_REGION}` : 'unknown');
  const log = options.log || ((...args) => console.log(new Date().toISOString(), ...args));

  return async (req, res) => {
    const url = new URL(req.url, 'http://localhost');

    if (req.method === 'OPTIONS') return send(res, 204, '');
    if (req.method !== 'GET') return send(res, 405, { ok: false, error: 'method not allowed' });

    const authorized = tokenMatches(token, req.headers['x-byeblock-token']);

    // Public so platform health checks work; tells the client whether its token is accepted.
    if (url.pathname === '/health') {
      return send(res, 200, { ok: true, region, version: VERSION, authorized });
    }

    if (!authorized) {
      return send(res, 401, { ok: false, error: 'invalid or missing access token' });
    }

    if (!url.pathname.startsWith('/api-v2/')) {
      return send(res, 404, { ok: false, error: 'not found' });
    }

    const path = url.pathname.slice('/api-v2'.length);
    if (!isAllowedPath(path)) {
      return send(res, 403, { ok: false, error: 'path not allowed' });
    }

    const upstream = new URL(UPSTREAM + path);
    for (const [key, value] of url.searchParams) {
      if (ALLOWED_PARAMS.has(key)) upstream.searchParams.append(key, value);
    }

    try {
      const started = Date.now();
      const r = await fetchImpl(upstream, {
        headers: {
          accept: 'application/json',
          'user-agent': USER_AGENT,
          origin: 'https://soundcloud.com',
          referer: 'https://soundcloud.com/',
        },
        redirect: 'follow',
        signal: AbortSignal.timeout(UPSTREAM_TIMEOUT_MS),
      });
      const body = await r.text();
      log(`${r.status} ${path} ${Date.now() - started}ms`);
      return send(res, r.status, body, {
        'content-type': r.headers.get('content-type') || 'application/json; charset=utf-8',
      });
    } catch (err) {
      log(`502 ${path} ${err.message}`);
      return send(res, 502, { ok: false, error: 'upstream request failed' });
    }
  };
}

export function createServer(options = {}) {
  return http.createServer(createHandler(options));
}

const isMain = process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href;
if (isMain) {
  const port = Number(process.env.PORT) || 8787;
  const host = process.env.HOST || '0.0.0.0';
  const server = createServer();
  server.listen(port, host, () => {
    console.log(`ByeBlock proxy ${VERSION} listening on http://${host}:${port}`);
    if (!process.env.ACCESS_TOKEN) {
      console.warn('ACCESS_TOKEN is not set: anyone who knows this URL can use the proxy.');
    }
  });
  for (const signal of ['SIGINT', 'SIGTERM']) {
    process.on(signal, () => server.close(() => process.exit(0)));
  }
}
