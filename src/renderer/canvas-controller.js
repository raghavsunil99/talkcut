// Editing on the video: selecting, dragging and resizing the picture, overlays and captions; crop; arrow-key nudges.
// Split out of app.js; app.js passes in what it shares (see the create() call there).
(function (root) {
  function create({ $, els, state, E, F, C, T, panels, properties, hasProject, contentRect, frameLayout, applyPreviewLayout, itemAspect, openRailPanel, snapshot, restore, commit, setDirty, refresh, updatePlayhead, editedLength, toast, resetCaptionCache }) {
    function canvasTargets() {
      if (!hasProject() || !state.media?.hasVideo) return [];
      const r = contentRect();
      const L = frameLayout();
      const k = r.width / L.frame.w;
      const out = [{
        id: 'main', main: true, label: 'Video', size: `${Math.round(state.clip.scale * 100)}%`,
        rect: { x: L.draw.x * k, y: L.draw.y * k, w: L.draw.w * k, h: L.draw.h * k },
      }];
      const e = E.toEdited(state.kept, els.video.currentTime);
      for (const { track, item } of T.activeAt(state.tracks, state.kept, e)) {
        if (track.type !== 'overlay' || track.hidden) continue;
        out.push({
          id: item.id, label: item.kind === 'text' ? (item.text || 'Text') : item.name, size: `${Math.round(item.box.w * 100)}%`,
          rect: { x: item.box.x * r.width, y: item.box.y * r.height, w: item.box.w * r.width, h: item.box.h * r.height },
        });
      }
      const line = els.captionLayer.firstElementChild;
      if (!els.captionLayer.hidden && line) {
        const st = $('stage').getBoundingClientRect();
        const b = line.getBoundingClientRect();
        out.push({ id: 'captions', captions: true, label: 'Captions', size: `${Math.round(state.captions.scale * 100)}%`, rect: { x: b.left - st.left, y: b.top - st.top, w: b.width, h: b.height } });
      }
      return out;
    }

    let canvasBefore = null;
    let captionDragStart = null;
    // A picture rectangle on the stage back into clip scale and position.
    function clipFromRect(rect) {
      const r = contentRect();
      const L = frameLayout();
      const k = r.width / L.frame.w;
      const scale = state.clip.scale * ((rect.w / k) / L.draw.w);
      const sized = F.layout(els.video.videoWidth || state.media.width, els.video.videoHeight || state.media.height, { ...state.clip, scale, x: 0, y: 0 });
      const x = (rect.x / k - (L.frame.w - sized.draw.w) / 2) / L.frame.w;
      const y = (rect.y / k - (L.frame.h - sized.draw.h) / 2) / L.frame.h;
      return F.normalize({ ...state.clip, scale, x, y });
    }

    function canvasCommit() {
      if (!canvasBefore) return;
      state.undo.push(canvasBefore);
      if (state.undo.length > 500) state.undo.shift();
      state.redo = [];
      canvasBefore = null;
      setDirty(true);
      refresh();
    }

    const canvasEditor = new CutlineCanvas($('stage'), {
      targets: canvasTargets,
      selected: () => (state.mainSel ? 'main' : state.captionSel ? 'captions' : state.itemSel),
      select: (id) => {
        state.mainSel = id === 'main';
        state.captionSel = id === 'captions';
        state.itemSel = id && id !== 'main' && id !== 'captions' ? id : null;
        if (id) { state.anchor = state.focus = -1; state.gapSel = null; state.rangeSel = null; }
        if (id === 'main') document.querySelector('.rail-btn[data-panel="properties"]:not(.on)')?.click();
        else if (id && T.find(state.tracks, id)?.item.kind === 'text') { openRailPanel('media'); document.querySelector('#media-tabs button[data-tab="text"]:not(.on)')?.click(); }
        else if (id) openRailPanel('properties');
        refresh();
      },
      change: (id, rect, phase) => {
        if (phase === 'start') { canvasBefore = snapshot(); captionDragStart = id === 'captions' ? { rect: { ...rect }, scale: state.captions.scale } : null; return; }
        if (phase === 'cancel') { canvasBefore = null; return; }
        if (phase === 'end') { canvasCommit(); return; }
        if (id === 'captions') {
          const r = contentRect();
          const start = captionDragStart;
          const scale = start && Math.abs(rect.h - start.rect.h) > 0.5 ? start.scale * (rect.h / start.rect.h) : state.captions.scale;
          state.captions = C.settingsOf({ ...state.captions, position: 'custom', x: (rect.x + rect.w / 2) / r.width, y: (rect.y + rect.h / 2) / r.height, scale });
          panels.setCaptions(state.captions);
          resetCaptionCache();
          updatePlayhead();
          return;
        }
        if (id === 'main') {
          state.clip = clipFromRect(rect);
          properties.setProps(state.clip, editedLength());
        } else {
          const r = contentRect();
          state.tracks = T.update(state.tracks, id, { box: { x: rect.x / r.width, y: rect.y / r.height, w: rect.w / r.width, h: rect.h / r.height } });
        }
        resetCaptionCache();
        updatePlayhead();
      },
      action: (name, id) => canvasAction(name, id),
    });

    function canvasAction(name, id) {
      if (id === 'captions') {
        const before = snapshot();
        if (['top', 'middle', 'bottom'].includes(name)) state.captions = C.settingsOf({ ...state.captions, position: name });
        if (name === 'smaller' || name === 'bigger') state.captions = C.settingsOf({ ...state.captions, scale: state.captions.scale * (name === 'bigger' ? 1.15 : 1 / 1.15) });
        if (name === 'style') { openRailPanel('captions'); return; }
        if (name === 'off') { state.captions = C.settingsOf({ ...state.captions, enabled: false }); state.mainSel = false; state.itemSel = null; }
        state.undo.push(before);
        state.redo = [];
        panels.setCaptions(state.captions);
        setDirty(true);
        resetCaptionCache();
        refresh();
        updatePlayhead();
        return;
      }
      if (id === 'main') {
        const base = F.layout(els.video.videoWidth || state.media.width, els.video.videoHeight || state.media.height, { ...state.clip, scale: 1, x: 0, y: 0 });
        if (name === 'fit') commit({ clip: F.normalize({ ...state.clip, scale: 1, x: 0, y: 0 }) });
        if (name === 'fill') commit({ clip: F.normalize({ ...state.clip, scale: Math.max(base.frame.w / base.draw.w, base.frame.h / base.draw.h), x: 0, y: 0 }) });
        if (name === 'center') commit({ clip: F.normalize({ ...state.clip, x: 0, y: 0 }) });
        if (name === 'crop') startCrop();
        return;
      }
      const found = T.find(state.tracks, id);
      if (!found) return;
      const { box } = found.item;
      const r = contentRect();
      const frameAspect = r.width / r.height;
      const aspect = itemAspect(id) ?? box.w * frameAspect / box.h;
      const rel = aspect / frameAspect; // item width / height in frame fractions
      if (name === 'fit') {
        const w = rel >= 1 ? 1 : rel;
        const h = rel >= 1 ? 1 / rel : 1;
        commit({ tracks: T.update(state.tracks, id, { box: { x: (1 - w) / 2, y: (1 - h) / 2, w, h } }) });
      }
      if (name === 'fill') commit({ tracks: T.update(state.tracks, id, { box: { x: 0, y: 0, w: 1, h: 1 } }) });
      if (name === 'center') commit({ tracks: T.update(state.tracks, id, { box: { x: (1 - box.w) / 2, y: (1 - box.h) / 2 } }) });
      if (name === 'remove') { state.itemSel = null; commit({ tracks: T.remove(state.tracks, id) }); }
      if (name === 'forward' || name === 'backward') {
        const overlays = state.tracks.filter((t) => t.type === 'overlay');
        const i = overlays.findIndex((t) => t.id === found.track.id);
        const to = overlays[name === 'forward' ? i + 1 : i - 1];
        if (to) commit({ tracks: T.move(state.tracks, id, to.id) });
        else if (name === 'forward') {
          const tracks = T.addTrack(state.tracks, 'overlay');
          commit({ tracks: T.move(tracks, id, tracks.at(-1).id) });
        } else toast('Already on the lowest overlay track.');
      }
    }

    // ---------- crop on the video ----------

    // The whole picture in player pixels while cropping (the stage shows exactly that).
    function cropArea() {
      const r = contentRect();
      return { left: r.left, top: r.top, width: r.width, height: r.height };
    }

    const cropEditor = new CutlineCrop(els.player, {
      change: (rect) => { if (state.cropping) state.cropping.crop = F.displayToCrop(rect, state.clip); },
      rotate: (dir) => turnWhileCropping({ rotate: (state.clip.rotate + (dir > 0 ? 90 : 270)) % 360 }),
      flip: (axis) => turnWhileCropping(axis === 'h' ? { flipH: !state.clip.flipH } : { flipV: !state.clip.flipV }),
      done: () => finishCrop(true),
      cancel: () => finishCrop(false),
    });

    function startCrop() {
      if (!hasProject() || !state.media?.hasVideo || state.cropping) return;
      els.video.pause();
      state.cropping = { before: snapshot(), crop: { ...state.clip.crop } };
      state.itemSel = null;
      document.body.classList.add('cropping');
      canvasEditor?.setEnabled(false);
      const r = applyPreviewLayout();
      const L = frameLayout();
      cropEditor.srcPixels = { w: L.frame.w, h: L.frame.h };
      cropEditor.start(F.cropToDisplay(state.cropping.crop, state.clip), cropArea(), r.width / r.height);
      refresh();
    }

    function turnWhileCropping(change) {
      if (!state.cropping) return;
      state.clip = F.normalize({ ...state.clip, ...change });
      const r = applyPreviewLayout();
      const L = frameLayout();
      cropEditor.srcPixels = { w: L.frame.w, h: L.frame.h };
      cropEditor.setArea(cropArea(), r.width / r.height, F.cropToDisplay(state.cropping.crop, state.clip));
      properties.setProps(state.clip, editedLength());
    }

    function finishCrop(apply) {
      if (!state.cropping) return;
      const { before, crop } = state.cropping;
      state.cropping = null;
      cropEditor.stop();
      document.body.classList.remove('cropping');
      if (apply) {
        state.clip = F.normalize({ ...state.clip, crop });
        state.undo.push(before);
        if (state.undo.length > 500) state.undo.shift();
        state.redo = [];
        setDirty(true);
        toast('Cropped. Use Fit or Fill on the video to size it in the frame; ⌘Z to undo.');
      } else {
        restore(before);
      }
      resetCaptionCache();
      refresh();
      updatePlayhead();
    }
    $('prop-crop-canvas').addEventListener('click', startCrop);
    window.addEventListener('keydown', (e) => {
      if (!state.cropping) return;
      if (e.key === 'Escape') { e.preventDefault(); e.stopPropagation(); finishCrop(false); }
      if (e.key === 'Enter') { e.preventDefault(); e.stopPropagation(); finishCrop(true); }
    }, true);

    // Arrow keys nudge the selected picture or overlay (1%, Shift 10%).
    window.addEventListener('keydown', (e) => {
      if (!['ArrowLeft', 'ArrowRight', 'ArrowUp', 'ArrowDown'].includes(e.key)) return;
      if (document.activeElement === els.transcript || e.target.closest?.('input, textarea, select, [contenteditable="plaintext-only"]')) return;
      const id = state.mainSel ? 'main' : state.itemSel;
      if (!id || !hasProject()) return;
      const t = canvasTargets().find((x) => x.id === id);
      if (!t) return;
      e.preventDefault();
      e.stopImmediatePropagation();
      const r = contentRect();
      const step = (e.shiftKey ? 0.1 : 0.01);
      const dx = e.key === 'ArrowLeft' ? -step * r.width : e.key === 'ArrowRight' ? step * r.width : 0;
      const dy = e.key === 'ArrowUp' ? -step * r.height : e.key === 'ArrowDown' ? step * r.height : 0;
      canvasBefore = snapshot();
      const rect = { ...t.rect, x: t.rect.x + dx, y: t.rect.y + dy };
      if (id === 'main') state.clip = clipFromRect(rect);
      else state.tracks = T.update(state.tracks, id, { box: { x: rect.x / r.width, y: rect.y / r.height } });
      canvasCommit();
    }, true);

    // The preview was laid out again while cropping: keep the crop box on the picture.
    function syncCropArea(r) {
      cropEditor.setArea(cropArea(), r.width / r.height);
    }

    return { startCrop, canvasEditor, syncCropArea };
  }

  root.CutlineCanvasController = { create };
})(window);
