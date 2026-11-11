// Firefox has no extension service workers: it needs `background.scripts`,
// which Chrome warns about. manifest.json stays Chrome-clean and this
// derives the Firefox variant from it.
export function firefoxManifest(chrome) {
  const m = structuredClone(chrome);
  delete m.minimum_chrome_version;
  m.author = 'Jari Zwarts, Kuzuw';
  m.background = { scripts: ['src/core.js', 'src/background.js'] };
  m.browser_specific_settings = {
    gecko: { id: 'byeblock@kuzuw.github.io', strict_min_version: '128.0' },
  };
  return m;
}
