// Correcting the transcript: the word right-click menu, find and replace, and the personal word list.
// Split out of app.js; app.js passes in what it shares (see the create() call there).
(function (root) {
  function create({ $, els, state, E, getSpans, hasProject, selectionRange, setSelection, visibleFrom, wordIndexFrom, beginEdit, cutSelection, showSpeakerMenu, seek, commit, renderTranscript, toast }) {
    // ---------- correcting the transcript ----------

    function wordList() {
      try { return JSON.parse(localStorage.getItem('cutline.wordList') || '[]'); } catch { return []; }
    }
    function saveWordList(list) {
      try { localStorage.setItem('cutline.wordList', JSON.stringify(list)); } catch {}
    }

    function correctSelection() {
      const sel = selectionRange();
      if (sel) beginEdit(sel[0], sel[1]);
      else if (state.caret != null) { const i = visibleFrom(state.caret); if (i >= 0) beginEdit(i, i); }
      else toast('Select the words to correct, or double-click a word.');
    }
    $('btn-correct').addEventListener('click', correctSelection);

    // Right-click menu on the transcript.
    const wordMenu = $('word-menu');
    els.transcript.addEventListener('contextmenu', (e) => {
      const i = wordIndexFrom(e.target);
      if (i < 0 || !hasProject()) return;
      e.preventDefault();
      let sel = selectionRange();
      if (!sel || i < sel[0] || i > sel[1]) { setSelection(i, i); sel = [i, i]; }
      const item = (text, key, fn) => {
        const li = document.createElement('li');
        li.textContent = text;
        if (key) { const k = document.createElement('kbd'); k.textContent = key; li.appendChild(k); }
        li.addEventListener('click', () => { wordMenu.hidden = true; fn(); });
        return li;
      };
      const text = state.words.slice(sel[0], sel[1] + 1).map((w) => w.text).join(' ');
      wordMenu.replaceChildren(
        item('Correct text…', '↵', () => beginEdit(sel[0], sel[1])),
        item('Cut', '⌫', () => cutSelection()),
        item('Find and replace this…', '⌘F', () => openFind(text)),
        item('Speaker…', '', () => showSpeakerMenu(e.clientX, e.clientY, sel, state.words[sel[0]].speaker)),
        item('Play from here', '', () => { seek(state.words[sel[0]].start); els.video.play(); }),
        item('Copy text', '⌘C', () => navigator.clipboard?.writeText(text)),
      );
      wordMenu.hidden = false;
      wordMenu.style.left = `${Math.min(window.innerWidth - 230, e.clientX)}px`;
      wordMenu.style.top = `${Math.min(window.innerHeight - wordMenu.offsetHeight - 8, e.clientY)}px`;
    });
    window.addEventListener('mousedown', (e) => { if (!e.target.closest('#word-menu')) wordMenu.hidden = true; });

    // Find and replace.
    let findHits = [];
    let findAt = -1;
    function paintFind() {
      els.transcript.querySelectorAll('.w.found').forEach((x) => x.classList.remove('found'));
      findHits = hasProject() ? E.findPhrase(state.words, state.deleted, $('find-text').value) : [];
      for (const [a, b] of findHits) for (let i = a; i <= b; i++) getSpans()[i]?.classList.add('found');
      $('find-count').textContent = $('find-text').value.trim() ? `${findHits.length} match${findHits.length === 1 ? '' : 'es'} in the transcript` : '';
      $('find-go').disabled = !findHits.length;
    }
    function renderWordList() {
      const list = wordList();
      const ul = $('word-list');
      if (!list.length) {
        const li = document.createElement('li');
        li.className = 'empty-note';
        li.textContent = 'Nothing yet. Tick the box above to add a fix.';
        ul.replaceChildren(li);
        return;
      }
      ul.replaceChildren(...list.map(([from, to], n) => {
        const li = document.createElement('li');
        const span = document.createElement('span');
        span.textContent = `${from} → ${to}`;
        const x = document.createElement('button');
        x.type = 'button';
        x.textContent = '×';
        x.title = 'Remove from the word list';
        x.addEventListener('click', () => { saveWordList(wordList().filter((_, k) => k !== n)); renderWordList(); });
        li.append(span, x);
        return li;
      }));
    }
    function openFind(initial = '') {
      if (!hasProject() || !state.words.length) { toast('There is no transcript to search yet.'); return; }
      $('find-dialog').hidden = false;
      if (initial) $('find-text').value = initial;
      $('find-remember').checked = false;
      renderWordList();
      paintFind();
      $('find-text').focus();
      $('find-text').select();
    }
    const closeFind = () => {
      $('find-dialog').hidden = true;
      els.transcript.querySelectorAll('.w.found').forEach((x) => x.classList.remove('found'));
    };
    $('btn-find').addEventListener('click', () => openFind(selectionRange() ? state.words.slice(selectionRange()[0], selectionRange()[1] + 1).map((w) => w.text).join(' ') : ''));
    $('find-close').addEventListener('click', closeFind);
    $('find-text').addEventListener('input', () => { findAt = -1; paintFind(); });
    $('find-dialog').addEventListener('keydown', (e) => {
      e.stopPropagation();
      if (e.key === 'Escape') closeFind();
      if (e.key === 'Enter' && e.target.id === 'find-replace') $('find-go').click();
    });
    $('find-next').addEventListener('click', () => {
      if (!findHits.length) return;
      findAt = (findAt + 1) % findHits.length;
      const [a] = findHits[findAt];
      getSpans()[a]?.scrollIntoView({ block: 'center', behavior: 'smooth' });
      seek(state.words[a].start);
    });
    $('find-go').addEventListener('click', () => {
      const from = $('find-text').value.trim();
      const to = $('find-replace').value.trim();
      if (!from || !to) { $('find-count').textContent = 'Type both the wrong text and the right text.'; return; }
      const r = E.replaceAll(state.words, state.deleted, state.cutGaps, from, to, state.ends);
      if (!r.count) return;
      if ($('find-remember').checked) {
        saveWordList([...wordList().filter(([f]) => f.toLowerCase() !== from.toLowerCase()), [from, to]]);
      }
      commit({ words: r.words, deleted: r.deleted, cutGaps: r.cutGaps });
      renderTranscript();
      toast(`Replaced ${r.count} × “${from}” with “${to}”. ⌘Z to undo.${$('find-remember').checked ? ' Added to your word list.' : ''}`);
      closeFind();
    });

    return { wordList, openFind };
  }

  root.CutlineFindReplace = { create };
})(window);
