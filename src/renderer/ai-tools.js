// AI tools panel: auto-framing around the speaker, Studio Sound on and off, and the find and speaker shortcuts.
// Split out of app.js; app.js passes in what it shares (see the create() call there).
(function (root) {
  function create({ $, els, state, F, hasProject, duration, commit, refresh, toast, showError, showOverlay, hideOverlay, openFind, showSpeakerMenu, selectionRange }) {
    // ---------- auto-framing ----------

    // Fill a frame shape (9:16 by default) around the speaker's face.
    async function autoFrame(canvas = '9:16') {
      if (!hasProject() || state.busy) return;
      if (!state.media.hasVideo) { toast('Auto-framing needs a video.', { error: true }); return; }
      state.busy = true;
      refresh();
      showOverlay('Finding the speaker…', 'Looking for faces across the video.', null);
      try {
        const face = await cutline.findFaces(state.media.path, duration());
        if (!face) {
          toast('No face found in most of the video, so the framing was left as it is. Use Fill and drag the video to frame it yourself.', { error: true, ms: 7000 });
          return;
        }
        const w = els.video.videoWidth || state.media.width;
        const h = els.video.videoHeight || state.media.height;
        commit({ clip: F.autoFrame(w, h, state.clip, face, canvas) });
        toast(`Framed for ${F.CANVASES[canvas].label} around the speaker (found in ${face.found} of ${face.frames} sampled frames). Drag the video to adjust; ⌘Z to undo.`, { ms: 6000 });
      } catch (err) {
        showError(err);
      } finally {
        state.busy = false;
        hideOverlay();
        refresh();
      }
    }
    $('prop-autoframe').addEventListener('click', () => autoFrame());
    $('ai-autoframe').addEventListener('click', () => autoFrame());
    $('ai-studio').addEventListener('click', () => {
      if (!hasProject()) return;
      commit({ clip: F.normalize({ ...state.clip, enhance: !state.clip.enhance }) });
      toast(state.clip.enhance ? 'Studio Sound is on. The export uses it too.' : 'Studio Sound is off.');
    });
    $('ai-find').addEventListener('click', () => openFind());
    $('ai-speakers').addEventListener('click', (e) => {
      const r = e.currentTarget.getBoundingClientRect();
      const sel = selectionRange();
      showSpeakerMenu(r.left - 230, r.top, sel, sel ? state.words[sel[0]].speaker : null);
    });

    return { autoFrame };
  }

  root.CutlineAiTools = { create };
})(window);
