/**
 * ByeBlock core: pure helpers shared by the page hook, the background worker
 * and the unit tests. No DOM or extension APIs in here.
 *
 * Loaded as a classic script in the browser (exposes `globalThis.__byeblockCore`)
 * and via `require()` in Node.
 */
(function (root, factory) {
  'use strict';
  const core = factory();
  if (typeof module === 'object' && module.exports) {
    module.exports = core;
  } else {
    root.__byeblockCore = core;
  }
})(typeof globalThis !== 'undefined' ? globalThis : this, function () {
  'use strict';

  const API_HOST = 'api-v2.soundcloud.com';

  /** Policies SoundCloud uses, ordered from worst to best for the listener. */
  const POLICY_RANK = { BLOCK: 0, SNIP: 1, MONETIZE: 2, ALLOW: 2 };

  /** Track fields copied from the proxied copy onto the local one. */
  const MERGED_FIELDS = [
    'policy',
    'monetization_model',
    'streamable',
    'media',
    'duration',
    'full_duration',
    'track_authorization',
    'station_urn',
    'station_permalink',
  ];

  /** Relay paths (relative to api-v2) that the proxy is allowed to forward. */
  const RELAY_PATTERNS = [
    /^\/tracks$/,
    /^\/tracks\/\d+$/,
    /^\/media\/soundcloud:tracks:\d+\/[\w-]+\/(?:stream|preview)\/[\w-]+$/,
  ];

  function toUrl(input) {
    try {
      return new URL(String(input), 'https://soundcloud.com/');
    } catch (_) {
      return null;
    }
  }

  function isApiUrl(input) {
    const url = toUrl(input);
    return !!url && url.hostname === API_HOST;
  }

  /** `https://api-v2.soundcloud.com/tracks?ids=1` -> `/tracks?ids=1` */
  function apiPath(input) {
    const url = toUrl(input);
    if (!url || url.hostname !== API_HOST) return null;
    return url.pathname + url.search;
  }

  function isAllowedRelayPath(path) {
    if (typeof path !== 'string' || path[0] !== '/') return false;
    const pathname = path.split('?')[0];
    if (pathname.includes('..') || pathname.includes('//')) return false;
    return RELAY_PATTERNS.some((re) => re.test(pathname));
  }

  /** Returns the track id of a stream-resolution URL, or null. */
  function mediaTrackId(input) {
    const url = toUrl(input);
    if (!url || url.hostname !== API_HOST) return null;
    const m = /^\/media\/soundcloud:tracks:(\d+)\//.exec(url.pathname);
    return m ? Number(m[1]) : null;
  }

  function policyRank(policy) {
    return Object.prototype.hasOwnProperty.call(POLICY_RANK, policy) ? POLICY_RANK[policy] : -1;
  }

  function isRestricted(track) {
    return (
      !!track &&
      typeof track === 'object' &&
      track.kind === 'track' &&
      typeof track.id === 'number' &&
      (track.policy === 'BLOCK' || track.policy === 'SNIP')
    );
  }

  /** True when the proxied copy is actually more playable than the local one. */
  function isBetter(local, proxied) {
    if (!proxied || proxied.id !== local.id) return false;
    return policyRank(proxied.policy) > policyRank(local.policy);
  }

  /**
   * Walks any api-v2 JSON payload and returns every restricted track object
   * (by reference, so callers can patch them in place).
   */
  function findRestrictedTracks(payload) {
    const found = [];
    const seen = new Set();
    const stack = [payload];
    while (stack.length) {
      const node = stack.pop();
      if (!node || typeof node !== 'object' || seen.has(node)) continue;
      seen.add(node);
      if (isRestricted(node)) found.push(node);
      const values = Array.isArray(node) ? node : Object.values(node);
      // Push in reverse so tracks come out in document order.
      for (let i = values.length - 1; i >= 0; i--) {
        if (values[i] && typeof values[i] === 'object') stack.push(values[i]);
      }
    }
    return found;
  }

  /** Copies the playable bits of the proxied track onto the local track. */
  function mergeProxiedTrack(local, proxied) {
    const originalPolicy = local.policy;
    for (const field of MERGED_FIELDS) {
      if (Object.prototype.hasOwnProperty.call(proxied, field)) {
        local[field] = proxied[field];
      }
    }
    local.byeblock = { originalPolicy, unblocked: true };
    return local;
  }

  function chunk(list, size) {
    const out = [];
    for (let i = 0; i < list.length; i += size) out.push(list.slice(i, i + size));
    return out;
  }

  /** Normalises a user-entered proxy URL: trims, requires http(s), drops trailing slash. */
  function normalizeProxyUrl(input) {
    const value = String(input || '').trim();
    if (!value) return '';
    let url;
    try {
      url = new URL(value);
    } catch (_) {
      return null;
    }
    if (url.protocol !== 'https:' && url.protocol !== 'http:') return null;
    if (url.search || url.hash) return null;
    return url.origin + url.pathname.replace(/\/+$/, '');
  }

  return {
    API_HOST,
    apiPath,
    chunk,
    findRestrictedTracks,
    isAllowedRelayPath,
    isApiUrl,
    isBetter,
    isRestricted,
    mediaTrackId,
    mergeProxiedTrack,
    normalizeProxyUrl,
    policyRank,
  };
});
