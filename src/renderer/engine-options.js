// Transcription options: the language and quality lists, remembered between sessions.
// Split out of app.js; app.js passes in what it shares (see the create() call there).
(function (root) {
  function create({ els, languageNames }) {
    // ---------- settings ----------

    async function loadSettings() {
      const { languages, qualities } = await cutline.options();
      const read = (key, fallback) => { try { return localStorage.getItem(key) || fallback; } catch { return fallback; } };
      const savedLang = read('cutline.language', 'auto');
      const savedQuality = read('cutline.quality', 'fast');
      for (const { code, label } of languages) {
        languageNames[code] = label;
        els.language.add(new Option(label, code, false, code === savedLang));
      }
      for (const { code, label } of qualities) els.quality.add(new Option(label, code, false, code === savedQuality));
      const remember = (key, el) => el.addEventListener('change', () => { try { localStorage.setItem(key, el.value); } catch {} });
      remember('cutline.language', els.language);
      remember('cutline.quality', els.quality);
    }

    return { loadSettings };
  }

  root.CutlineEngineOptions = { create };
})(window);
