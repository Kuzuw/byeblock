/**
 * ByeBlock bridge. Runs in the extension's isolated world on soundcloud.com
 * and connects the page hook (page-hook.js) with the background worker.
 */
(function () {
  'use strict';

  const ext = globalThis.browser || globalThis.chrome;
  const PAGE = 'byeblock-page';
  const BRIDGE = 'byeblock-bridge';
  const DEFAULTS = { enabled: true, proxyUrl: '', token: '' };

  function post(message) {
    window.postMessage(Object.assign({ source: BRIDGE }, message), window.location.origin);
  }

  async function sendConfig() {
    const stored = await ext.storage.sync.get(DEFAULTS);
    post({
      type: 'config',
      config: { enabled: stored.enabled !== false, proxyConfigured: !!stored.proxyUrl },
    });
  }

  window.addEventListener('message', async (event) => {
    if (event.source !== window) return;
    const msg = event.data;
    if (!msg || msg.source !== PAGE) return;

    if (msg.type === 'ready') {
      sendConfig();
    } else if (msg.type === 'relay') {
      try {
        const res = await ext.runtime.sendMessage({ type: 'relay', path: msg.path });
        if (!res || res.error) throw new Error((res && res.error) || 'no response from background');
        post({ type: 'relay-result', id: msg.id, status: res.status, body: res.body });
      } catch (err) {
        post({ type: 'relay-result', id: msg.id, error: String(err && err.message ? err.message : err) });
      }
    } else if (msg.type === 'stats') {
      ext.runtime.sendMessage({ type: 'stats', unblocked: Number(msg.unblocked) || 0 }).catch(() => {});
    }
  });

  ext.storage.onChanged.addListener((changes, area) => {
    if (area === 'sync') sendConfig();
  });

  sendConfig();
})();
