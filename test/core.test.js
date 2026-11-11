'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const core = require('../src/core.js');

const track = (id, policy, extra = {}) => ({ kind: 'track', id, policy, ...extra });

test('isApiUrl only matches api-v2.soundcloud.com', () => {
  assert.equal(core.isApiUrl('https://api-v2.soundcloud.com/tracks?ids=1'), true);
  assert.equal(core.isApiUrl('https://api.soundcloud.com/tracks'), false);
  assert.equal(core.isApiUrl('https://api-v2.soundcloud.com.evil.example/tracks'), false);
  assert.equal(core.isApiUrl('/relative'), false);
  assert.equal(core.isApiUrl('::not a url::'), false);
});

test('apiPath strips the origin', () => {
  assert.equal(core.apiPath('https://api-v2.soundcloud.com/tracks?ids=1,2&client_id=x'), '/tracks?ids=1,2&client_id=x');
  assert.equal(core.apiPath('https://example.com/tracks'), null);
});

test('mediaTrackId extracts the id of stream resolution URLs', () => {
  const url = 'https://api-v2.soundcloud.com/media/soundcloud:tracks:12345/0a1b-2c3d/stream/hls?client_id=x';
  assert.equal(core.mediaTrackId(url), 12345);
  assert.equal(core.mediaTrackId('https://api-v2.soundcloud.com/tracks/12345'), null);
});

test('isAllowedRelayPath only allows track and stream lookups', () => {
  assert.equal(core.isAllowedRelayPath('/tracks?ids=1,2'), true);
  assert.equal(core.isAllowedRelayPath('/tracks/42'), true);
  assert.equal(core.isAllowedRelayPath('/media/soundcloud:tracks:42/abc-123/stream/hls?x=1'), true);
  assert.equal(core.isAllowedRelayPath('/media/soundcloud:tracks:42/abc-123/preview/progressive'), true);
  assert.equal(core.isAllowedRelayPath('/me'), false);
  assert.equal(core.isAllowedRelayPath('/users/1/tracks'), false);
  assert.equal(core.isAllowedRelayPath('/tracks/../me'), false);
  assert.equal(core.isAllowedRelayPath('tracks'), false);
  assert.equal(core.isAllowedRelayPath('//evil.example/tracks'), false);
  assert.equal(core.isAllowedRelayPath(undefined), false);
});

test('findRestrictedTracks walks nested payloads', () => {
  const payload = {
    collection: [
      { type: 'track', track: track(1, 'BLOCK') },
      { type: 'track-repost', track: track(2, 'ALLOW') },
      { playlist: { kind: 'playlist', tracks: [track(3, 'SNIP'), { id: 4, kind: 'track' }, track(5, 'MONETIZE')] } },
    ],
    next_href: null,
  };
  const ids = core.findRestrictedTracks(payload).map((t) => t.id).sort();
  assert.deepEqual(ids, [1, 3]);
});

test('findRestrictedTracks survives cycles and primitives', () => {
  const a = { kind: 'track', id: 9, policy: 'BLOCK' };
  a.self = a;
  assert.equal(core.findRestrictedTracks(a).length, 1);
  assert.deepEqual(core.findRestrictedTracks(null), []);
  assert.deepEqual(core.findRestrictedTracks('x'), []);
});

test('isBetter compares policies of the same track', () => {
  assert.equal(core.isBetter(track(1, 'BLOCK'), track(1, 'ALLOW')), true);
  assert.equal(core.isBetter(track(1, 'SNIP'), track(1, 'MONETIZE')), true);
  assert.equal(core.isBetter(track(1, 'BLOCK'), track(1, 'SNIP')), true);
  assert.equal(core.isBetter(track(1, 'SNIP'), track(1, 'SNIP')), false);
  assert.equal(core.isBetter(track(1, 'BLOCK'), track(2, 'ALLOW')), false);
  assert.equal(core.isBetter(track(1, 'BLOCK'), null), false);
});

test('mergeProxiedTrack copies stream data and keeps metadata', () => {
  const local = track(1, 'SNIP', {
    title: 'Local title',
    duration: 30000,
    full_duration: 200000,
    media: { transcodings: [{ snipped: true }] },
    track_authorization: 'local',
  });
  const proxied = track(1, 'ALLOW', {
    title: 'Proxied title',
    duration: 200000,
    full_duration: 200000,
    media: { transcodings: [{ snipped: false }] },
    track_authorization: 'remote',
    monetization_model: 'NOT_APPLICABLE',
  });
  core.mergeProxiedTrack(local, proxied);
  assert.equal(local.policy, 'ALLOW');
  assert.equal(local.title, 'Local title');
  assert.equal(local.duration, 200000);
  assert.equal(local.track_authorization, 'remote');
  assert.equal(local.media.transcodings[0].snipped, false);
  assert.deepEqual(local.byeblock, { originalPolicy: 'SNIP', unblocked: true });
});

test('normalizeProxyUrl', () => {
  assert.equal(core.normalizeProxyUrl(' https://proxy.example.com/ '), 'https://proxy.example.com');
  assert.equal(core.normalizeProxyUrl('https://proxy.example.com/base//'), 'https://proxy.example.com/base');
  assert.equal(core.normalizeProxyUrl('http://localhost:8787'), 'http://localhost:8787');
  assert.equal(core.normalizeProxyUrl(''), '');
  assert.equal(core.normalizeProxyUrl('ftp://x'), null);
  assert.equal(core.normalizeProxyUrl('https://x/?a=1'), null);
  assert.equal(core.normalizeProxyUrl('nope'), null);
});

test('chunk', () => {
  assert.deepEqual(core.chunk([1, 2, 3, 4, 5], 2), [[1, 2], [3, 4], [5]]);
  assert.deepEqual(core.chunk([], 3), []);
});
