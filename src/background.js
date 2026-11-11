/**
 * ByeBlock background worker. Performs the actual requests to your proxy
 * server, so they are not subject to soundcloud.com's CSP or CORS.
 */
'use strict';

if (typeof importScripts === 'function' && !globalThis.__byeblockCore) {
  importScripts('core.js');
}

const core = globalThis.__byeblockCore;
const ext = globalThis.browser || globalThis.chrome;
const DEFAULTS = { enabled: true, proxyUrl: '', token: '' };
const TIMEOUT_MS = 15000;

async function settings() {
  return ext.storage.sync.get(DEFAULTS);
}

async function proxyFetch(proxyUrl, token, path) {
  const headers = { accept: 'application/json' };
  if (token) headers['x-byeblock-token'] = token;
  const res = await fetch(proxyUrl + path, {
    headers,
    credentials: 'omit',
    cache: 'no-store',
    signal: AbortSignal.timeout(TIMEOUT_MS),
  });
  return { status: res.status, body: await res.text() };
}

async function relay(path) {
  if (!core.isAllowedRelayPath(path)) return { error: 'path not allowed: ' + path };
  const { enabled, proxyUrl, token } = await settings();
  if (!enabled) return { error: 'ByeBlock is disabled' };
  if (!proxyUrl) return { error: 'no proxy server configured' };
  return proxyFetch(proxyUrl, token, '/api-v2' + path);
}

async function testProxy(proxyUrl, token) {
  const url = core.normalizeProxyUrl(proxyUrl);
  if (!url) return { ok: false, error: 'Invalid URL' };
  const res = await proxyFetch(url, token, '/health');
  let info = {};
  try {
    info = JSON.parse(res.body);
  } catch (_) {
    /* not JSON */
  }
  if (res.status !== 200 || !info.ok) {
    return { ok: false, error: info.error || `Server answered HTTP ${res.status}` };
  }
  if (info.authorized === false) {
    return { ok: false, error: 'server rejected the access token' };
  }
  return { ok: true, region: info.region || null, version: info.version || null };
}

function setBadge(tabId, count) {
  if (tabId === undefined || tabId < 0) return;
  const action = ext.action || ext.browserAction;
  action.setBadgeBackgroundColor({ tabId, color: '#ff5500' });
  action.setBadgeText({ tabId, text: count > 0 ? String(count) : '' });
}

ext.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  // Only accept messages from our own extension pages and content scripts.
  if (sender.id !== ext.runtime.id) return false;

  let work;
  if (msg && msg.type === 'relay') work = relay(msg.path);
  else if (msg && msg.type === 'test') work = testProxy(msg.proxyUrl, msg.token);
  else if (msg && msg.type === 'stats') {
    setBadge(sender.tab && sender.tab.id, msg.unblocked);
    return false;
  } else return false;

  work.then(sendResponse, (err) => sendResponse({ error: String(err && err.message ? err.message : err) }));
  return true; // keep the channel open for the async response
});
