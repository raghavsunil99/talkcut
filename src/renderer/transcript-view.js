// The transcript as a document: one span per word, cut runs as markers, speaker labels, the caret.
// Split out of app.js; app.js passes in what it shares (see the create() call there).
(function (root) {
  function create({ $, els, state, E, languageNames, projectName, selectionRange }) {
    let spans = []; // word index -> visible span (null for cut words)
    let renderedVersion = -1;
    const getSpans = () => spans;
    // True when words or cuts changed since the transcript was last drawn.
    const needsRender = () => renderedVersion !== state.textVersion;

    // What the last render drew. A render after cuts alone (same words, same speaker names)
    // rebuilds only the paragraphs whose cuts changed and keeps the rest of the page as it is;
    // on a long transcript a full rebuild made the browser lay out every word again.
    const LONG = 120;
    const MAX = 250;
    let drawn = null; // { words, speakers, fillers, paragraphs: [{ from, to, label, key, el }] }

    // Paragraphs as word ranges. A new paragraph starts after a long pause, after a sentence
    // end with a pause, or (with speaker labels) when the speaker changes. Speech without such
    // pauses is still broken up: at a sentence end once a paragraph is LONG words, and anywhere
    // at MAX words, so no paragraph is a wall of text and a cut only redraws a short stretch.
    // Cuts never move a paragraph break. `label` says whether the paragraph is headed by its
    // speaker's name.
    function paragraphRanges() {
      const words = state.words;
      const labels = Object.keys(state.speakers).length > 0;
      const out = [];
      if (!words.length) return out;
      let from = 0;
      let paraSpeaker = words[0].speaker ?? null;
      for (let i = 1; i < words.length; i++) {
        const prev = words[i - 1];
        const gap = words[i].start - prev.end;
        const sentenceEnd = /[.!?।]["')\]]?$/.test(prev.text);
        const newSpeaker = labels && (words[i].speaker ?? null) !== paraSpeaker;
        const length = i - from;
        if (gap > 1.6 || (sentenceEnd && gap > 0.9) || newSpeaker || (sentenceEnd && length >= LONG) || length >= MAX) {
          out.push({ from, to: i - 1 });
          from = i;
          paraSpeaker = words[i].speaker ?? null;
        }
      }
      out.push({ from, to: words.length - 1 });
      // Name the speaker at the top, and wherever it differs from the paragraph before.
      out.forEach((p, n) => {
        p.label = labels && (n === 0 || (words[p.from].speaker ?? null) !== (words[out[n - 1].from].speaker ?? null));
      });
      return out;
    }

    // Which words of a paragraph are cut: when this changes, the paragraph is drawn again.
    function cutKey(p) {
      let key = '';
      for (let i = p.from; i <= p.to; i++) if (state.deleted.has(i)) key += `${i},`;
      return key;
    }

    function speakerLabel(id) {
      const el = document.createElement('span');
      el.className = 'speaker-label';
      el.dataset.speaker = id ?? '';
      el.textContent = id != null ? state.speakers[id] ?? 'Speaker' : 'Unlabelled';
      return el;
    }

    // One paragraph: its words as spans, and a ⌁ marker for each run of cut words.
    function buildParagraph(p, fillers) {
      const para = document.createElement('p');
      if (p.label) para.appendChild(speakerLabel(state.words[p.from].speaker));
      let run = null; // open marker for consecutive cut words
      for (let i = p.from; i <= p.to; i++) {
        const w = state.words[i];
        if (state.deleted.has(i)) {
          spans[i] = null;
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
          continue;
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
      }
      return para;
    }

    // The transcript reads like a document: cut words disappear, leaving a small marker that
    // shows what was cut and restores it on click.
    function renderTranscript() {
      $('no-transcript').hidden = state.words.length > 0;
      $('btn-speakers').hidden = !state.words.length;
      // The word being spoken is marked again by the next playhead update.
      if (state.nowIndex >= 0) spans[state.nowIndex]?.classList.remove('now');
      // The filler words looked for can change (in the review dialog): that redraws everything.
      const fillerWords = state.fillerSet?.() ?? null;
      const fillerKey = fillerWords ? [...fillerWords].sort().join('|') : '';
      const sameText = drawn && drawn.words === state.words && drawn.speakers === state.speakers && drawn.fillerKey === fillerKey
        && els.transcript.childElementCount === drawn.paragraphs.length;
      if (sameText) {
        for (const p of drawn.paragraphs) {
          const key = cutKey(p);
          if (key === p.key) continue;
          const el = buildParagraph(p, drawn.fillers);
          p.el.replaceWith(el);
          Object.assign(p, { key, el });
        }
      } else {
        els.transcript.textContent = '';
        spans = new Array(state.words.length).fill(null);
        const fillers = new Set(E.fillerIndices(state.words, fillerWords ?? undefined));
        const paragraphs = paragraphRanges();
        const frag = document.createDocumentFragment();
        for (const p of paragraphs) {
          p.key = cutKey(p);
          p.el = buildParagraph(p, fillers);
          frag.appendChild(p.el);
        }
        els.transcript.appendChild(frag);
        drawn = { words: state.words, speakers: state.speakers, fillers, fillerKey, paragraphs };
      }
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
