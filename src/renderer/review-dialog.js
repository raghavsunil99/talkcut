// The review dialog: what Remove fillers, Remove retakes and Shorten pauses would cut, with a
// play button and a checkbox for each, applied as one undo step. Also where the filler words
// per language and the pause settings are chosen.
// Split out of app.js; app.js passes in what it shares (see the create() call there).
(function (root) {
  function create({ $, els, state, E, R, timeline, hasProject, duration, commit, refresh, toast, fmtTenths }) {
    const read = (k, d) => { try { const v = localStorage.getItem(k); return v == null ? d : JSON.parse(v); } catch { return d; } };
    const write = (k, v) => { try { localStorage.setItem(k, JSON.stringify(v)); } catch {} };

    let kinds = new Set();
    let items = [];
    let prefs = read('cutline.fillers', {});
    let minPause = read('cutline.pauseMin', 1);
    let keep = E.GAP_KEEP;
    const unticked = new Set(); // item ids the user unticked, kept while the list is rebuilt

    const language = () => (R.FILLER_WORDS[state.language] ? state.language : 'en');
    // The filler words in use for this project's language (the transcript marks them too).
    function fillerSet() { return R.fillerSet(language(), prefs); }

    function build() {
      const sounds = kinds.has('sound') ? R.wordlessSounds({ words: state.words, peaks: timeline.peaks, perSecond: timeline.perSecond, duration: duration(), cuts: state.cuts }) : [];
      items = R.proposals({ words: state.words, deleted: state.deleted, cutGaps: state.cutGaps, duration: duration(), order: state.order, kinds: [...kinds], fillers: fillerSet(), sounds, minPause, gapKeep: keep });
      for (const it of items) it.checked = !unticked.has(it.id);
    }

    function render() {
      $('review-kinds').querySelectorAll('button').forEach((b) => b.classList.toggle('on', kinds.has(b.dataset.kind)));
      $('review-fillers').hidden = !kinds.has('filler');
      $('review-pauses').hidden = !kinds.has('pause');
      $('review-waveform-note').hidden = !(kinds.has('sound') && !timeline.peaks);
      renderFillerChoices();
      $('review-min').value = minPause;
      $('review-min-out').textContent = `${minPause.toFixed(1)} s`;
      $('review-keep').value = keep;
      $('review-keep-out').textContent = `${keep.toFixed(2)} s`;
      const list = $('review-list');
      list.replaceChildren();
      for (const it of items) {
        const row = document.createElement('label');
        row.className = 'review-row';
        row.dataset.id = it.id;
        const box = document.createElement('input');
        box.type = 'checkbox';
        box.checked = it.checked;
        box.addEventListener('change', () => {
          it.checked = box.checked;
          if (box.checked) unticked.delete(it.id); else unticked.add(it.id);
          renderSummary();
        });
        const tag = document.createElement('span');
        tag.className = `review-tag ${it.kind}`;
        tag.textContent = { filler: 'Filler', sound: 'Sound', retake: 'Retake', pause: 'Pause' }[it.kind];
        const text = document.createElement('span');
        text.className = 'review-text';
        const before = document.createElement('span');
        before.className = 'ctx';
        before.textContent = it.before ? `…${it.before} ` : '';
        const target = document.createElement('b');
        target.textContent = it.text;
        const after = document.createElement('span');
        after.className = 'ctx';
        after.textContent = it.after ? ` ${it.after}…` : '';
        text.append(before, target, after);
        const time = document.createElement('span');
        time.className = 'review-time';
        time.textContent = fmtTenths(E.toEdited(state.kept, it.start));
        const play = document.createElement('button');
        play.type = 'button';
        play.className = 'btn ghost icon review-play';
        play.title = 'Play this with a moment either side';
        play.textContent = '▶';
        play.addEventListener('click', (e) => { e.preventDefault(); preview(it); });
        row.append(box, tag, text, time, play);
        list.appendChild(row);
      }
      $('review-empty').hidden = items.length > 0;
      renderSummary();
    }

    function renderSummary() {
      const on = items.filter((it) => it.checked);
      const secs = on.reduce((n, it) => n + it.saves, 0);
      $('review-summary').textContent = items.length ? `${on.length} of ${items.length} selected · saves about ${secs.toFixed(1)} s` : '';
      const keepChanged = Math.abs(keep - (state.gapKeep ?? E.GAP_KEEP)) > 1e-9;
      $('review-apply').disabled = !on.length && !keepChanged;
    }

    // The filler words for this language: sounds (on unless turned off), words that are only
    // sometimes fillers (off unless turned on), and the user's own.
    function renderFillerChoices() {
      const lang = language();
      const p = prefs[lang] ?? {};
      const box = $('review-filler-words');
      box.replaceChildren();
      const chip = (word, on, toggle, removable = false) => {
        const b = document.createElement('button');
        b.type = 'button';
        b.className = `chip${on ? ' on' : ''}`;
        b.textContent = word;
        b.dataset.word = word;
        b.title = removable ? 'Your word: click to remove it' : on ? 'Looked for: click to stop' : 'Not looked for: click to include';
        b.addEventListener('click', toggle);
        box.appendChild(b);
      };
      const set = (change) => { prefs = { ...prefs, [lang]: { ...p, ...change } }; write('cutline.fillers', prefs); rebuild(); };
      const sounds = [...new Set([...(R.FILLER_WORDS[lang]?.sounds ?? []), ...(lang === 'en' ? [] : R.FILLER_WORDS.en.sounds.slice(0, 4))])];
      for (const w of sounds) {
        const off = (p.off ?? []).includes(w);
        chip(w, !off, () => set({ off: off ? p.off.filter((x) => x !== w) : [...(p.off ?? []), w] }));
      }
      for (const w of R.FILLER_WORDS[lang]?.words ?? []) {
        const on = (p.on ?? []).includes(w);
        chip(w, on, () => set({ on: on ? p.on.filter((x) => x !== w) : [...(p.on ?? []), w] }));
      }
      for (const w of p.extra ?? []) chip(w, true, () => set({ extra: p.extra.filter((x) => x !== w) }), true);
      $('review-filler-lang').textContent = { en: 'English', te: 'Telugu', hi: 'Hindi', ta: 'Tamil', kn: 'Kannada', ml: 'Malayalam' }[lang];
    }

    function rebuild() {
      build();
      render();
      mod.onFillersChange?.();
    }

    // Play the stretch with a little either side, inside its own piece of the recording, then stop.
    function preview(it) {
      const d = duration();
      const { pieces } = E.layout(state.words, state.order, d);
      const piece = pieces.find((p) => it.start >= p.start && it.start < p.end) ?? { start: 0, end: d };
      const from = Math.max(piece.start, it.start - 0.6);
      const to = Math.min(piece.end, it.end + 0.6);
      state.previewing = { end: to };
      state.playK = -1;
      els.video.currentTime = from;
      els.video.play().catch(() => {});
    }

    // Called every frame by app.js while previewing: stop at the end of the stretch.
    function previewTick() {
      const p = state.previewing;
      if (!p) return false;
      if (els.video.paused || els.video.currentTime >= p.end) {
        els.video.pause();
        state.previewing = null;
        state.playK = -1;
      }
      return true;
    }

    function open(kind) {
      if (!hasProject() || state.busy) return;
      if (!state.words.length && kind !== 'sound') { toast('These tools work on the transcript. Transcribe the video first.'); return; }
      kinds = new Set([kind]);
      unticked.clear();
      keep = state.gapKeep ?? E.GAP_KEEP;
      els.video.pause();
      build();
      render();
      $('review-dialog').hidden = false;
      $('review-apply').focus();
    }

    function close() {
      $('review-dialog').hidden = true;
      if (state.previewing) { els.video.pause(); state.previewing = null; }
    }

    function applyReview() {
      const r = R.apply(items, { deleted: state.deleted, cutGaps: state.cutGaps, rangeCuts: state.rangeCuts });
      const on = items.filter((it) => it.checked);
      close();
      commit({ ...r, gapKeep: keep });
      const counts = {};
      for (const it of on) counts[it.kind] = (counts[it.kind] ?? 0) + 1;
      const said = Object.entries(counts).map(([k, n]) => `${n} ${{ filler: 'filler', sound: 'sound', retake: 'retake', pause: 'pause' }[k]}${n === 1 ? '' : 's'}`).join(', ');
      toast(on.length ? `Cut ${said}. Press ⌘Z to undo all of it.` : 'Pauses now keep the new length. Press ⌘Z to undo.', { ms: 6000 });
    }

    const mod = {};
    $('review-kinds').querySelectorAll('button').forEach((b) => b.addEventListener('click', () => {
      const k = b.dataset.kind;
      if (kinds.has(k) && kinds.size > 1) kinds.delete(k); else kinds.add(k);
      rebuild();
    }));
    $('review-all').addEventListener('click', () => { items.forEach((it) => { it.checked = true; unticked.delete(it.id); }); render(); });
    $('review-none').addEventListener('click', () => { items.forEach((it) => { it.checked = false; unticked.add(it.id); }); render(); });
    $('review-min').addEventListener('input', (e) => { minPause = Number(e.target.value); write('cutline.pauseMin', minPause); rebuild(); });
    $('review-keep').addEventListener('input', (e) => { keep = Number(e.target.value); build(); render(); });
    $('review-add-word').addEventListener('keydown', (e) => {
      e.stopPropagation();
      if (e.key !== 'Enter') return;
      const word = e.target.value.trim();
      if (!word) return;
      const lang = language();
      const p = prefs[lang] ?? {};
      prefs = { ...prefs, [lang]: { ...p, extra: [...new Set([...(p.extra ?? []), word])] } };
      write('cutline.fillers', prefs);
      e.target.value = '';
      rebuild();
    });
    $('review-apply').addEventListener('click', applyReview);
    $('review-cancel').addEventListener('click', close);
    $('review-close').addEventListener('click', close);
    // Keys stay in the dialog: Backspace and Space must not cut or play the transcript.
    $('review-dialog').addEventListener('keydown', (e) => {
      e.stopPropagation();
      if (e.key === 'Escape') close();
      if (e.key === 'Enter' && e.target.tagName !== 'INPUT') applyReview();
    });

    return Object.assign(mod, { open, close, previewTick, fillerSet });
  }

  root.CutlineReviewDialog = { create };
})(window);
