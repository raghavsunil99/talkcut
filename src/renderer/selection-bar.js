// The small toolbar shown above a selection of words in the script: cut, restore, correct,
// speaker, B-roll, move and new scene.
// Split out of app.js; app.js passes in what it shares (see the create() call there).
(function (root) {
  function create({ $, els, state, getSpans, selectionRange, seek, openRailPanel, cutWords, startScene, toast }) {
    const bar = $('sel-bar');

    // Over the first selected word, or under it when there is no room above.
    function place() {
      const sel = selectionRange();
      const editing = els.transcript.querySelector('.editing');
      const spans = getSpans();
      let first = null;
      if (sel) for (let i = sel[0]; i <= sel[1] && !first; i++) first = spans[i];
      if (!sel || !first || editing || state.busy || document.activeElement?.closest?.('.dialog')) { bar.hidden = true; return; }
      const wrap = els.transcriptWrap.getBoundingClientRect();
      const r = first.getBoundingClientRect();
      if (r.bottom < wrap.top || r.top > wrap.bottom) { bar.hidden = true; return; }
      let anyCut = false;
      let allCut = true;
      for (let i = sel[0]; i <= sel[1]; i++) { if (state.deleted.has(i)) anyCut = true; else allCut = false; }
      $('btn-restore').hidden = !anyCut;
      $('btn-cut').hidden = allCut;
      $('btn-correct').hidden = anyCut;
      $('sel-move').hidden = allCut;
      $('btn-speakers').hidden = !state.words.length;
      bar.hidden = false;
      const w = bar.offsetWidth;
      const h = bar.offsetHeight;
      const left = Math.min(Math.max(wrap.left + 8, r.left), wrap.right - w - 8);
      const top = r.top - h - 6 > wrap.top ? r.top - h - 6 : r.bottom + 6;
      bar.style.left = `${Math.round(left)}px`;
      bar.style.top = `${Math.round(top)}px`;
    }

    // Clicks on the bar must not reach the script (which would clear the selection).
    bar.addEventListener('mousedown', (e) => e.stopPropagation());
    $('sel-broll').addEventListener('click', () => {
      const sel = selectionRange();
      if (!sel) return;
      seek(state.words[sel[0]].start);
      openRailPanel('media');
      toast('Click a video or photo in Media to put it over these words (it starts here). Add files with “Add videos or images…”.', { ms: 6000 });
    });
    $('sel-move').addEventListener('click', () => {
      const text = cutWords();
      if (text != null) navigator.clipboard?.writeText(text).catch(() => {});
    });
    $('sel-scene').addEventListener('click', () => {
      const sel = selectionRange();
      if (sel) startScene(sel[0]);
    });
    els.transcriptWrap.addEventListener('scroll', place, { passive: true });
    window.addEventListener('resize', place);

    return { place };
  }

  root.CutlineSelectionBar = { create };
})(window);
