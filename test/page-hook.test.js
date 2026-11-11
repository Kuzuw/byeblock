'use strict';

/**
 * Runs src/core.js + src/page-hook.js inside a fake browser window (node:vm)
 * with a fake SoundCloud API and a fake extension bridge, and checks that
 * blocked tracks come out unblocked through both fetch() and XMLHttpRequest.
 */
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const SRC = path.join(__dirname, '..', 'src');
const API = 'https://api-v2.soundcloud.com';

// --- fake SoundCloud as seen from a blocked country, and from the proxy --------

const local = {
  1: { kind: 'track', id: 1, title: 'Blocked', policy: 'BLOCK', media: { transcodings: [] } },
  2: { kind: 'track', id: 2, title: 'Snipped', policy: 'SNIP', duration: 30000, media: { transcodings: [{ url: `${API}/media/soundcloud:tracks:2/aa/preview/hls`, snipped: true }] } },
  3: { kind: 'track', id: 3, title: 'Free', policy: 'ALLOW', media: { transcodings: [] } },
  4: { kind: 'track', id: 4, title: 'Blocked everywhere', policy: 'BLOCK', media: { transcodings: [] } },
};
const remote = {
  1: { kind: 'track', id: 1, title: 'Blocked', policy: 'ALLOW', track_authorization: 'r1', media: { transcodings: [{ url: `${API}/media/soundcloud:tracks:1/bb/stream/hls`, snipped: false }] } },
  2: { kind: 'track', id: 2, title: 'Snipped', policy: 'MONETIZE', duration: 200000, track_authorization: 'r2', media: { transcodings: [{ url: `${API}/media/soundcloud:tracks:2/cc/stream/hls`, snipped: false }] } },
  4: { kind: 'track', id: 4, title: 'Blocked everywhere', policy: 'BLOCK', media: { transcodings: [] } },
};

function localApi(url) {
  const u = new URL(url);
  if (u.pathname === '/stream') {
    return { status: 200, body: { collection: [{ type: 'track', track: local[1] }, { type: 'track', track: local[2] }, { type: 'track', track: local[3] }, { type: 'track', track: local[4] }] } };
  }
  if (u.pathname.startsWith('/media/')) return { status: 403, body: { error: 'geo' } };
  return { status: 404, body: {} };
}

function proxyApi(relayPath) {
  const u = new URL(API + relayPath);
  if (u.pathname === '/tracks') {
    const ids = u.searchParams.get('ids').split(',').map(Number);
    return { status: 200, body: ids.map((id) => remote[id]).filter(Boolean) };
  }
  const m = /^\/media\/soundcloud:tracks:(\d+)\//.exec(u.pathname);
  if (m) return { status: 200, body: { url: `https://cf-hls-media.sndcdn.com/playlist/${m[1]}.m3u8?signed` } };
  return { status: 404, body: {} };
}

// --- fake browser ------------------------------------------------------------

class FakeXHR extends EventTarget {
  constructor() {
    super();
    this.readyState = 0;
    this.status = 0;
    this.statusText = '';
    this.responseType = '';
    this._body = '';
    this._handlers = {};
  }
  get responseText() {
    if (this.responseType !== '' && this.responseType !== 'text') throw new Error('InvalidStateError');
    return this._body;
  }
  get response() {
    return this.responseType === 'json' ? JSON.parse(this._body) : this._body;
  }
  open(method, url) {
    this._url = url;
    this.readyState = 1;
  }
  send() {
    setTimeout(() => {
      const res = localApi(this._url);
      this.readyState = 4;
      this.status = res.status;
      this._body = JSON.stringify(res.body);
      const types = ['readystatechange', 'load', 'loadend'];
      if (!FakeXHR.gaps) {
        for (const type of types) this.dispatchEvent(new Event(type));
        return;
      }
      // Browsers run microtasks between natively dispatched events; emulate a gap.
      const next = () => {
        this.dispatchEvent(new Event(types.shift()));
        if (types.length) setTimeout(next, 0);
      };
      next();
    }, 1);
  }
}
// Browsers register `onX` handlers at assignment time; emulate that.
for (const type of ['readystatechange', 'load', 'error', 'loadend']) {
  Object.defineProperty(FakeXHR.prototype, 'on' + type, {
    set(fn) {
      if (!this._handlers[type]) this.addEventListener(type, (e) => this._handlers[type] && this._handlers[type].call(this, e));
      this._handlers[type] = fn;
    },
    get() {
      return this._handlers[type] || null;
    },
  });
}

