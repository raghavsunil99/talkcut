// Mouse and caret in the transcript: click, drag and Shift-click to select, speaker labels, cut markers, arrow keys.
// Split out of app.js; app.js passes in what it shares (see the create() call there).
(function (root) {
  function create({ $, els, state, moveSelection, getSpans, wordIndexFrom, selectionRange, setSelection, clearSelection, visibleFrom, visibleBefore, showSpeakerMenu, labelRange, restoreRun, beginEdit, seek, keepVisible }) {
    // ---------- transcript: cursor, selection, typing ----------

    let dragging = false;
    let dragMoved = false;
    let dragFrom = -1;
    // Dragging selected words to a new place: { x, y, moving, dest }.
    let moveDrag = null;

    function clearDropMark() {
      els.transcript.querySelectorAll('.drop-before, .drop-after').forEach((el) => el.classList.remove('drop-before', 'drop-after'));
    }


    // Clicking a word puts the cursor before or after it, depending on which half was clicked.
    function caretFromPoint(i, clientX) {
      const r = getSpans()[i].getBoundingClientRect();
      return clientX > r.left + r.width / 2 ? i + 1 : i;
    }

    els.transcript.addEventListener('mousedown', (e) => {
      if (e.button !== 0 || e.target.closest('.editing')) return;
      const speakerLabel = e.target.closest('.speaker-label');
      if (speakerLabel) {
        if (e.target.closest('input')) return;
        e.preventDefault();
        const id = speakerLabel.dataset.speaker || null;
        const sel = selectionRange();
        showSpeakerMenu(e.clientX, e.clientY + 8, sel ?? labelRange(speakerLabel), id);
        return;
      }
      const time = e.target.closest('.para-time');
      if (time) {
        e.preventDefault();
        const at = visibleFrom(Number(time.dataset.from));
        if (at >= 0) { state.caret = at; setSelection(-1, -1); seek(state.words[at].start); }
        return;
      }
      const marker = e.target.closest('.del');
      if (marker) {
        e.preventDefault();
        restoreRun(Number(marker.dataset.from), Number(marker.dataset.to));
        return;
      }
      const i = wordIndexFrom(e.target);
      els.transcript.focus();
      if (i < 0) { clearSelection(); return; }
      e.preventDefault();
      state.gapSel = null;
      state.itemSel = null;
      if (e.shiftKey && (state.anchor >= 0 || state.caret != null)) {
        const from = state.anchor >= 0 ? state.anchor : Math.min(visibleFrom(state.caret), i);
        setSelection(from < 0 ? i : from, i);
        return;
      }
      dragFrom = i;
      // Pressing on the selection may start dragging it somewhere else; a plain click on it is
      // handled on release.
      const sel = selectionRange();
      if (sel && i >= sel[0] && i <= sel[1]) {
        moveDrag = { x: e.clientX, y: e.clientY, moving: false, dest: null, caret: caretFromPoint(i, e.clientX) };
        return;
      }
      dragging = true;
      dragMoved = false;
      state.caret = caretFromPoint(i, e.clientX);
      setSelection(-1, -1);
    });

    window.addEventListener('mousemove', (e) => {
      if (!moveDrag) return;
      if (!moveDrag.moving && Math.hypot(e.clientX - moveDrag.x, e.clientY - moveDrag.y) < 5) return;
      moveDrag.moving = true;
      els.transcript.classList.add('moving-words');
      clearDropMark();
      const i = wordIndexFrom(e.target);
      moveDrag.dest = null;
      if (i < 0) return;
      const sel = selectionRange();
      const dest = caretFromPoint(i, e.clientX);
      if (sel && dest >= sel[0] && dest <= sel[1] + 1) return; // dropping on itself does nothing
      moveDrag.dest = dest;
      getSpans()[i].classList.add(dest === i ? 'drop-before' : 'drop-after');
    });

    els.transcript.addEventListener('mousemove', (e) => {
      if (!dragging) return;
      const i = wordIndexFrom(e.target);
      if (i >= 0 && (i !== dragFrom || dragMoved) && i !== state.focus) {
        dragMoved = true;
        setSelection(dragFrom, i);
      }
    });

    window.addEventListener('mouseup', () => {
      if (moveDrag) {
        const drag = moveDrag;
        moveDrag = null;
        clearDropMark();
        els.transcript.classList.remove('moving-words');
        if (drag.moving) {
          if (drag.dest != null) moveSelection(drag.dest);
        } else {
          // A plain click on the selection: put the cursor there, like any other click.
          state.caret = drag.caret;
          setSelection(-1, -1);
          if (dragFrom >= 0) seek(state.words[dragFrom].start);
        }
        return;
      }
      if (!dragging) return;
      dragging = false;
      // A plain click moves the cursor and the playhead to that word.
      if (!dragMoved && dragFrom >= 0) seek(state.words[dragFrom].start);
    });

    els.transcript.addEventListener('dblclick', (e) => {
      const i = wordIndexFrom(e.target);
      if (i >= 0) beginEdit(i, i);
    });

    function transcriptFocused() {
      return document.activeElement === els.transcript;
    }

    // Move the cursor one visible word left or right; with Shift, grow the selection instead.
    function moveCaret(dir, extend) {
      const n = state.words.length;
      const sel = selectionRange();
      if (extend) {
        const anchor = state.anchor >= 0 ? state.anchor : (dir > 0 ? visibleFrom(state.caret ?? 0) : visibleBefore(state.caret ?? n));
        const base = state.focus >= 0 ? state.focus : anchor;
        const next = dir > 0 ? visibleFrom(base + (state.focus >= 0 ? 1 : 0)) : visibleBefore(state.focus >= 0 ? base : base + 1);
        if (anchor < 0 || next < 0) return;
        setSelection(anchor, next);
        keepVisible(getSpans()[next]);
        return;
      }
      let caret = state.caret ?? 0;
      if (sel) caret = dir > 0 ? sel[1] + 1 : sel[0];
      else if (dir > 0) { const k = visibleFrom(caret); caret = k < 0 ? n : k + 1; }
      else { const k = visibleBefore(caret); caret = k < 0 ? 0 : k; }
      state.caret = caret;
      setSelection(-1, -1);
      const at = visibleFrom(caret) >= 0 ? visibleFrom(caret) : visibleBefore(n);
      if (at >= 0) { seek(state.words[at].start); keepVisible(getSpans()[at]); }
    }

    return { transcriptFocused, moveCaret };
  }

  root.CutlineTranscriptInput = { create };
})(window);
