/* global CutlineCaptions, cutline */
// Right-hand sidebar: the Captions panel and the Media panel (your files and Pexels stock).
(function (root) {
  const C = CutlineCaptions;
  const $ = (id) => document.getElementById(id);

  // Style a caption line element the way the burned-in ASS version looks. `style` is a preset
  // id, caption settings or a resolved style (see CutlineCaptions.styleOf).
  function styleLine(el, style, fontPx, language) {
    const p = C.styleOf(style);
    el.style.fontFamily = C.fontStack(language);
    // Lines are as far apart as libass puts them: the script font's full height (C.LINE_HEIGHT).
    // Tall Malayalam, Telugu and Devanagari letters need more room than English.
    const lh = C.LINE_HEIGHT[C.fontFor(language)] ?? C.LINE_HEIGHT[C.LATIN_FONT];
    el.style.lineHeight = String(lh);
    // The export draws Regular or Bold only (ASS Bold when the weight is 700 or more).
    el.style.fontWeight = p.weight >= 700 ? '700' : '400';
    el.style.fontSize = `${fontPx}px`;
    el.style.color = p.text;
    // ASS outlines grow outward from the glyph; a stroke painted under the fill matches that
    // when it is twice as wide.
    el.style.webkitTextStroke = p.outlineW && !p.box ? `${(p.outlineW * fontPx * 2).toFixed(1)}px ${p.outline}` : '';
    el.style.textShadow = p.shadow && !p.box ? `0 ${(p.shadow * fontPx).toFixed(1)}px ${(p.shadow * fontPx * 1.5).toFixed(1)}px rgba(0,0,0,0.6)` : '';
    el.style.background = p.box ?? '';
    // libass draws the box 0.28 em around each line's full font height (ascent to descent of the
    // style's font, see C.LINE_HEIGHT); the line box here is 1.25 em, so pad the rest.
    el.style.padding = p.box ? '0.28em' : '0';
    el.style.borderRadius = p.box ? '0.18em' : '0';
    el.style.boxDecorationBreak = 'clone';
    el.style.webkitBoxDecorationBreak = 'clone';
    return p;
  }

  // The words of a caption, with the spoken one highlighted. Two-line styles break at the same
  // word as the export (CutlineCaptions.breakAt). For karaoke, `fill` maps a word index to how
  // much of it is filled (0 to 1).
  function fillLine(el, words, style, current, fill = null, language = null) {
    const p = C.styleOf(style);
    el.replaceChildren();
    const at = C.breakAt(words.map((w) => w.text), p);
    words.forEach((w, k) => {
      if (k === at) el.appendChild(document.createElement('br'));
      else if (k) el.appendChild(document.createTextNode(' '));
      const span = document.createElement('span');
      span.className = 'cw';
      const shown = C.displayText(w.text, p);
      span.textContent = shown;
      // English words in their own colour (as the export draws them): runs inside the word.
      const spoken = p.mode === 'highlight' && w.i === current && p.hi !== p.text;
      if (p.latin && language && p.animation !== 'karaoke' && !spoken) {
        const runs = C.latinRuns(shown, language);
        if (runs.some((r) => r.latin)) {
          span.replaceChildren(...runs.map((r) => {
            if (!r.latin) return document.createTextNode(r.text);
            const s = document.createElement('span');
            s.className = 'cw-latin';
            s.style.color = p.latin;
            s.textContent = r.text;
            return s;
          }));
        }
      }
      if (p.animation === 'karaoke') {
        const f = Math.round(Math.min(1, Math.max(0, fill?.(w.i) ?? 0)) * 1000) / 10;
        // A copy of the word in the highlight colour lies exactly on top of it, cut off at the
        // filled share. Each copy keeps its own outline under an opaque fill, as libass draws it.
        if (f > 0) {
          const over = document.createElement('span');
          over.className = 'cw-fill';
          over.textContent = span.textContent;
          over.style.color = p.hi;
          over.style.clipPath = `inset(-0.5em ${(100 - f).toFixed(1)}% -0.5em -0.5em)`;
          span.style.position = 'relative';
          span.appendChild(over);
        }
      } else if (p.mode === 'highlight' && w.i === current) span.style.color = p.hi;
      el.appendChild(span);
    });
  }

  function fmtDuration(s) {
    if (!Number.isFinite(s)) return '';
    const m = Math.floor(s / 60);
    return `${m}:${String(Math.floor(s % 60)).padStart(2, '0')}`;
  }

  class Panels {
    constructor({ onCaptionsChange, onInsertMedia, onError, onToast }) {
      this.onCaptionsChange = onCaptionsChange;
      this.onInsertMedia = onInsertMedia;
      this.onError = onError;
      this.onToast = onToast;
      this.captions = C.settingsOf(null);
      this.language = 'en';
      this.library = []; // B-roll media the user added: { path, url, name, kind, duration, thumb }
      this.stockKind = 'video';
      this.orientation = null;

      this.sidebar = document.querySelector('.sidebar');
      this.railButtons = [...document.querySelectorAll('.rail-btn')];
      this.railButtons.forEach((b) => b.addEventListener('click', () => this.toggle(b.dataset.panel)));

      this.saved = [];
      this.buildCaptionsPanel();
      this.buildStyleControls();
      this.renderCaptionsPanel();
      this.loadSavedStyles();
      this.buildMediaPanel();
      // The side panel starts closed so the video has the room; the rail opens a panel, and
      // selecting something on the timeline opens Properties.
      this.toggle(null);
    }

    // The panel last shown, so the side panel reopens where you were.
    static lastPanel() {
      try { return localStorage.getItem('cutline.lastPanel') || 'project'; } catch { return 'project'; }
    }

    toggle(name) {
      const active = this.railButtons.find((b) => b.classList.contains('on'))?.dataset.panel;
      const show = active === name ? null : name;
      if (show) { try { localStorage.setItem('cutline.lastPanel', show); } catch {} }
      this.railButtons.forEach((b) => b.classList.toggle('on', b.dataset.panel === show));
      for (const b of this.railButtons) $(`panel-${b.dataset.panel}`).hidden = show !== b.dataset.panel;
      this.sidebar.classList.toggle('collapsed', !show);
      if (show === 'media') this.refreshStockSetup();
      window.dispatchEvent(new Event('resize'));
    }

    // ---------- captions ----------

    buildCaptionsPanel() {
      $('cap-enabled').addEventListener('change', (e) => this.setCaption({ enabled: e.target.checked }));
      const segmented = (id, options, key) => {
        const el = $(id);
        for (const [value, label] of Object.entries(options)) {
          const b = document.createElement('button');
          b.textContent = label;
          b.dataset.value = value;
          b.addEventListener('click', () => this.setCaption({ [key]: value, enabled: true }));
          el.appendChild(b);
        }
      };
      segmented('cap-position', C.POSITIONS, 'position');
      segmented('cap-size', { small: 'S', medium: 'M', large: 'L' }, 'size');
      const list = $('cap-presets');
      for (const id of Object.keys(C.PRESETS)) {
        const b = document.createElement('button');
        b.className = 'preset';
        b.dataset.preset = id;
        const sample = document.createElement('div');
        sample.className = 'preset-sample';
        const line = document.createElement('span');
        line.className = 'caption-line';
        sample.appendChild(line);
        const name = document.createElement('div');
        name.className = 'preset-name';
        name.textContent = C.PRESETS[id].label;
        b.append(sample, name);
        b.addEventListener('click', () => this.setCaption({ preset: id, enabled: true }));
        list.appendChild(b);
      }
    }

    // The controls under the preset list that change the chosen preset's look.
    buildStyleControls() {
      const seg = (id, options, apply) => {
        const el = $(id);
        for (const [value, label] of Object.entries(options)) {
          const b = document.createElement('button');
          b.type = 'button';
          b.textContent = label;
          b.dataset.value = value;
          b.addEventListener('click', () => apply(value));
          el.appendChild(b);
        }
      };
      seg('cap-weight', { 400: 'Regular', 800: 'Bold' }, (v) => this.setStyle({ weight: Number(v) }));
      seg('cap-case', { asis: 'As spoken', upper: 'UPPER' }, (v) => this.setStyle({ upper: v === 'upper' }));
      seg('cap-outline-w', { none: 'None', thin: 'Thin', medium: 'Medium', thick: 'Thick' }, (v) => this.setStyle({ outlineW: C.OUTLINES[v] }));
      seg('cap-lines', { 1: 'One line', 2: 'Two lines' }, (v) => this.setStyle({ lines: Number(v) }));
      seg('cap-animation', C.ANIMATIONS, (v) => {
        // Karaoke shows nothing when the highlight is the text colour (Subtitle, One word):
        // pick a highlight that stands out.
        const p = C.styleOf(this.captions);
        const change = { animation: v };
        if (v === 'karaoke' && p.hi.toUpperCase() === p.text.toUpperCase()) change.hi = p.text.toUpperCase() === '#FFD84D' ? '#FFFFFF' : '#FFD84D';
        this.setStyle(change);
      });
      for (const [id, key] of [['cap-text', 'text'], ['cap-hi', 'hi'], ['cap-outline', 'outline']]) {
        $(id).addEventListener('input', (e) => this.setStyle({ [key]: e.target.value }, false));
        $(id).addEventListener('change', (e) => this.setStyle({ [key]: e.target.value }));
      }
      $('cap-box-on').addEventListener('change', (e) => this.setStyle({ box: e.target.checked ? $('cap-box').value : null }));
      $('cap-box').addEventListener('change', (e) => { if ($('cap-box-on').checked) this.setStyle({ box: e.target.value }); });
      $('cap-latin-on').addEventListener('change', (e) => this.setStyle({ latin: e.target.checked ? $('cap-latin').value : null }));
      $('cap-latin').addEventListener('change', (e) => { if ($('cap-latin-on').checked) this.setStyle({ latin: e.target.value }); });
      $('cap-words').addEventListener('input', (e) => { $('cap-words-out').textContent = e.target.value; });
      $('cap-words').addEventListener('change', (e) => this.setStyle({ maxWords: Number(e.target.value) }));
      $('cap-reset-style').addEventListener('click', () => this.setCaption({ style: null }));
      $('cap-save-style').addEventListener('click', () => this.saveStyle());
      $('cap-save-name').addEventListener('keydown', (e) => { e.stopPropagation(); if (e.key === 'Enter') this.saveStyle(); });
    }

    // Change part of the current style. A change the same as the preset's own value is dropped,
    // so the preset stays "not custom" when everything is back to its defaults.
    setStyle(change, final = true) {
      const base = C.styleOf(this.captions.preset);
      const style = { ...(this.captions.style ?? {}) };
      for (const [k, v] of Object.entries(change)) {
        const same = k === 'box' ? (v === null ? base.box === null : base.box === C.hexToRgba(v, 0.72))
          : k === 'latin' ? v === null
            : String(base[k]).toUpperCase() === String(v).toUpperCase();
        if (same) delete style[k]; else style[k] = v;
      }
      if (!final) {
        this.captions = C.settingsOf({ ...this.captions, style });
        this.onCaptionsChange(this.captions, { final: false });
        return;
      }
      this.setCaption({ style, enabled: true });
    }

    // Saved styles are kept for this Mac (not in the project), so every project can use them.
    async loadSavedStyles() {
      try { this.saved = await cutline.captionStyles(); } catch { this.saved = []; }
      this.renderCaptionsPanel();
    }

    async saveStyle() {
      const name = $('cap-save-name').value;
      if (!name?.trim()) { $('cap-save-name').focus(); this.onToast('Type a name for the style first.'); return; }
      try {
        this.saved = await cutline.saveCaptionStyle({ name: name.trim(), preset: this.captions.preset, style: this.captions.style ?? {}, size: this.captions.size, position: this.captions.position === 'custom' ? 'bottom' : this.captions.position });
        $('cap-save-name').value = '';
        this.onToast(`Saved “${name.trim()}”. It is listed under Saved styles in every project.`);
        this.renderCaptionsPanel();
      } catch (err) { this.onError(err); }
    }

    async deleteStyle(name) {
      if (!window.confirm(`Delete the saved caption style “${name}”? Projects that use it keep their look.`)) return;
      try { this.saved = await cutline.deleteCaptionStyle(name); this.renderCaptionsPanel(); } catch (err) { this.onError(err); }
    }

    renderSavedStyles() {
      const list = $('cap-saved');
      list.replaceChildren();
      $('cap-saved-head').hidden = !this.saved?.length;
      for (const st of this.saved ?? []) {
        const row = document.createElement('div');
        row.className = 'saved-style';
        const use = document.createElement('button');
        use.type = 'button';
        use.className = 'preset';
        use.dataset.saved = st.name;
        const sample = document.createElement('div');
        sample.className = 'preset-sample';
        const line = document.createElement('span');
        line.className = 'caption-line';
        sample.appendChild(line);
        const settings = C.settingsOf({ preset: st.preset, style: st.style });
        styleLine(line, settings, 19, this.language);
        fillLine(line, [{ text: this.language === 'te' ? 'ఒక' : 'one', i: 0 }, { text: 'word', i: 1 }], settings, 1, () => 0.5);
        const name = document.createElement('div');
        name.className = 'preset-name';
        name.textContent = st.name;
        use.append(sample, name);
        const sameLook = st.preset === this.captions.preset && JSON.stringify(C.settingsOf(st).style ?? {}) === JSON.stringify(this.captions.style ?? {});
        use.classList.toggle('on', sameLook);
        use.addEventListener('click', () => { this.savedName = st.name; this.setCaption({ preset: st.preset, style: st.style ?? null, size: st.size ?? this.captions.size, enabled: true }); });
        const del = document.createElement('button');
        del.type = 'button';
        del.className = 'icon-btn saved-del';
        del.title = `Delete “${st.name}”`;
        del.textContent = '×';
        del.addEventListener('click', () => this.deleteStyle(st.name));
        row.append(use, del);
        list.appendChild(row);
      }
    }

    setLanguage(language) {
      this.language = language || 'en';
      this.renderCaptionsPanel();
    }

    setCaptions(settings) {
      this.captions = C.settingsOf(settings);
      this.renderCaptionsPanel();
    }

    setCaption(change) {
      // Picking a built-in preset starts from its own look.
      if (change.preset && !('style' in change)) change = { ...change, style: null };
      this.captions = C.settingsOf({ ...this.captions, ...change });
      this.renderCaptionsPanel();
      this.onCaptionsChange(this.captions);
    }

    renderCaptionsPanel() {
      const s = this.captions;
      $('cap-enabled').checked = s.enabled;
      $('cap-position').querySelectorAll('button').forEach((b) => b.classList.toggle('on', b.dataset.value === s.position));
      $('cap-custom-note').hidden = s.position !== 'custom';
      $('cap-size').querySelectorAll('button').forEach((b) => b.classList.toggle('on', b.dataset.value === s.size));
      const sampleWords = this.language === 'te'
        ? [{ text: 'ఒక', i: 0 }, { text: 'word', i: 1 }, { text: 'at a time', i: 2 }]
        : [{ text: 'one word', i: 0 }, { text: 'at a', i: 1 }, { text: 'time', i: 2 }];
      const custom = C.isCustom(s);
      document.querySelectorAll('#cap-presets .preset').forEach((b) => {
        const id = b.dataset.preset;
        b.classList.toggle('on', id === s.preset && !custom);
        const line = b.querySelector('.caption-line');
        const p = styleLine(line, id, 19, this.language);
        const words = p.maxWords === 1 ? [sampleWords[2]] : sampleWords;
        fillLine(line, words, id, 2, null, this.language);
      });
      // The style controls show the current look.
      const p = C.styleOf(s);
      const mark = (id, value) => $(id).querySelectorAll('button').forEach((b) => b.classList.toggle('on', b.dataset.value === String(value)));
      mark('cap-weight', p.weight >= 700 ? 800 : 400);
      mark('cap-case', p.upper ? 'upper' : 'asis');
      const outline = Object.entries(C.OUTLINES).reduce((best, [k, v]) => (Math.abs(v - p.outlineW) < Math.abs(C.OUTLINES[best] - p.outlineW) ? k : best), 'none');
      mark('cap-outline-w', outline);
      mark('cap-lines', p.lines);
      mark('cap-animation', p.animation);
      $('cap-text').value = p.text.toLowerCase();
      $('cap-hi').value = p.hi.toLowerCase();
      $('cap-outline').value = p.outline.toLowerCase();
      $('cap-box-on').checked = Boolean(p.box);
      if (p.box) {
        const m = /rgba\((\d+),\s*(\d+),\s*(\d+)/.exec(p.box);
        if (m) $('cap-box').value = `#${[m[1], m[2], m[3]].map((n) => Number(n).toString(16).padStart(2, '0')).join('')}`;
      }
      $('cap-box').disabled = !p.box;
      $('cap-latin-on').checked = Boolean(p.latin);
      if (p.latin) $('cap-latin').value = p.latin.toLowerCase();
      $('cap-latin').disabled = !p.latin;
      $('cap-words').value = p.maxWords;
      $('cap-words-out').textContent = p.maxWords;
      $('cap-style-name').textContent = custom ? `${C.PRESETS[s.preset].label}, changed` : C.PRESETS[s.preset].label;
      $('cap-reset-style').disabled = !custom;
      this.renderSavedStyles();
    }

    // ---------- media ----------

    buildMediaPanel() {
      $('media-tabs').querySelectorAll('button').forEach((b) => b.addEventListener('click', () => {
        $('media-tabs').querySelectorAll('button').forEach((x) => x.classList.toggle('on', x === b));
        $('media-mine').hidden = b.dataset.tab !== 'mine';
        $('media-stock').hidden = b.dataset.tab !== 'stock';
        $('media-text').hidden = b.dataset.tab !== 'text';
        if (b.dataset.tab === 'stock') this.refreshStockSetup();
      }));
      $('btn-add-broll').addEventListener('click', async () => {
        try {
          const added = await cutline.openBroll();
          for (const m of added) this.addToLibrary(m);
          if (added.length) this.onToast(`Added ${added.length} item${added.length === 1 ? '' : 's'}. Click one to place it at the playhead.`);
        } catch (err) { this.onError(err); }
      });
      $('btn-add-audio').addEventListener('click', async () => {
        try {
          const added = await cutline.openAudio();
          for (const m of added) { this.addToLibrary(m); this.onInsertMedia(m); }
        } catch (err) { this.onError(err); }
      });
      $('pexels-link').addEventListener('click', (e) => { e.preventDefault(); cutline.openExternal('https://www.pexels.com/api/'); });
      $('pexels-credit').addEventListener('click', (e) => { e.preventDefault(); cutline.openExternal('https://www.pexels.com/'); });
      $('pexels-change').addEventListener('click', (e) => {
        e.preventDefault();
        document.getElementById('btn-keys').click();
      });
      $('btn-save-key').addEventListener('click', async () => {
        const btn = $('btn-save-key');
        btn.disabled = true;
        btn.textContent = 'Checking…';
        try {
          await cutline.setPexelsKey($('pexels-key').value);
          $('pexels-key').value = '';
          this.onToast('Pexels key saved.');
          await this.refreshStockSetup();
        } catch (err) {
          this.onError(err);
        } finally {
          btn.disabled = false;
          btn.textContent = 'Save key';
        }
      });
      $('stock-form').addEventListener('submit', (e) => { e.preventDefault(); this.searchStock(); });
      $('stock-kind').querySelectorAll('button').forEach((b) => b.addEventListener('click', () => {
        $('stock-kind').querySelectorAll('button').forEach((x) => x.classList.toggle('on', x === b));
        this.stockKind = b.dataset.kind;
        if ($('stock-query').value.trim()) this.searchStock();
      }));
      cutline.onStockProgress(({ id, progress }) => {
        const el = $('stock-grid').querySelector(`[data-id="${CSS.escape(id)}"]`);
        el?.style.setProperty('--progress', `${Math.round(progress * 100)}%`);
      });
    }

    async refreshStockSetup() {
      try {
        const { hasPexelsKey } = await cutline.settings();
        $('stock-setup').hidden = hasPexelsKey;
        $('stock-search').hidden = !hasPexelsKey;
      } catch (err) { this.onError(err); }
    }

    setOrientation(width, height) {
      this.orientation = width && height ? (height > width ? 'portrait' : 'landscape') : null;
    }

    setLibrary(items) {
      this.library = [];
      $('mine-grid').replaceChildren();
      items.forEach((m) => this.addToLibrary(m));
    }

    addToLibrary(media) {
      if (this.library.some((m) => m.path === media.path)) return;
      this.library.push(media);
      $('mine-grid').appendChild(this.mediaTile(media, () => this.onInsertMedia(media)));
    }

    mediaTile(media, onClick) {
      const b = document.createElement('button');
      b.className = 'media-item';
      b.title = media.name ?? '';
      if (media.thumb) {
        const img = document.createElement('img');
        img.src = media.thumb;
        img.alt = '';
        b.appendChild(img);
      }
      if (media.name) {
        const name = document.createElement('span');
        name.className = 'name';
        name.textContent = media.name;
        b.appendChild(name);
      }
      const badge = document.createElement('span');
      badge.className = 'badge';
      badge.textContent = media.kind === 'image' ? 'Photo' : media.kind === 'audio' ? `♪ ${fmtDuration(media.duration)}` : fmtDuration(media.duration);
      if (media.kind === 'audio' && !media.thumb) b.classList.add('audio-tile');
      b.appendChild(badge);
      b.addEventListener('click', onClick);
      return b;
    }

    async searchStock() {
      const query = $('stock-query').value.trim();
      const grid = $('stock-grid');
      if (!query) return;
      grid.replaceChildren();
      const note = document.createElement('p');
      note.className = 'panel-hint';
      note.textContent = 'Searching…';
      grid.appendChild(note);
      try {
        const results = await cutline.searchStock(query, this.stockKind, this.orientation);
        grid.replaceChildren();
        if (!results.length) {
          note.textContent = 'Nothing found. Try another word.';
          grid.appendChild(note);
          return;
        }
        for (const item of results) {
          const tile = this.mediaTile({ ...item, name: item.author ? `by ${item.author}` : '' }, async () => {
            if (tile.classList.contains('loading')) return;
            tile.classList.add('loading');
            try {
              const media = await cutline.downloadStock(item);
              media.name = `Pexels · ${item.author ?? item.id}`;
              this.addToLibrary(media);
              this.onInsertMedia(media);
            } catch (err) {
              this.onError(err);
            } finally {
              tile.classList.remove('loading');
            }
          });
          tile.dataset.id = item.id;
          grid.appendChild(tile);
        }
      } catch (err) {
        grid.replaceChildren();
        this.onError(err);
      }
    }
  }

  root.CutlinePanels = { Panels, styleLine, fillLine };
})(window);