function makeWindow({ proxyConfigured = true } = {}) {
  const target = new EventTarget();
  const relays = [];
  const win = {
    location: { origin: 'https://soundcloud.com', href: 'https://soundcloud.com/discover' },
    addEventListener: target.addEventListener.bind(target),
    removeEventListener: target.removeEventListener.bind(target),
    console: process.env.BB_DEBUG ? console : { log() {}, info() {}, warn() {}, error: console.error },
    fetch: async (input) => {
      const res = localApi(typeof input === 'string' ? input : input.url);
      return new Response(JSON.stringify(res.body), { status: res.status, headers: { 'content-type': 'application/json', 'content-length': '1' } });
    },
    XMLHttpRequest: FakeXHR,
    URL, URLSearchParams, Headers, Response, Event, EventTarget, DOMException, setTimeout, clearTimeout,
    ProgressEvent: class ProgressEvent extends Event {},
  };
  win.window = win;
  let globalRef = win; // replaced by the vm's global proxy below
  win.postMessage = (data) => {
    setTimeout(() => {
      const event = new Event('message');
      Object.defineProperty(event, 'data', { value: data });
      Object.defineProperty(event, 'source', { value: globalRef });
      target.dispatchEvent(event);
    }, 0);
  };
  // fake bridge.js + background worker
  target.addEventListener('message', (e) => {
    const msg = e.data;
    if (msg.source !== 'byeblock-page') return;
    if (msg.type === 'ready') {
      win.postMessage({ source: 'byeblock-bridge', type: 'config', config: { enabled: true, proxyConfigured } });
    } else if (msg.type === 'relay') {
      relays.push(msg.path);
      const res = proxyApi(msg.path);
      win.postMessage({ source: 'byeblock-bridge', type: 'relay-result', id: msg.id, status: res.status, body: JSON.stringify(res.body) });
    }
  });

  const context = vm.createContext(win);
  // Inside the vm, `window` is the context's global proxy, not `win` itself.
  globalRef = vm.runInContext('globalThis', context);
  for (const file of ['core.js', 'page-hook.js']) {
    vm.runInContext(fs.readFileSync(path.join(SRC, file), 'utf8'), context, { filename: file });
  }
  return { win, relays };
}

function request(win, url, opts = {}) {
  return new Promise((resolve) => {
    const req = new win.XMLHttpRequest();
    const seen = [];
    req.open('GET', url);
    req.responseType = opts.responseType || '';
    req.addEventListener('readystatechange', () => seen.push('rs' + req.readyState));
    const done = () => {
      seen.push('load');
      const body = req.responseType === 'json' ? req.response : JSON.parse(req.responseText);
      setTimeout(() => resolve({ status: req.status, body, seen }), 5);
    };
    if (opts.useOnload) req.onload = done;
    else req.addEventListener('load', done);
    req.addEventListener('loadend', () => seen.push('loadend'));
    req.send();
  });
}

// --- tests ---------------------------------------------------------------------

const byId = (collection) => Object.fromEntries(collection.map((item) => [item.track.id, item.track]));

test('fetch: blocked and snipped tracks are replaced with the proxied versions', async () => {
  const { win, relays } = makeWindow();
  const res = await win.fetch(`${API}/stream?client_id=CID&limit=10`);
  assert.equal(res.status, 200);
  assert.equal(res.headers.get('content-length'), null);
  const tracks = byId((await res.json()).collection);

  assert.equal(tracks[1].policy, 'ALLOW');
  assert.equal(tracks[1].track_authorization, 'r1');
  assert.deepEqual(tracks[1].byeblock, { originalPolicy: 'BLOCK', unblocked: true });
  assert.equal(tracks[2].policy, 'MONETIZE');
  assert.equal(tracks[2].duration, 200000);
  assert.equal(tracks[3].policy, 'ALLOW');
  assert.equal(tracks[3].byeblock, undefined);
  assert.equal(tracks[4].policy, 'BLOCK', 'track blocked in the proxy region too stays blocked');

  assert.deepEqual(relays, ['/tracks?ids=1%2C2%2C4&client_id=CID']);
});

