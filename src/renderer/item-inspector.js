// Properties for a selected track item (B-roll, photo, sound, text box): placement, look, timing, audio.
// Split out of app.js; app.js passes in what it shares (see the create() call there).
(function (root) {
  function create({ $, els, state, E, T, panels, frameLayout, itemAspect, commit, refresh, setDirty, snapshot, updatePlayhead, editedLength, fmtTenths, showError, getCanvasEditor, resetCaptionCache }) {
    // ---------- B-roll inspector ----------

    function openRailPanel(name) {
      document.querySelector(`.rail-btn[data-panel="${name}"]:not(.on)`)?.click();
    }

    function brollPlacement() {
      try { return localStorage.getItem('cutline.brollPlacement') || 'full'; } catch { return 'full'; }
    }
    $('broll-placement').querySelectorAll('button').forEach((b) => b.addEventListener('click', () => {
      try { localStorage.setItem('cutline.brollPlacement', b.dataset.value); } catch {}
      paintPlacementChoice();
    }));
    function paintPlacementChoice() {
      $('broll-placement').querySelectorAll('button').forEach((b) => b.classList.toggle('on', b.dataset.value === brollPlacement()));
    }
    paintPlacementChoice();

    // A picture's shape relative to the frame's (1 = same shape).
    function frameAspect() {
      const L = frameLayout();
      return L.frame.w / L.frame.h;
    }
    function mediaAspect(media) {
      return media.width && media.height ? (media.width / media.height) / frameAspect() : 16 / 9 / frameAspect();
    }

    function placedItem(id) {
      for (const t of T.placed(state.tracks, state.kept)) {
        const item = t.items.find((i) => i.id === id);
        if (item) return { track: t, item };
      }
      return null;
    }

    // Inspector edits: live while dragging or typing, one undo step when finished.
    let itemBefore = null;
    function changeItem(change, final) {
      const id = state.itemSel;
      if (!id || !T.find(state.tracks, id)) return;
      if (!itemBefore) itemBefore = snapshot();
      state.tracks = T.update(state.tracks, id, change);
      if (final) {
        state.undo.push(itemBefore);
        if (state.undo.length > 500) state.undo.shift();
        state.redo = [];
        itemBefore = null;
        setDirty(true);
        refresh();
      } else {
        resetCaptionCache();
        updatePlayhead();
        getCanvasEditor()?.update();
      }
    }

    const secs = (text) => {
      const v = String(text).trim();
      if (v.includes(':')) { const [m, s2] = v.split(':').map(Number); return m * 60 + s2; }
      return Number(v);
    };

    function buildItemInspector() {
      const grid = $('item-place');
      for (const [name, p] of Object.entries(T.PLACEMENTS)) {
        const b = document.createElement('button');
        b.type = 'button';
        b.dataset.value = name;
        b.title = p.label;
        b.appendChild(document.createElement('i'));
        b.addEventListener('click', () => {
          const found = T.find(state.tracks, state.itemSel);
          if (!found) return;
          changeItem(T.placement(name, itemAspect(found.item.id) ? itemAspect(found.item.id) / frameAspect() : mediaAspect(found.item)), true);
        });
        grid.appendChild(b);
      }
      $('item-fit').querySelectorAll('button').forEach((b) => b.addEventListener('click', () => changeItem({ fit: b.dataset.value }, true)));
      const slider = (id, apply) => {
        const range = $(id);
        const num = $(`${id}-num`);
        range.addEventListener('input', () => changeItem(apply(Number(range.value)), false));
        range.addEventListener('change', () => changeItem(apply(Number(range.value)), true));
        num.addEventListener('change', () => changeItem(apply(Number(num.value)), true));
      };
      const box = () => T.find(state.tracks, state.itemSel)?.item.box;
      slider('item-size', (v) => {
        const b = box();
        const w = Math.max(0.05, v / 100);
        const h = b.h * (w / b.w);
        return { box: { x: b.x + (b.w - w) / 2, y: b.y + (b.h - h) / 2, w, h } };
      });
      slider('item-x', (v) => ({ box: { x: v / 100 } }));
      slider('item-y', (v) => ({ box: { y: v / 100 } }));
      slider('item-opacity', (v) => ({ opacity: v / 100 }));
      slider('item-volume', (v) => ({ volume: v / 100 }));
      $('item-name').addEventListener('change', () => changeItem({ name: $('item-name').value.trim() || 'Clip' }, true));
      $('item-name').addEventListener('keydown', (e) => e.stopPropagation());
      for (const id of ['item-start', 'item-length', 'item-offset', 'item-fade-in', 'item-fade-out']) $(id).addEventListener('keydown', (e) => { e.stopPropagation(); if (e.key === 'Enter') e.target.blur(); });
      $('item-start').addEventListener('change', () => {
        const v = secs($('item-start').value);
        if (Number.isFinite(v) && v >= 0) changeItem({ start: E.toSource(state.kept, Math.min(v, editedLength() - 0.1)) }, true);
        else refresh();
      });
      $('item-length').addEventListener('change', () => {
        const v = secs($('item-length').value);
        const found = placedItem(state.itemSel);
        if (!found || !(v > 0)) { refresh(); return; }
        let length = Math.min(v, editedLength() - found.item.startE);
        if (found.item.kind === 'video' && found.item.duration) length = Math.min(length, found.item.duration - (found.item.offset || 0));
        changeItem({ length }, true);
      });
      $('item-offset').addEventListener('change', () => {
        const v = secs($('item-offset').value);
        const it = T.find(state.tracks, state.itemSel)?.item;
        if (!it || !(v >= 0)) { refresh(); return; }
        changeItem({ offset: it.duration ? Math.min(v, Math.max(0, it.duration - 0.2)) : v }, true);
      });
      $('item-fade-in').addEventListener('change', () => changeItem({ fadeIn: Number($('item-fade-in').value) || 0 }, true));
      $('item-fade-out').addEventListener('change', () => changeItem({ fadeOut: Number($('item-fade-out').value) || 0 }, true));
      $('item-duck').addEventListener('change', () => changeItem({ duck: $('item-duck').checked }, true));
      $('item-to-playhead').addEventListener('click', () => changeItem({ start: els.video.currentTime }, true));
      $('item-delete').addEventListener('click', () => {
        const id = state.itemSel;
        state.itemSel = null;
        commit({ tracks: T.remove(state.tracks, id) });
      });
      $('item-duplicate').addEventListener('click', () => {
        const found = placedItem(state.itemSel);
        if (!found) return;
        const { id, startE, url, ...rest } = found.item;
        const at = Math.min(startE + found.item.length, Math.max(0, editedLength() - found.item.length));
        const { tracks, itemId } = T.insert(state.tracks, found.track.type, { ...rest, url, start: E.toSource(state.kept, at) }, state.kept);
        state.itemSel = itemId;
        commit({ tracks });
      });
      $('item-replace').addEventListener('click', async () => {
        const found = T.find(state.tracks, state.itemSel);
        if (!found) return;
        try {
          const [m] = found.track.type === 'audio' ? await cutline.openAudio() : await cutline.openBroll();
          if (!m) return;
          panels.addToLibrary(m);
          changeItem({ path: m.path, url: m.url, kind: m.kind, name: m.name, thumb: m.thumb, duration: m.duration, offset: 0 }, true);
        } catch (err) { showError(err); }
      });
      $('item-back').addEventListener('click', () => { state.itemSel = null; state.mainSel = true; refresh(); });
    }
    buildItemInspector();

    function setSlider(id, v) {
      if (document.activeElement !== $(id)) $(id).value = Math.round(v);
      if (document.activeElement !== $(`${id}-num`)) $(`${id}-num`).value = Math.round(v);
    }
    const setField = (id, v) => { if (document.activeElement !== $(id)) $(id).value = v; };

    function renderItemInspector() {
      const found = state.itemSel ? placedItem(state.itemSel) : null;
      $('item-props').hidden = !found;
      $('clip-props').hidden = Boolean(found);
      $('prop-reset-all').hidden = Boolean(found);
      $('item-back').hidden = !found;
      if (!found) { $('props-title').textContent = 'Properties'; return; }
      const { track, item } = found;
      const overlay = track.type === 'overlay';
      const text = item.kind === 'text';
      $('props-title').textContent = text ? 'Text' : overlay ? 'B-roll' : 'Audio';
      setField('item-name', item.name ?? '');
      $('item-kind').textContent = `${text ? 'Text' : item.kind === 'image' ? 'Photo' : item.kind === 'audio' ? 'Sound' : 'Video'} on “${track.name}”${item.duration ? ` · clip is ${fmtTenths(item.duration)} long` : ''}`;
      $('item-place-group').hidden = !overlay || text;
      $('item-look-group').hidden = !overlay;
      $('item-audio-group').hidden = text || item.kind === 'image';
      $('item-duck-row').hidden = overlay;
      $('item-trim-row').hidden = !(item.kind === 'video' || item.kind === 'audio');
      $('item-replace').hidden = text;
      if (overlay && !text) {
        const shape = itemAspect(item.id) ? itemAspect(item.id) / frameAspect() : mediaAspect(item);
        $('item-place').querySelectorAll('button').forEach((b) => {
          const p = T.placement(b.dataset.value, shape);
          Object.assign(b.firstChild.style, { left: `${p.box.x * 100}%`, top: `${p.box.y * 100}%`, width: `${p.box.w * 100}%`, height: `${p.box.h * 100}%` });
          const same = ['x', 'y', 'w', 'h'].every((k) => Math.abs(p.box[k] - item.box[k]) < 0.01);
          b.classList.toggle('on', same);
        });
        $('item-fit').querySelectorAll('button').forEach((b) => b.classList.toggle('on', b.dataset.value === item.fit));
        setSlider('item-size', item.box.w * 100);
        setSlider('item-x', item.box.x * 100);
        setSlider('item-y', item.box.y * 100);
      }
      if (overlay) {
        setSlider('item-opacity', (item.opacity ?? 1) * 100);
        setField('item-fade-in', item.fadeIn ?? 0);
        setField('item-fade-out', item.fadeOut ?? 0);
      }
      setSlider('item-volume', (item.volume ?? 0) * 100);
      $('item-duck').checked = item.duck !== false;
      setField('item-start', fmtTenths(item.startE));
      setField('item-length', item.length.toFixed(1));
      setField('item-offset', (item.offset || 0).toFixed(1));
    }

    return { openRailPanel, brollPlacement, mediaAspect, renderItemInspector };
  }

  root.CutlineItemInspector = { create };
})(window);
