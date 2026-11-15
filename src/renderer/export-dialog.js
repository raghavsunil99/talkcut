// Export dialog: presets, quality, captions burn-in and SRT/VTT, and the export itself.
// Split out of app.js; app.js passes in what it shares (see the create() call there).
(function (root) {
  function create({ $, els, state, F, C, E, T, frameLayout, hasProject, refresh, toast, showError, showOverlay, hideOverlay, baseName, setCancellable, isCancelled }) {
    // ---------- export dialog ----------

    let exportPreset = 'edited';
    function openExport() {
      if (!hasProject() || state.busy) return;
      const video = state.media.hasVideo;
      $('export-presets').querySelectorAll('button').forEach((b) => {
        b.disabled = !video && !['audio', 'captions'].includes(b.dataset.preset);
      });
      if (!video && !['audio', 'captions'].includes(exportPreset)) exportPreset = 'audio';
      $('export-edited-note').textContent = `${F.CANVASES[state.clip.canvas].label} · ${frameLayout().frame.w}×${frameLayout().frame.h}`;
      $('export-burn').checked = state.captions.enabled;
      renderExportDialog();
      $('export-dialog').hidden = false;
    }

    function renderExportDialog() {
      $('export-presets').querySelectorAll('button').forEach((b) => b.classList.toggle('on', b.dataset.preset === exportPreset));
      const subs = exportPreset === 'captions';
      $('export-video-options').hidden = subs || exportPreset === 'audio';
      $('export-sub-options').hidden = !subs;
      const notes = {
        edited: 'Exports the frame, captions, text and tracks exactly as you see them.',
        reels: 'Instagram Reels and YouTube Shorts. Text and overlays keep their place in the frame.',
        youtube: 'Wide video. A vertical clip gets bars on the sides; use Fill in Properties to crop instead.',
        square: 'Square posts and ads.',
        audio: 'Just the sound: voice, Studio Sound and music.',
        captions: 'Only the captions, timed to the edited video, to upload with it.',
      };
      $('export-note').textContent = notes[exportPreset];
      $('export-go').textContent = subs ? 'Save captions…' : 'Export…';
    }

    $('export-presets').querySelectorAll('button').forEach((b) => b.addEventListener('click', () => { exportPreset = b.dataset.preset; renderExportDialog(); }));
    const closeExport = () => { $('export-dialog').hidden = true; };
    $('export-close').addEventListener('click', closeExport);
    $('export-cancel').addEventListener('click', closeExport);
    $('export-dialog').addEventListener('keydown', (e) => { if (e.key === 'Escape') closeExport(); e.stopPropagation(); });
    $('export-go').addEventListener('click', () => {
      closeExport();
      if (exportPreset === 'captions') saveCaptionsFile($('export-sub-format').value);
      else exportMedia({ preset: exportPreset, quality: $('export-quality').value, burn: $('export-burn').checked, subtitles: $('export-srt').checked });
    });

    // The kept ranges as the export cuts them: on whole video frames (see Edits.snapRanges).
    function exportRanges() {
      return state.media.hasVideo ? E.snapRanges(state.kept, F.frameRate(state.media.fps).value) : state.kept;
    }

    function subtitlesText(format, ranges = exportRanges()) {
      return C.buildSubtitles({
        words: state.words, deleted: state.deleted, settings: state.captions, format,
        toEdited: (t) => E.toEdited(ranges, t), speed: state.clip.speed,
      });
    }

    async function saveCaptionsFile(format) {
      if (!state.words.length) { toast('There are no words to make captions from.', { error: true }); return; }
      try {
        const out = await cutline.saveCaptions(state.media, subtitlesText(format), format);
        if (out) toast(`Saved ${baseName(out)}`, { ms: 6000 });
      } catch (err) {
        showError(err);
      }
    }

    async function exportMedia({ preset = 'edited', quality = null, burn = state.captions.enabled, subtitles = false } = {}) {
      if (!hasProject() || state.busy) return;
      // Cut on whole video frames, and place tracks and subtitles on that same timeline.
      const ranges = exportRanges();
      if (!ranges.length) { toast('Everything is cut. Restore some words before exporting.', { error: true }); return; }
      els.video.pause();
      state.busy = true;
      refresh();
      // The save dialog opens first; the overlay appears once rendering reports progress.
      const stop = cutline.onExportProgress(({ progress }) => {
        showOverlay('Exporting…', `${Math.round(progress * 100)}%`, progress);
      });
      setCancellable(true);
      try {
        const out = await cutline.exportMedia(state.media, ranges, {
          ...T.forExport(state.tracks, ranges),
          preset,
          quality,
          subtitles: subtitles && state.words.length ? { format: 'srt', content: subtitlesText('srt', ranges) } : null,
          captions: {
            settings: { ...state.captions, enabled: burn },
            words: state.words,
            deleted: [...state.deleted],
            language: state.language,
          },
          clip: state.clip,
        });
        if (out) toast(`Exported ${baseName(out)}`, { ms: 6000 });
      } catch (err) {
        if (isCancelled(err)) toast('Export cancelled. Nothing was saved.');
        else showError(err);
      } finally {
        setCancellable(false);
        stop();
        state.busy = false;
        hideOverlay();
        refresh();
      }
    }

    return { openExport, saveCaptionsFile, exportMedia };
  }

  root.CutlineExportDialog = { create };
})(window);
