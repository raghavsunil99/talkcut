// Platform wording: Ctrl instead of ⌘ and PC words on Windows; taps and phone words on Android. Rewrites the page's text as it changes.
// Split out of app.js; app.js passes in what it shares (see the create() call there).
(function (root) {
  function create({ IS_MOBILE, IS_WIN }) {
    function forPlatform(text) {
      if (!text) return text;
      if (IS_MOBILE) {
        return String(text)
          .replace(/Keys are stored encrypted on this Mac/g, 'Keys are kept on this phone only')
          .replace(/transcribes it on this Mac/g, 'transcribes it with ElevenLabs')
          .replace(/ on this Mac/g, ' on this phone').replace(/this Mac/g, 'this phone')
          .replace(/\bClick /g, 'Tap ').replace(/\bclick /g, 'tap ').replace(/double-click/g, 'double-tap')
          .replace(/ \((?:⇧|⌥)?⌘[^)]*\)/g, '').replace(/(?:⇧|⌥)?⌘\S+/g, '').replace(/Ctrl\+\S+/g, '');
      }
      if (!IS_WIN) return text;
      return String(text)
        .replace(/⇧⌘/g, 'Ctrl+Shift+').replace(/⌥⌘/g, 'Ctrl+Alt+').replace(/⌘/g, 'Ctrl+')
        .replace(/⇧/g, 'Shift+').replace(/⌥/g, 'Alt+')
        .replace(/Show in Finder/g, 'Show in File Explorer').replace(/Finder/g, 'File Explorer')
        .replace(/this Mac/g, 'this PC').replace(/your Mac/g, 'your PC').replace(/Match Mac/g, 'Match Windows');
    }
    function localize(rootEl) {
      if (!IS_WIN && !IS_MOBILE) return;
      const walk = document.createTreeWalker(rootEl, NodeFilter.SHOW_TEXT);
      for (let n = walk.nextNode(); n; n = walk.nextNode()) {
        const t = forPlatform(n.nodeValue);
        if (t !== n.nodeValue) n.nodeValue = t;
      }
      const els2 = rootEl.querySelectorAll ? [rootEl, ...rootEl.querySelectorAll('[title], [placeholder]')] : [];
      for (const el of els2) {
        if (el.title) { const t = forPlatform(el.title); if (t !== el.title) el.title = t; }
        if (el.placeholder) { const t = forPlatform(el.placeholder); if (t !== el.placeholder) el.placeholder = t; }
      }
    }
    if (IS_WIN || IS_MOBILE) {
      localize(document.body);
      new MutationObserver((list) => {
        for (const m of list) for (const n of m.addedNodes) localize(n.nodeType === 1 ? n : n.parentNode ?? document.body);
      }).observe(document.body, { childList: true, subtree: true });
    }

    return { forPlatform };
  }

  root.CutlinePlatformText = { create };
})(window);
