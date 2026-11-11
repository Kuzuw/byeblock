'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

async function start(env, upstream) {
  const { createServer } = await import('../server/server.mjs');
  const calls = [];
  const server = createServer({
    env,
    log: () => {},
    fetch: async (url, init) => {
      calls.push({ url: String(url), init });
      return upstream(url);
    },
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const base = `http://127.0.0.1:${server.address().port}`;
  return { base, calls, close: () => new Promise((r) => server.close(r)) };
}

const json = (status, body) => new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });

test('health reports region and auth state', async () => {
  const s = await start({ REGION: 'iad', ACCESS_TOKEN: 'secret' }, () => json(200, {}));
  try {
    let res = await fetch(s.base + '/health');
    assert.equal(res.status, 200);
    assert.deepEqual(await res.json(), { ok: true, region: 'iad', version: '2.0.1', authorized: false });
    res = await fetch(s.base + '/health', { headers: { 'x-byeblock-token': 'secret' } });
    assert.equal((await res.json()).authorized, true);
  } finally {
    await s.close();
  }
});

test('forwards allowed paths with filtered query parameters', async () => {
  const s = await start({}, () => json(200, [{ kind: 'track', id: 1, policy: 'ALLOW' }]));
  try {
    const res = await fetch(s.base + '/api-v2/tracks?ids=1,2&client_id=abc&evil=1');
    assert.equal(res.status, 200);
    assert.deepEqual(await res.json(), [{ kind: 'track', id: 1, policy: 'ALLOW' }]);
    assert.equal(s.calls.length, 1);
    assert.equal(s.calls[0].url, 'https://api-v2.soundcloud.com/tracks?ids=1%2C2&client_id=abc');
    assert.equal(s.calls[0].init.headers.origin, 'https://soundcloud.com');
  } finally {
    await s.close();
  }
});

test('forwards stream resolution and passes upstream status through', async () => {
  const s = await start({}, () => json(404, { error: 'nope' }));
  try {
    const res = await fetch(s.base + '/api-v2/media/soundcloud:tracks:42/ab-12/stream/hls?client_id=x&track_authorization=t');
    assert.equal(res.status, 404);
    assert.match(s.calls[0].url, /\/media\/soundcloud:tracks:42\/ab-12\/stream\/hls\?client_id=x&track_authorization=t$/);
  } finally {
    await s.close();
  }
});

test('rejects anything outside the allow-list', async () => {
  const s = await start({}, () => json(200, {}));
  try {
    for (const path of ['/api-v2/me', '/api-v2/users/1', '/api-v2/tracks/1/comments', '/api-v2/tracks/%2e%2e/me']) {
      const res = await fetch(s.base + path);
      assert.equal(res.status, 403, path);
    }
    assert.equal((await fetch(s.base + '/whatever')).status, 404);
    assert.equal((await fetch(s.base + '/api-v2/tracks', { method: 'POST' })).status, 405);
    assert.equal(s.calls.length, 0);
  } finally {
    await s.close();
  }
});

test('requires the access token when configured', async () => {
  const s = await start({ ACCESS_TOKEN: 'secret' }, () => json(200, []));
  try {
    assert.equal((await fetch(s.base + '/api-v2/tracks?ids=1')).status, 401);
    assert.equal((await fetch(s.base + '/api-v2/tracks?ids=1', { headers: { 'x-byeblock-token': 'wrong!' } })).status, 401);
    const ok = await fetch(s.base + '/api-v2/tracks?ids=1', { headers: { 'x-byeblock-token': 'secret' } });
    assert.equal(ok.status, 200);
  } finally {
    await s.close();
  }
});

test('returns 502 when SoundCloud is unreachable', async () => {
  const s = await start({}, () => {
    throw new Error('boom');
  });
  try {
    assert.equal((await fetch(s.base + '/api-v2/tracks?ids=1')).status, 502);
  } finally {
    await s.close();
  }
});

test('Vercel entry point (api/index.js) serves the same routes', async () => {
  const http = require('node:http');
  const handler = require('../api/index.js');
  const prev = process.env.VERCEL_REGION;
  process.env.VERCEL_REGION = 'iad1';
  const server = http.createServer(handler);
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  try {
    const base = `http://127.0.0.1:${server.address().port}`;
    const health = await (await fetch(base + '/health')).json();
    assert.equal(health.ok, true);
    assert.equal(health.region, 'vercel-iad1');
    assert.equal((await fetch(base + '/api-v2/me')).status, 403);
  } finally {
    await new Promise((r) => server.close(r));
    if (prev === undefined) delete process.env.VERCEL_REGION;
    else process.env.VERCEL_REGION = prev;
  }
});
