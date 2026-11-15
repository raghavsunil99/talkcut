// Edit commands: cut and restore words, pauses, ranges and items; correct text; remove fillers and retakes; shorten pauses; insert media.
// Split out of app.js; app.js passes in what it shares (see the create() call there).
(function (root) {
  function create({ $, els, state, E, T, getSpans, hasProject, duration, editedLength, selectionRange, visibleFrom, visibleBefore, commit, refresh, brollPlacement, mediaAspect, openRailPanel, fmtTenths, toast }) {
    function cutSelection({ restore: restoreSel = false, toggle = false } = {}) {
      if (!hasProject()) return;
      if (state.rangeSel && !restoreSel) {
        const r = E.cutRange(state.words, state.deleted, state.rangeCuts, state.rangeSel[0], state.rangeSel[1]);
        const [a, b] = state.rangeSel;
        state.rangeSel = null;
        commit(r);
        toast(`Cut ${(b - a).toFixed(1)}s. Press ⌘Z to undo.`);
        return;
      }
      if (state.itemSel != null && !restoreSel) {
        const id = state.itemSel;
        state.itemSel = null;
        commit({ tracks: T.remove(state.tracks, id) });
        return;
      }
      if (state.gapSel != null) {
        const next = new Set(state.cutGaps);
        const isCut = next.has(state.gapSel);
        if (restoreSel || (toggle && isCut)) next.delete(state.gapSel);
        else next.add(state.gapSel);
        commit({ cutGaps: next });
        return;
      }
      const sel = selectionRange();
      if (!sel) return;
      const next = new Set(state.deleted);
      let allCut = true;
      for (let i = sel[0]; i <= sel[1]; i++) if (!next.has(i)) { allCut = false; break; }
      const shouldRestore = restoreSel || (toggle && allCut);
      for (let i = sel[0]; i <= sel[1]; i++) {
        if (shouldRestore) next.delete(i); else next.add(i);
      }
      // Like deleting text: the cursor stays where the selection was.
      if (!shouldRestore) {
        state.caret = sel[1] + 1;
        state.anchor = state.focus = -1;
      }
      commit({ deleted: next });
    }

    // Backspace / Delete with only a text cursor: cut the word before / after it.
    function cutAtCaret(forward) {
      if (state.caret == null) return;
      const i = forward ? visibleFrom(state.caret) : visibleBefore(state.caret);
      if (i < 0) return;
      const next = new Set(state.deleted);
      next.add(i);
      state.caret = forward ? i + 1 : i;
      commit({ deleted: next });
    }

    function restoreRun(from, to) {
      const r = E.restoreWords(state.words, state.deleted, state.rangeCuts, from, to);
      state.anchor = from;
      state.focus = to;
      state.caret = null;
      commit(r);
    }

    // ---------- correcting text ----------

    // Edit the text of words from..to in place. The media is untouched; only the spelling
    // changes (like Descript's correct mode). Enter or clicking away saves, Escape cancels.
    function beginEdit(from, to, initial = null) {
      if (!hasProject() || state.busy) return;
      for (let i = from; i <= to; i++) {
        if (state.deleted.has(i)) { toast('Restore the cut words in this selection before correcting it.'); return; }
      }
      const first = getSpans()[from];
      if (!first) return;
      els.video.pause();
      const editor = document.createElement('span');
      editor.className = 'editing';
      editor.contentEditable = 'plaintext-only';
      editor.spellcheck = false;
      editor.textContent = initial ?? state.words.slice(from, to + 1).map((w) => w.text).join(' ');
      first.before(editor);
      for (let i = from; i <= to; i++) {
        const sp = getSpans()[i];
        if (!sp) continue;
        if (sp.previousSibling?.nodeType === Node.TEXT_NODE && i > from) sp.previousSibling.remove();
        sp.remove();
      }
      let done = false;
      const finish = (save) => {
        if (done) return;
        done = true;
        const text = editor.textContent;
        if (save && text.trim() !== state.words.slice(from, to + 1).map((w) => w.text).join(' ')) {
          const r = E.replaceWords(state.words, state.deleted, state.cutGaps, from, to, text);
          state.anchor = state.focus = -1;
          state.caret = from + (text.trim() ? text.trim().split(/\s+/).length : to - from + 1);
          commit(r);
        } else {
          state.textVersion++;
          refresh();
        }
        els.transcript.focus();
      };
      editor.addEventListener('keydown', (e) => {
        e.stopPropagation();
        if (e.key === 'Enter') { e.preventDefault(); finish(true); }
        else if (e.key === 'Escape') { e.preventDefault(); finish(false); }
      });
      editor.addEventListener('blur', () => finish(true));
      editor.focus();
      const range = document.createRange();
      range.selectNodeContents(editor);
      if (initial != null) range.collapse(false);
      const selection = window.getSelection();
      selection.removeAllRanges();
      selection.addRange(range);
    }

    function removeFillers() {
      const fillers = E.fillerIndices(state.words).filter((i) => !state.deleted.has(i));
      if (!fillers.length) {
        toast('No filler words found in the transcript.');
        return;
      }
      const next = new Set(state.deleted);
      fillers.forEach((i) => next.add(i));
      commit({ deleted: next });
      toast(`Cut ${fillers.length} filler word${fillers.length === 1 ? '' : 's'}. Press ⌘Z to undo.`);
    }

    function removeRetakes() {
      const takes = E.findRetakes(state.words, state.deleted);
      if (!takes.length) {
        toast('No repeated takes found. Lines said again right after a pause or a false start are what this looks for.');
        return;
      }
      const next = new Set(state.deleted);
      takes.forEach((t) => t.idx.forEach((i) => next.add(i)));
      commit({ deleted: next });
      const words = takes.reduce((n, t) => n + t.idx.length, 0);
      toast(`Cut ${takes.length} earlier take${takes.length === 1 ? '' : 's'} (${words} words), keeping the last one each time. Press ⌘Z to undo.`, { ms: 6000 });
    }

    function shortenPauses() {
      const long = E.gaps(state.words, duration(), 1.0).filter((g) => !state.cutGaps.has(g.i));
      if (!long.length) {
        toast('No pauses longer than 1 second to shorten.');
        return;
      }
      const next = new Set(state.cutGaps);
      long.forEach((g) => next.add(g.i));
      const saved = long.reduce((sum, g) => sum + (g.end - g.start - E.GAP_KEEP), 0);
      commit({ cutGaps: next });
      toast(`Shortened ${long.length} pause${long.length === 1 ? '' : 's'}, saving ${saved.toFixed(1)}s. Press ⌘Z to undo.`);
    }

    // Put a video, photo or sound at the playhead on the first free track of its kind (a new
    // track is added when they are all busy). Videos run up to 4 s, photos 3 s, sounds their
    // whole length.
    function insertMedia(media) {
      if (!hasProject()) { toast('Open a project first, then add media to it.'); return; }
      const audio = media.kind === 'audio';
      if (!audio && !state.media.hasVideo) { toast('Overlays cover the picture, so they need a video project.', { error: true }); return; }
      const total = editedLength();
      let startE = E.toEdited(state.kept, els.video.currentTime);
      const want = audio ? (media.duration || total) : media.kind === 'image' ? 3 : Math.min(4, media.duration || 4);
      const length = Math.min(want, total);
      if (startE + length > total) startE = Math.max(0, total - length);
      const place = audio ? null : T.placement(brollPlacement(), mediaAspect(media));
      const { tracks, itemId, trackId } = T.insert(state.tracks, audio ? 'audio' : 'overlay', {
        ...(place ?? {}),
        path: media.path,
        url: media.url,
        kind: media.kind,
        name: media.name,
        thumb: media.thumb,
        duration: media.duration,
        start: E.toSource(state.kept, startE),
        length,
      }, state.kept);
      state.itemSel = itemId;
      state.anchor = state.focus = -1;
      state.gapSel = null;
      commit({ tracks });
      const track = tracks.find((t) => t.id === trackId);
      toast(`Added ${media.name} to “${track.name}” at ${fmtTenths(startE)}. Change its placement, timing and fades in Properties.`);
      if (!audio) openRailPanel('properties');
    }

    return { cutSelection, cutAtCaret, restoreRun, beginEdit, removeFillers, removeRetakes, shortenPauses, insertMedia };
  }

  root.CutlineEditCommands = { create };
})(window);
