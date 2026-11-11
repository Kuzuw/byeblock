/**
 * ByeBlock page hook. Runs in SoundCloud's own JavaScript world (MAIN) at
 * document_start, before any of SoundCloud's scripts.
 *
 * It wraps `fetch` and `XMLHttpRequest` so that api-v2 responses can be
 * patched before the web app sees them:
 *
 *  1. When a response contains tracks with policy BLOCK or SNIP, the same
 *     tracks are fetched again through your proxy server (in another region).
 *     If they are playable there, their stream data is merged in.
 *  2. When the player later resolves a stream URL for one of those tracks,
 *     the resolution request is answered through the proxy as well.
 *
 * The audio itself is still downloaded straight from SoundCloud's CDN.
 * Proxy requests are made by the extension's background worker; this script
 * talks to it through the isolated-world bridge (bridge.js) via postMessage.
 */
(function () {
  'use strict';

  const core = globalThis.__byeblockCore;
  if (!core || window.__byeblockInstalled) return;
  window.__byeblockInstalled = true;
  try {
    delete globalThis.__byeblockCore;
  } catch (_) {
    /* non-configurable in some engines; harmless */
  }

  const PAGE = 'byeblock-page';
  const BRIDGE = 'byeblock-bridge';
  const TAG = '[ByeBlock]';
  const BATCH_SIZE = 50;
  const MISS_TTL_MS = 10 * 60 * 1000;
  const CONFIG_WAIT_MS = 3000;

  /** id -> proxied track that is more playable than the local copy */
  const unblocked = new Map();
  /** id -> timestamp of a proxy lookup that did not help */
  const misses = new Map();
  /** id -> pending lookup promise, so parallel responses share one request */
  const pending = new Map();

  let config = null;
  let resolveConfig;
  const configReady = new Promise((resolve) => {
    resolveConfig = resolve;
  });

  // ---------------------------------------------------------------------------
  // Bridge to the extension
  // ---------------------------------------------------------------------------

  let nextId = 1;
  const inflight = new Map();

  window.addEventListener('message', (event) => {
    if (event.source !== window) return;
    const msg = event.data;
    if (!msg || msg.source !== BRIDGE) return;

    if (msg.type === 'config') {
      config = msg.config;
      resolveConfig();
    } else if (msg.type === 'relay-result') {
      const entry = inflight.get(msg.id);
      if (!entry) return;
      inflight.delete(msg.id);
      if (msg.error) entry.reject(new Error(msg.error));
      else entry.resolve({ status: msg.status, body: msg.body });
    }
  });

  function post(message) {
    window.postMessage(Object.assign({ source: PAGE }, message), window.location.origin);
  }

  post({ type: 'ready' });

  function relay(path) {
    return new Promise((resolve, reject) => {
      const id = nextId++;
      const timer = setTimeout(() => {
        if (inflight.delete(id)) reject(new Error('relay timed out'));
      }, 20000);
      const done = (fn) => (value) => {
        clearTimeout(timer);
        fn(value);
      };
      inflight.set(id, { resolve: done(resolve), reject: done(reject) });
      post({ type: 'relay', id, path });
    });
  }

  async function active() {
    if (!config) {
      let timer;
      await Promise.race([configReady, new Promise((r) => (timer = setTimeout(r, CONFIG_WAIT_MS)))]);
      clearTimeout(timer);
    }
    return !!(config && config.enabled && config.proxyConfigured);
  }

  function reportStats() {
    post({ type: 'stats', unblocked: unblocked.size });
  }

  // ---------------------------------------------------------------------------
  // Response transformation
  // ---------------------------------------------------------------------------

  async function lookup(ids, clientId) {
    const todo = [];
    const waits = [];
    const now = Date.now();
    for (const id of ids) {
      if (unblocked.has(id)) continue;
      const missedAt = misses.get(id);
      if (missedAt && now - missedAt < MISS_TTL_MS) continue;
      if (pending.has(id)) waits.push(pending.get(id));
      else todo.push(id);
    }

    for (const batch of core.chunk(todo, BATCH_SIZE)) {
      const query = new URLSearchParams({ ids: batch.join(',') });
      if (clientId) query.set('client_id', clientId);
      const request = relay('/tracks?' + query.toString())
        .then((res) => {
          const list = res.status === 200 ? JSON.parse(res.body) : [];
          const byId = new Map((Array.isArray(list) ? list : []).map((t) => [t.id, t]));
          for (const id of batch) {
            const proxied = byId.get(id);
            // Only keep copies that are fully playable over there.
            if (proxied && core.isBetter({ id, policy: 'SNIP' }, proxied)) unblocked.set(id, proxied);
            else misses.set(id, Date.now());
          }
        })
        .catch((err) => {
          console.warn(TAG, 'proxy lookup failed:', err.message);
          for (const id of batch) misses.set(id, Date.now());
        })
        .finally(() => {
          for (const id of batch) pending.delete(id);
        });
      for (const id of batch) pending.set(id, request);
      waits.push(request);
    }

    await Promise.all(waits);
  }

  /**
   * Returns `{ status, body }` to replace the response with, or null to leave
   * it untouched.
   */
  async function transform(url, status, bodyText) {
    if (!(await active())) return null;

    const mediaId = core.mediaTrackId(url);
    if (mediaId !== null) {
      if (!unblocked.has(mediaId)) return null;
      const res = await relay(core.apiPath(url));
      if (res.status !== 200) {
        console.warn(TAG, 'proxy could not resolve stream for track', mediaId, res.status);
        return null;
      }
      return res;
    }

    if (status !== 200 || !bodyText) return null;
    let json;
    try {
      json = JSON.parse(bodyText);
    } catch (_) {
      return null;
    }

    const restricted = core.findRestrictedTracks(json);
    if (!restricted.length) return null;

    const clientId = new URL(url).searchParams.get('client_id');
    await lookup([...new Set(restricted.map((t) => t.id))], clientId);

    let changed = 0;
    for (const track of restricted) {
      const proxied = unblocked.get(track.id);
      if (proxied && core.isBetter(track, proxied)) {
        core.mergeProxiedTrack(track, proxied);
        changed++;
      }
    }
    if (!changed) return null;

    console.info(TAG, `unblocked ${changed} track(s) in`, core.apiPath(url).split('?')[0]);
    reportStats();
    return { status: 200, body: JSON.stringify(json) };
  }

  // ---------------------------------------------------------------------------
  // fetch()
  // ---------------------------------------------------------------------------

  const nativeFetch = window.fetch;

  function requestUrl(input) {
    if (typeof input === 'string') return input;
    if (input instanceof URL) return input.href;
    return input && input.url;
  }

  function requestMethod(input, init) {
    return ((init && init.method) || (input && input.method) || 'GET').toUpperCase();
  }

  function rebuild(original, out) {
    const headers = new Headers(original ? original.headers : { 'content-type': 'application/json' });
    headers.delete('content-length');
    headers.delete('content-encoding');
    return new Response(out.body, { status: out.status, statusText: out.status === 200 ? 'OK' : '', headers });
  }

  window.fetch = async function (input, init) {
    const url = requestUrl(input);
    if (!core.isApiUrl(url) || requestMethod(input, init) !== 'GET') {
      return nativeFetch.apply(this, arguments);
    }

    let response;
    try {
      response = await nativeFetch.apply(this, arguments);
    } catch (err) {
      // Geo-blocked stream resolution may fail outright; try the proxy.
      try {
        const out = await transform(url, 0, '');
        if (out) return rebuild(null, out);
      } catch (_) {
        /* fall through */
      }
      throw err;
    }

    try {
      const text = await response.clone().text();
      const out = await transform(url, response.status, text);
      if (out) return rebuild(response, out);
    } catch (err) {
      console.warn(TAG, 'fetch hook error:', err);
    }
    return response;
  };

  // ---------------------------------------------------------------------------
  // XMLHttpRequest
  // ---------------------------------------------------------------------------

  const NativeXHR = window.XMLHttpRequest;
  const HELD = ['readystatechange', 'load', 'error', 'loadend'];

  const OVERRIDDEN = ['status', 'statusText', 'responseText', 'response'];
  const SYNTHETIC = Symbol('byeblock');

  /*
   * Per request state machine:
   *   idle        -> nothing seen yet
   *   holding     -> readyState 4 reached; native events are withheld while we patch
   *   passthrough -> leave this request alone (or replay what was withheld, unchanged)
   *   done        -> patched events were delivered; late native duplicates are dropped
   */
  class ByeBlockXHR extends NativeXHR {
    constructor() {
      super();
      const xhr = this;
      let state = 'idle';
      let held = [];

      const hold = (event) => {
        if (event[SYNTHETIC] || !xhr.__bbUrl || xhr.readyState !== 4) return;
        if (state === 'passthrough') return;
        if (state === 'idle') {
          const type = xhr.responseType;
          const readable = type === '' || type === 'text' || type === 'json';
          const isMedia = core.mediaTrackId(xhr.__bbUrl) !== null;
          if (!readable || (xhr.status === 0 && !isMedia)) {
            state = 'passthrough';
            return;
          }
          state = 'holding';
          held = [];
          Promise.resolve().then(process);
        }
        // holding or done: keep the page from seeing the native event
        event.stopImmediatePropagation();
        if (state === 'holding') held.push(event.type);
      };

      const dispatch = (types) => {
        for (const type of types) {
          const event =
            type === 'readystatechange' ? new Event(type) : new ProgressEvent(type, { lengthComputable: false });
          event[SYNTHETIC] = true;
          xhr.dispatchEvent(event);
        }
      };

      const process = async () => {
        let out = null;
        try {
          let text = '';
          if (xhr.status !== 0) {
            text = xhr.responseType === 'json' ? JSON.stringify(xhr.response) : xhr.responseText;
          }
          out = await transform(xhr.__bbUrl, xhr.status, text);
        } catch (err) {
          console.warn(TAG, 'xhr hook error:', err);
        }

        if (!out) {
          // Unchanged: replay what we withheld; anything still to come passes through.
          state = 'passthrough';
          dispatch(held);
          return;
        }

        const asJson = xhr.responseType === 'json';
        define(xhr, 'status', out.status);
        define(xhr, 'statusText', out.status === 200 ? 'OK' : '');
        define(xhr, 'responseText', asJson ? undefined : out.body, asJson);
        define(xhr, 'response', asJson ? safeParse(out.body) : out.body);
        state = 'done';
        dispatch(['readystatechange', 'load', 'loadend']);
      };

      xhr.__bbReset = () => {
        state = 'idle';
        held = [];
        for (const key of OVERRIDDEN) delete xhr[key];
      };

      for (const type of HELD) xhr.addEventListener(type, hold, true);
    }

    open(method, url) {
      let absolute = null;
      try {
        absolute = new URL(url, window.location.href).href;
      } catch (_) {
        /* ignore */
      }
      const async = arguments.length < 3 || arguments[2] !== false;
      this.__bbReset();
      this.__bbUrl =
        async && String(method).toUpperCase() === 'GET' && absolute && core.isApiUrl(absolute) ? absolute : null;
      return super.open.apply(this, arguments);
    }
  }

  function safeParse(text) {
    try {
      return JSON.parse(text);
    } catch (_) {
      return null;
    }
  }

  function define(target, key, value, throws) {
    Object.defineProperty(target, key, {
      configurable: true,
      get() {
        if (throws) throw new DOMException('responseText is not available for this responseType', 'InvalidStateError');
        return value;
      },
    });
  }

  window.XMLHttpRequest = ByeBlockXHR;
})();
