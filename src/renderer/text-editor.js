// Text and titles: presets in the Elements panel and the editor for a selected text box.
// Split out of app.js; app.js passes in what it shares (see the create() call there).
(function (root) {
  function create({ $, els, state, E, T, hasProject, editedLength, commit, snapshot, setDirty, refresh, updatePlayhead, toast }) {
    // ---------- text and titles ----------

    const TX = CutlineText;
    const textName = (text) => (String(text).split('\n')[0].trim() || 'Text').slice(0, 40);

    function insertText(presetId) {
      if (!hasProject()) { toast('Open a project first, then add text to it.'); return; }
      if (!state.media.hasVideo) { toast('Text goes over the picture, so it needs a video project.', { error: true }); return; }
      const p = TX.PRESETS[presetId];
      const total = editedLength();
      const length = Math.min(4, total);
      let startE = E.toEdited(state.kept, els.video.currentTime);
      if (startE + length > total) startE = Math.max(0, total - length);
      const { tracks, itemId } = T.insert(state.tracks, 'overlay', {
        kind: 'text', text: p.text, name: textName(p.text), style: { preset: presetId },
        box: { ...p.box }, start: E.toSource(state.kept, startE), length,
      }, state.kept);
      state.itemSel = itemId;
      state.mainSel = false;
      state.anchor = state.focus = -1;
      state.gapSel = null;
      commit({ tracks });
      $('text-content').focus();
      $('text-content').select();
    }

    function selectedText() {
      const found = state.itemSel ? T.find(state.tracks, state.itemSel) : null;
      return found?.item.kind === 'text' ? found.item : null;
    }

    // Typing updates the preview live and lands as one undo step when the field is left.
    let textBefore = null;
    function changeText(change, final) {
      const item = selectedText();
      if (!item) return;
      if (!textBefore) textBefore = snapshot();
      const style = change.style ? { ...item.style, ...change.style } : item.style;
      const next = { ...change, style };
      if (change.text != null) next.name = textName(change.text);
      state.tracks = T.update(state.tracks, item.id, next);
      if (final) {
        state.undo.push(textBefore);
        if (state.undo.length > 500) state.undo.shift();
        state.redo = [];
        textBefore = null;
        setDirty(true);
        refresh();
      } else {
        updatePlayhead();
      }
    }

    function buildElementsPanel() {
      const list = $('text-presets');
      for (const [id, p] of Object.entries(TX.PRESETS)) {
        const b = document.createElement('button');
        b.type = 'button';
        b.className = 'text-preset';
        b.dataset.preset = id;
        b.title = `Add ${p.label.toLowerCase()} at the playhead`;
        const sample = document.createElement('div');
        sample.className = 'overlay-layer';
        // Thumbnails show the look, not the position: every sample sits in the middle of its tile.
        const lines = id === 'lower' ? 2 : 1;
        Object.assign(sample.style, { left: id === 'bar' ? '0' : '10%', top: '16%', width: id === 'bar' ? '100%' : '80%', height: `${lines * 22}%` });
        const name = document.createElement('span');
        name.className = 'preset-name';
        name.textContent = p.label;
        b.append(sample, name);
        b.addEventListener('click', () => insertText(id));
        list.appendChild(b);
        requestAnimationFrame(() => TX.renderDom(sample, { text: id === 'lower' ? 'Your Name\nWhat you do' : p.label, style: { preset: id } }, 'en'));
      }
      const content = $('text-content');
      content.addEventListener('input', () => changeText({ text: content.value }, false));
      content.addEventListener('change', () => changeText({ text: content.value }, true));
      content.addEventListener('keydown', (e) => e.stopPropagation());
      for (const key of ['color', 'accent', 'bg']) {
        const input = $(`text-${key}`);
        input.addEventListener('input', () => changeText({ style: { [key]: input.value } }, false));
        input.addEventListener('change', () => changeText({ style: { [key]: input.value } }, true));
      }
      $('text-bg-on').addEventListener('change', () => {
        changeText({ style: { bg: $('text-bg-on').checked ? $('text-bg').value : null } }, true);
      });
      $('text-upper').addEventListener('change', () => changeText({ style: { upper: $('text-upper').checked } }, true));
      $('text-shadow').addEventListener('change', () => changeText({ style: { shadow: $('text-shadow').checked } }, true));
      $('text-align').querySelectorAll('button').forEach((b) => b.addEventListener('click', () => changeText({ style: { align: b.dataset.value } }, true)));
    }

    buildElementsPanel();

    // CSS colour (hex or rgba) to the #rrggbb a colour input takes.
    function toHex(css, fallback) {
      if (/^#[0-9a-f]{6}$/i.test(css || '')) return css;
      const m = /rgba?\((\d+),\s*(\d+),\s*(\d+)/.exec(css || '');
      return m ? `#${[m[1], m[2], m[3]].map((n) => Number(n).toString(16).padStart(2, '0')).join('')}` : fallback;
    }

    function renderTextEditor() {
      const item = selectedText();
      $('text-edit').hidden = !item;
      if (!item) return;
      const s = TX.styleOf(item);
      if (document.activeElement !== $('text-content')) $('text-content').value = item.text ?? '';
      $('text-color').value = toHex(s.color, '#ffffff');
      $('text-accent').value = toHex(s.accent, '#ffd84d');
      $('text-bg').value = toHex(s.bg, '#000000');
      $('text-bg-on').checked = Boolean(s.bg);
      $('text-upper').checked = Boolean(s.upper);
      $('text-shadow').checked = Boolean(s.shadow);
      $('text-align').querySelectorAll('button').forEach((b) => b.classList.toggle('on', b.dataset.value === s.align));
    }

    return { insertText, renderTextEditor };
  }

  root.CutlineTextEditor = { create };
})(window);
