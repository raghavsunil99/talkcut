/* global CutlineCaptions, cutline */
// Right-hand sidebar: the Captions panel and the Media panel (your files and Pexels stock).
(function (root) {
  const C = CutlineCaptions;
  const $ = (id) => document.getElementById(id);

  // Style a caption line element the way the burned-in ASS version looks.
  function styleLine(el, presetId, fontPx, language) {
    const p = C.PRESETS[presetId] ?? C.PRESETS.highlight;
    el.style.fontFamily = `"${C.fontFor(language)}", "${C.LATIN_FONT}", sans-serif`;
    el.style.fontWeight = String(p.weight);
    el.style.fontSize = `${fontPx}px`;
    el.style.color = p.text;
    // ASS outlines grow outward from the glyph; a stroke painted under the fill matches that
    // when it is twice as wide.
    el.style.webkitTextStroke = p.outlineW ? `${(p.outlineW * fontPx * 2).toFixed(1)}px ${p.outline}` : '';
    el.style.textShadow = p.shadow ? `0 ${(p.shadow * fontPx).toFixed(1)}px ${(p.shadow * fontPx * 1.5).toFixed(1)}px rgba(0,0,0,0.6)` : '';
    el.style.background = p.box ?? '';
    el.style.padding = p.box ? '0.18em 0.45em' : '0';
    el.style.borderRadius = p.box ? '0.18em' : '0';
    el.style.boxDecorationBreak = 'clone';
    el.style.webkitBoxDecorationBreak = 'clone';
    return p;
  }

  function fillLine(el, words, presetId, current) {
    const p = C.PRESETS[presetId] ?? C.PRESETS.highlight;
    el.replaceChildren();
    words.forEach((w, k) => {
      if (k) el.appendChild(document.createTextNode(' '));
      const span = document.createElement('span');
      span.className = 'cw';
      span.textContent = C.displayText(w.text, p);
      if (p.mode === 'highlight' && w.i === current) span.style.color = p.hi;
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

      this.buildCaptionsPanel();
      this.buildMediaPanel();
      this.toggle('captions');
    }

    toggle(name) {
      const active = this.railButtons.find((b) => b.classList.contains('on'))?.dataset.panel;
      const show = active === name ? null : name;
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
      this.renderCaptionsPanel();
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
      document.querySelectorAll('.preset').forEach((b) => {
        const id = b.dataset.preset;
        b.classList.toggle('on', id === s.preset);
        const line = b.querySelector('.caption-line');
        const p = styleLine(line, id, 19, this.language);
        const words = p.maxWords === 1 ? [sampleWords[2]] : sampleWords;
        fillLine(line, words, id, 2);
      });
    }

    // ---------- media ----------

    buildMediaPanel() {
      $('media-tabs').querySelectorAll('button').forEach((b) => b.addEventListener('click', () => {
        $('media-tabs').querySelectorAll('button').forEach((x) => x.classList.toggle('on', x === b));
        $('media-mine').hidden = b.dataset.tab !== 'mine';
        $('media-stock').hidden = b.dataset.tab !== 'stock';
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
