// The transcript as a document: one span per word, cut runs as markers, speaker labels, the caret.
// Split out of app.js; app.js passes in what it shares (see the create() call there).
(function (root) {
  function create({ $, els, state, E, languageNames, projectName, selectionRange }) {
    let spans = []; // word index -> visible span (null for cut words)
    let renderedVersion = -1;
    const getSpans = () => spans;
    // True when words or cuts changed since the transcript was last drawn.
    const needsRender = () => renderedVersion !== state.textVersion;

    // The transcript reads like a document: cut words disappear, leaving a small marker that
    // shows what was cut and restores it on click.
    function renderTranscript() {
      els.transcript.textContent = '';
      $('no-transcript').hidden = state.words.length > 0;
      $('btn-speakers').hidden = !state.words.length;
      spans = new Array(state.words.length).fill(null);
      const fillers = new Set(E.fillerIndices(state.words));
      let para = document.createElement('p');
      let run = null; // open marker for consecutive cut words
      // With speakers, each change of speaker starts a paragraph headed by their name.
      const labels = Object.keys(state.speakers).length > 0;
      let paraSpeaker;
      const label = (id) => {
        const el = document.createElement('span');
        el.className = 'speaker-label';
        el.dataset.speaker = id ?? '';
        el.textContent = id != null ? state.speakers[id] ?? 'Speaker' : 'Unlabelled';
        return el;
      };
      state.words.forEach((w, i) => {
        const prev = state.words[i - 1];
        const gap = prev ? w.start - prev.end : 0;
        const sentenceEnd = prev && /[.!?।]["')\]]?$/.test(prev.text);
        const newSpeaker = labels && prev && (w.speaker ?? null) !== (paraSpeaker ?? null);
        if (prev && (gap > 1.6 || (sentenceEnd && gap > 0.9) || newSpeaker) && para.childNodes.length) {
          els.transcript.appendChild(para);
          para = document.createElement('p');
          run = null;
        }
        if (labels && !para.childNodes.length) {
          // Name the speaker when it changes (or at the very top).
          if (i === 0 || (w.speaker ?? null) !== (paraSpeaker ?? null) || newSpeaker) para.appendChild(label(w.speaker));
          paraSpeaker = w.speaker;
        }
        if (state.deleted.has(i)) {
          if (!run) {
            run = document.createElement('span');
            run.className = 'del';
            run.dataset.from = i;
            run.textContent = '⌁';
            if (para.childNodes.length) para.appendChild(document.createTextNode(' '));
            para.appendChild(run);
          }
          run.dataset.to = i;
          run.title = `Cut: ${state.words.slice(Number(run.dataset.from), i + 1).map((x) => x.text).join(' ')} (click to restore)`;
          return;
        }
        run = null;
        if (para.childNodes.length) para.appendChild(document.createTextNode(' '));
        const span = document.createElement('span');
        span.className = 'w';
        if (fillers.has(i)) span.classList.add('filler');
        span.dataset.i = i;
        span.textContent = w.text;
        para.appendChild(span);
        spans[i] = span;
      });
      if (para.childNodes.length) els.transcript.appendChild(para);
      els.docTitle.textContent = projectName();
      els.docLanguage.textContent = languageNames[state.language] ?? state.language ?? '';
      els.docLanguage.hidden = !state.language;
      els.empty.hidden = true;
      els.transcriptWrap.hidden = false;
      renderedVersion = state.textVersion;
      state.nowIndex = -1;
    }

    // Visible (not cut) word at or after i, or -1.
    function visibleFrom(i) {
      for (let k = Math.max(0, i); k < state.words.length; k++) if (!state.deleted.has(k)) return k;
      return -1;
    }

    // Visible word before i, or -1.
    function visibleBefore(i) {
      for (let k = Math.min(i, state.words.length) - 1; k >= 0; k--) if (!state.deleted.has(k)) return k;
      return -1;
    }

    function paintCaret() {
      els.transcript.querySelectorAll('.caret-before, .caret-after').forEach((el) => el.classList.remove('caret-before', 'caret-after'));
      if (state.caret == null || selectionRange()) return;
      const at = visibleFrom(state.caret);
      if (at >= 0) spans[at]?.classList.add('caret-before');
      else spans[visibleBefore(state.words.length)]?.classList.add('caret-after');
    }

    return { renderTranscript, visibleFrom, visibleBefore, paintCaret, getSpans, needsRender };
  }

  root.CutlineTranscriptView = { create };
})(window);