test('fetch: stream resolution for unblocked tracks goes through the proxy', async () => {
  const { win, relays } = makeWindow();
  await win.fetch(`${API}/stream?client_id=CID`);
  const res = await win.fetch(`${API}/media/soundcloud:tracks:1/bb/stream/hls?client_id=CID&track_authorization=r1`);
  assert.equal(res.status, 200);
  assert.match((await res.json()).url, /cf-hls-media\.sndcdn\.com\/playlist\/1\.m3u8/);
  assert.equal(relays[1], '/media/soundcloud:tracks:1/bb/stream/hls?client_id=CID&track_authorization=r1');

  // Untouched for tracks we did not unblock.
  const other = await win.fetch(`${API}/media/soundcloud:tracks:4/xx/stream/hls?client_id=CID`);
  assert.equal(other.status, 403);
});

test('fetch: lookups are cached, including misses', async () => {
  const { win, relays } = makeWindow();
  await win.fetch(`${API}/stream?client_id=CID`);
  await win.fetch(`${API}/stream?client_id=CID`);
  assert.equal(relays.length, 1);
});

test('xhr (text): response is patched and events arrive in order', async () => {
  const { win } = makeWindow();
  const res = await request(win, `${API}/stream?client_id=CID`);
  assert.equal(res.status, 200);
  const tracks = byId(res.body.collection);
  assert.equal(tracks[1].policy, 'ALLOW');
  assert.equal(tracks[2].policy, 'MONETIZE');
  assert.deepEqual(res.seen, ['rs4', 'load', 'loadend']);
});

test('xhr (json + onload): response is patched', async () => {
  const { win } = makeWindow();
  const res = await request(win, `${API}/stream?client_id=CID`, { responseType: 'json', useOnload: true });
  assert.equal(byId(res.body.collection)[1].policy, 'ALLOW');
});

test('xhr: stream resolution 403 is replaced by the proxied answer', async () => {
  const { win } = makeWindow();
  await request(win, `${API}/stream?client_id=CID`);
  const res = await request(win, `${API}/media/soundcloud:tracks:2/cc/stream/hls?client_id=CID`);
  assert.equal(res.status, 200);
  assert.match(res.body.url, /playlist\/2\.m3u8/);
});

test('xhr: untouched when nothing is restricted', async () => {
  const { win, relays } = makeWindow();
  const res = await request(win, `${API}/media/soundcloud:tracks:3/zz/stream/hls`);
  assert.equal(res.status, 403);
  assert.deepEqual(res.seen, ['rs4', 'load', 'loadend']);
  assert.equal(relays.length, 0);
});

test('does nothing without a proxy server configured', async () => {
  const { win, relays } = makeWindow({ proxyConfigured: false });
  const res = await win.fetch(`${API}/stream?client_id=CID`);
  assert.equal(byId((await res.json()).collection)[1].policy, 'BLOCK');
  assert.equal(relays.length, 0);
});

test('xhr: no duplicate events when patching finishes before native load fires', async () => {
  FakeXHR.gaps = true;
  try {
    const { win, relays } = makeWindow();
    await request(win, `${API}/stream?client_id=CID`); // warms the cache
    const res = await request(win, `${API}/stream?client_id=CID`); // patched without waiting on the proxy
    assert.equal(relays.length, 1);
    assert.equal(byId(res.body.collection)[1].policy, 'ALLOW');
    assert.deepEqual(res.seen, ['rs4', 'load', 'loadend']);

    const plain = await request(win, `${API}/media/soundcloud:tracks:3/zz/stream/hls`);
    assert.deepEqual(plain.seen, ['rs4', 'load', 'loadend']);
  } finally {
    FakeXHR.gaps = false;
  }
});

test('xhr: reusing an instance resets overridden fields', async () => {
  const { win } = makeWindow();
  await request(win, `${API}/stream?client_id=CID`);
  const req = new win.XMLHttpRequest();
  await new Promise((resolve) => {
    req.open('GET', `${API}/media/soundcloud:tracks:1/bb/stream/hls?client_id=CID`);
    req.onloadend = resolve;
    req.send();
  });
  assert.equal(req.status, 200);
  await new Promise((resolve) => {
    req.open('GET', `${API}/media/soundcloud:tracks:3/zz/stream/hls`);
    req.onloadend = resolve;
    req.send();
  });
  assert.equal(req.status, 403);
});
