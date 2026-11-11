'use strict';

(function () {
  const ext = globalThis.browser || globalThis.chrome;
  const core = globalThis.__byeblockCore;
  const DEFAULTS = { enabled: true, proxyUrl: '', token: '' };

  const $ = (id) => document.getElementById(id);
  const form = $('form');
  const enabled = $('enabled');
  const proxyUrl = $('proxyUrl');
  const token = $('token');
  const status = $('status');
  const testBtn = $('test');
  const saveBtn = $('save');

  function show(text, kind) {
    status.textContent = text;
    status.className = kind || '';
  }

  function originPattern(url) {
    return new URL(url).origin + '/*';
  }

  // Must be called before any `await` in a click handler: browsers only allow
  // permission prompts during a user gesture. Resolves true if already granted.
  function ensurePermission(url) {
    return ext.permissions.request({ origins: [originPattern(url)] });
  }

  async function load() {
    const stored = await ext.storage.sync.get(DEFAULTS);
    enabled.checked = stored.enabled !== false;
    proxyUrl.value = stored.proxyUrl;
    token.value = stored.token;
    if (!stored.proxyUrl) show('Set a proxy server to start unblocking tracks.');
  }

  function readUrl() {
    const url = core.normalizeProxyUrl(proxyUrl.value);
    if (url === null) {
      show('Enter a valid http(s) URL without query string.', 'err');
      proxyUrl.focus();
    }
    return url;
  }

  async function test() {
    const url = readUrl();
    if (!url) {
      if (url === '') show('Enter a proxy server URL first.', 'err');
      return;
    }
    testBtn.disabled = true;
    show('Testing…');
    try {
      if (!(await ensurePermission(url))) {
        show('Permission to contact the server was denied.', 'err');
        return;
      }
      const res = await ext.runtime.sendMessage({ type: 'test', proxyUrl: url, token: token.value.trim() });
      if (res && res.ok) {
        show('Connected' + (res.region ? ` — server region: ${res.region}` : '') + '.', 'ok');
      } else {
        show('Failed: ' + ((res && res.error) || 'no response'), 'err');
      }
    } catch (err) {
      show('Failed: ' + err.message, 'err');
    } finally {
      testBtn.disabled = false;
    }
  }

  async function save(event) {
    event.preventDefault();
    const url = readUrl();
    if (url === null) return;
    saveBtn.disabled = true;
    try {
      if (url && !(await ensurePermission(url))) {
        show('Permission to contact the server was denied; not saved.', 'err');
        return;
      }
      await ext.storage.sync.set({ proxyUrl: url, token: token.value.trim() });
      proxyUrl.value = url;
      show(url ? 'Saved. Reload SoundCloud to apply.' : 'Proxy removed.', 'ok');
    } finally {
      saveBtn.disabled = false;
    }
  }

  enabled.addEventListener('change', async () => {
    await ext.storage.sync.set({ enabled: enabled.checked });
    show(enabled.checked ? 'Enabled.' : 'Disabled. Reload SoundCloud to apply.', 'ok');
  });
  testBtn.addEventListener('click', test);
  form.addEventListener('submit', save);

  load();
})();
