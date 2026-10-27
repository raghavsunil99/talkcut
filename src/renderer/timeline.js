/* global CutlineEdits */
// Timeline panel: ruler, overlay tracks, the main clip (filmstrip), word and pause blocks,
// the voice waveform, audio tracks and the playhead, all laid out on the edited timeline
// (cuts removed), like the composition it will export.
(function (root) {
  const E = CutlineEdits;

  const BASE_PPS = 120; // pixels per second at 100% zoom
  const MIN_PPS = 8;
  const MAX_PPS = 1200;
  const TICK_STEPS = [0.25, 0.5, 1, 2, 5, 10, 15, 30, 60, 120, 300, 600];
  const H = { ruler: 26, overlay: 40, film: 66, words: 32, wave: 52, audio: 42, gap: 6 };
  // Track height from Settings (html[data-thumbs]): media rows grow, words and ruler stay readable.
  const SCALE = { small: 0.75, medium: 1, large: 1.35 };

  function fmtTick(t, step) {
    const m = Math.floor(t / 60);
    const s = t - m * 60;
    const sec = step < 1 ? s.toFixed(step < 0.5 ? 2 : 1).padStart(step < 0.5 ? 5 : 4, '0') : String(Math.round(s)).padStart(2, '0');
    return `${m}:${sec}`;
  }

  function cssVar(name) {
    return getComputedStyle(document.documentElement).getPropertyValue(name).trim();
  }

  class Timeline {
    constructor(rootEl, handlers) {
      Object.assign(this, handlers); // onSeek, onSelectWord, onSelectGap, onSelectItem, onChangeItem,
      // onBlade, onSelectRange, onSelectSegment, onAddTrack, onTrackChange, onRemoveTrack
      this.root = rootEl;
      this.tool = 'select';
      this.splits = []; // blade splits, source seconds
      this.rangeSel = null; // [start, end] source seconds
      this.rangeDraft = null; // [start, end] edited seconds while dragging
      this.rangeCuts = [];
      this.tracks = []; // placed tracks (items carry startE)
      this.itemSel = null;
      this.pps = BASE_PPS;
      this.words = [];
      this.duration = 0;
      this.kept = [];
      this.cuts = [];
      this.deleted = new Set();
      this.cutGaps = new Set();
      this.selection = null; // [a, b] word indices
      this.gapSel = null;
      this.peaks = null;
      this.perSecond = 50;
      this.frames = [];
      this.images = [];
      this.time = 0; // source seconds
      this.rows = this.computeRows();

      this.body = rootEl.querySelector('.tl-body');
      this.heads = rootEl.querySelector('.tl-heads');
      this.scroll = rootEl.querySelector('.tl-scroll');
      this.content = rootEl.querySelector('.tl-content');
      this.canvas = rootEl.querySelector('.tl-canvas');
      this.chips = rootEl.querySelector('.tl-chips');
      this.lanes = rootEl.querySelector('.tl-lanes');
      this.playhead = rootEl.querySelector('.tl-playhead');
      this.scrub = rootEl.querySelector('.tl-scrub');
      this.scrubFill = rootEl.querySelector('.tl-scrub-fill');
      this.zoomLabel = rootEl.querySelector('.tl-zoom-label');
      this.statusEl = rootEl.querySelector('.tl-status');
      this.ctx = this.canvas.getContext('2d');
      // Caption blocks, one per caption as it shows on the video.
      this.caps = document.createElement('div');
      this.caps.className = 'tl-caps';
      this.content.appendChild(this.caps);
      this.caps.addEventListener('mousedown', (e) => {
        const el = e.target.closest('.tl-cap');
        if (!el || e.button !== 0) return;
        e.stopPropagation();
        this.onSelectCaption?.(this.captionSpans[Number(el.dataset.span)]);
      });
      this.caps.addEventListener('dblclick', (e) => {
        const el = e.target.closest('.tl-cap');
        if (el) this.onEditCaption?.(this.captionSpans[Number(el.dataset.span)]);
      });

      rootEl.querySelector('.tl-zoom-in').addEventListener('click', () => this.zoom(1.25));
      rootEl.querySelector('.tl-zoom-out').addEventListener('click', () => this.zoom(1 / 1.25));
      rootEl.querySelector('.tl-zoom-fit').addEventListener('click', () => this.fit());
      this.scroll.addEventListener('scroll', () => this.draw());
      this.scroll.addEventListener('wheel', (e) => {
        if (!(e.ctrlKey || e.metaKey)) return;
        e.preventDefault();
        const anchor = e.clientX - this.scroll.getBoundingClientRect().left;
        this.zoom(Math.exp(-e.deltaY * 0.01), anchor);
      }, { passive: false });
      new ResizeObserver(() => this.layout()).observe(this.scroll);

      this.content.addEventListener('mousedown', (e) => this.pointerDown(e));
      this.scrub.addEventListener('mousedown', (e) => {
        if (!this.duration) return;
        const r = this.scrub.getBoundingClientRect();
        const at = (x) => this.onSeek(E.toSource(this.kept, Math.min(1, Math.max(0, (x - r.left) / r.width)) * this.editedDuration));
        at(e.clientX);
        this.drag((ev) => at(ev.clientX));
      });
    }

    // Track the mouse until release.
    drag(move, up) {
      const onMove = (ev) => move(ev);
      const onUp = (ev) => {
        window.removeEventListener('mousemove', onMove);
        window.removeEventListener('mouseup', onUp);
        up?.(ev);
      };
      window.addEventListener('mousemove', onMove);
      window.addEventListener('mouseup', onUp);
    }

    get editedDuration() {
      return E.totalLength(this.kept);
    }

    // ---------- rows ----------

    // Top to bottom: ruler, overlay tracks (the last one is drawn on top, so it is shown
    // highest), the main clip, words, waveform, then audio tracks.
    computeRows() {
      let y = 0;
      const take = (h) => { const r = [y, y + h]; y += h + H.gap; return r; };
      const rows = { ruler: take(H.ruler), tracks: [] };
      const k = SCALE[document.documentElement.dataset.thumbs] ?? 1;
      const size = (h) => Math.round(h * k);
      for (const t of [...this.tracks].filter((t) => t.type === 'overlay').reverse()) rows.tracks.push({ id: t.id, y: take(size(H.overlay)) });
      if (this.captionSpans?.length) rows.caps = take(30);
      rows.film = take(size(H.film));
      rows.words = take(H.words);
      rows.wave = take(size(H.wave));
      for (const t of this.tracks.filter((t) => t.type === 'audio')) rows.tracks.push({ id: t.id, y: take(size(H.audio)) });
      rows.height = y + 6;
      return rows;
    }

    trackRow(id) {
      return this.rows.tracks.find((r) => r.id === id)?.y;
    }

    // Which track lane a y position (relative to the content) falls in.
    trackAt(y) {
      return this.rows.tracks.find((r) => y >= r.y[0] - 2 && y <= r.y[1] + 2)?.id ?? null;
    }

    // ---------- data ----------

    setMedia({ words, duration, name }) {
      this.words = words;
      if (name !== undefined) this.clipName = name;
      this.duration = duration;
      this.peaks = null;
      this.frames = [];
      this.images = [];
      this.time = 0;
      this.setEdits({ deleted: new Set(), cutGaps: new Set(), selection: null, gapSel: null });
      // Open zoomed in so a typical word block is wide enough to read; Fit shows it all.
      const lengths = words.map((w) => w.end - w.start).filter((d) => d > 0.05).sort((a, b) => a - b);
      const typical = lengths.length ? lengths[Math.floor(lengths.length / 2)] : 0.4;
      const width = this.scroll.clientWidth || 1200;
      this.pps = Math.min(600, Math.max(BASE_PPS, width / 12, 64 / typical));
      this.layout();
      this.scroll.scrollLeft = 0;
    }

    setAssets({ peaks, perSecond, frames }) {
      this.peaks = peaks;
      this.perSecond = perSecond;
      this.frames = frames ?? [];
      this.images = this.frames.map((f) => {
        const img = new Image();
        img.onload = () => this.draw();
        img.src = f.src;
        return img;
      });
      this.draw();
    }

    setStatus(text) {
      this.statusEl.textContent = text;
      this.statusEl.hidden = !text;
    }

    setEdits({ words, deleted, cutGaps, selection, gapSel, rangeCuts }) {
      if (rangeCuts) this.rangeCuts = rangeCuts;
      if (words) this.words = words;
      this.deleted = deleted;
      this.cutGaps = cutGaps;
      this.selection = selection;
      this.gapSel = gapSel;
      this.cuts = E.computeCuts(this.words, deleted, this.duration, cutGaps, this.rangeCuts);
      this.kept = E.keptRanges(this.cuts, this.duration);
      this.layout();
    }

    // Tracks already placed on the edited timeline (see CutlineTracks.placed).
    setTracks(tracks, selectedItem) {
      this.tracks = tracks;
      this.itemSel = selectedItem;
      this.layout();
    }

    // spans: [{ start, end (source seconds), text, words }]; empty when captions are off.
    setCaptions(spans, selectedWords) {
      const had = Boolean(this.captionSpans?.length);
      this.captionSpans = spans ?? [];
      this.captionSel = selectedWords;
      if (had !== Boolean(this.captionSpans.length)) this.layout();
      else this.renderCaps();
    }

    renderCaps() {
      const frag = document.createDocumentFragment();
      const y = this.rows.caps;
      this.caps.hidden = !y;
      if (y) {
        const ed = (t) => E.toEdited(this.kept, t);
        const sel = this.captionSel;
        this.captionSpans.forEach((span, n) => {
          const x0 = ed(span.start) * this.pps;
          const x1 = ed(span.end) * this.pps;
          if (x1 - x0 < 1) return;
          const el = document.createElement('div');
          el.className = 'tl-cap';
          if (sel && span.words[0] <= sel[1] && span.words[span.words.length - 1] >= sel[0]) el.classList.add('sel');
          el.dataset.span = n;
          Object.assign(el.style, { left: `${x0}px`, width: `${Math.max(3, x1 - x0 - 2)}px`, top: `${y[0]}px`, height: `${y[1] - y[0]}px` });
          if (x1 - x0 > 16) el.textContent = span.text;
          el.title = `${span.text} — click to select it, double-click to correct the words`;
          frag.appendChild(el);
        });
      }
      this.caps.replaceChildren(frag);
    }

    setMarks({ splits, rangeSel }) {
      this.splits = splits ?? [];
      this.rangeSel = rangeSel ?? null;
      this.draw();
    }

    setTool(tool) {
      this.tool = tool;
      this.content.dataset.tool = tool;
    }

    setTime(t, playing) {
      this.time = t;
      const e = E.toEdited(this.kept, t);
      const x = e * this.pps;
      this.playhead.style.transform = `translateX(${x}px)`;
      this.scrubFill.style.width = this.editedDuration ? `${(e / this.editedDuration) * 100}%` : '0';
      if (playing) {
        const left = this.scroll.scrollLeft;
        const width = this.scroll.clientWidth;
        if (x > left + width - 60 || x < left) this.scroll.scrollLeft = Math.max(0, x - 80);
      }
    }

    // ---------- zoom ----------

    zoom(factor, anchorX = this.scroll.clientWidth / 2) {
      const anchorT = (this.scroll.scrollLeft + anchorX) / this.pps;
      this.pps = Math.min(MAX_PPS, Math.max(MIN_PPS, this.pps * factor));
      this.layout();
      this.scroll.scrollLeft = anchorT * this.pps - anchorX;
    }

    fit() {
      const width = this.scroll.clientWidth - 40;
      const d = this.editedDuration || this.duration;
      if (width > 0 && d > 0) this.pps = Math.min(BASE_PPS, Math.max(MIN_PPS, width / d));
      this.layout();
      this.scroll.scrollLeft = 0;
    }

    // ---------- layout ----------

    layout() {
      this.rows = this.computeRows();
      const width = Math.max(this.scroll.clientWidth, Math.ceil(this.editedDuration * this.pps) + 40);
      this.content.style.width = `${width}px`;
      this.content.style.height = `${this.rows.height}px`;
      this.chips.style.top = `${this.rows.words[0]}px`;
      this.chips.style.height = `${this.rows.words[1] - this.rows.words[0]}px`;
      this.zoomLabel.textContent = `${Math.round((this.pps / BASE_PPS) * 100)}%`;
      this.renderHeads();
      this.renderChips();
      this.renderLanes();
      this.renderCaps();
      this.setTime(this.time, false);
      this.draw();
    }

    // Left column: a label per row, with show/hide, mute and remove for added tracks.
    renderHeads() {
      const frag = document.createDocumentFragment();
      const row = (y, html, cls = '') => {
        const el = document.createElement('div');
        el.className = `tl-head ${cls}`;
        el.style.top = `${y[0]}px`;
        el.style.height = `${y[1] - y[0]}px`;
        if (html) el.append(...html);
        frag.appendChild(el);
        return el;
      };
      const text = (t, cls = 'tl-head-name') => {
        const s = document.createElement('span');
        s.className = cls;
        s.textContent = t;
        return s;
      };
      const button = (label, title, onClick, on = false) => {
        const b = document.createElement('button');
        b.type = 'button';
        b.className = `tl-head-btn${on ? ' on' : ''}`;
        b.textContent = label;
        b.title = title;
        b.addEventListener('click', (e) => { e.stopPropagation(); onClick(); });
        return b;
      };
      const add = button('+ Track', 'Add an overlay or audio track', () => this.toggleAddMenu());
      add.classList.add('add');
      row(this.rows.ruler, [add], 'ruler');
      for (const r of this.rows.tracks) {
        const t = this.tracks.find((x) => x.id === r.id);
        if (!t) continue;
        const parts = [text(t.name)];
        if (t.type === 'overlay') parts.push(button(t.hidden ? '◌' : '◉', t.hidden ? 'Show track' : 'Hide track', () => this.onTrackChange(t.id, { hidden: !t.hidden }), t.hidden));
        parts.push(button(t.muted ? '🔇' : '🔈', t.muted ? 'Unmute track' : 'Mute track', () => this.onTrackChange(t.id, { muted: !t.muted }), t.muted));
        parts.push(button('×', 'Remove track', () => this.onRemoveTrack(t.id)));
        // Prefixed classes: plain "overlay" is the full-screen progress overlay's class.
        const head = row(r.y, parts, `t-${t.type}${t.hidden ? ' hidden' : ''}${t.muted ? ' muted' : ''}`);
        head.title = `${t.name} — ${t.type === 'audio' ? 'music and sound' : 'videos, images and text over the picture'}`;
      }
      if (this.rows.caps) row(this.rows.caps, [text('Captions')], 'caps');
      row(this.rows.film, [text('Video')], 'main');
      row(this.rows.words, [text('Words', 'tl-head-name dim')], 'main');
      row(this.rows.wave, [text('Voice', 'tl-head-name dim')], 'main');
      this.heads.replaceChildren(frag);
      this.heads.style.height = `${this.rows.height}px`;
    }

    toggleAddMenu() {
      const menu = this.root.querySelector('.tl-add-menu');
      menu.hidden = !menu.hidden;
    }

    renderChips() {
      const frag = document.createDocumentFragment();
      const pps = this.pps;
      const sel = this.selection;
      const ed = (t) => E.toEdited(this.kept, t);
      this.words.forEach((w, i) => {
        if (this.deleted.has(i)) return;
        const x0 = ed(w.start) * pps;
        const x1 = ed(Math.max(w.end, w.start + 0.05)) * pps;
        const chip = document.createElement('div');
        chip.className = 'tl-chip word';
        if (sel && i >= sel[0] && i <= sel[1]) chip.classList.add('sel');
        chip.dataset.word = i;
        chip.style.left = `${x0}px`;
        chip.style.width = `${Math.max(3, x1 - x0 - 2)}px`;
        if (x1 - x0 > 18) chip.textContent = w.text;
        chip.title = w.text;
        frag.appendChild(chip);
      });
      for (const gap of E.gaps(this.words, this.duration)) {
        const x0 = ed(gap.start) * pps;
        const x1 = ed(gap.end) * pps;
        const seconds = (x1 - x0) / pps;
        if (seconds < 0.05) continue; // the pause went with a cut word
        const chip = document.createElement('div');
        chip.className = 'tl-chip gap';
        if (this.cutGaps.has(gap.i)) chip.classList.add('shortened');
        if (this.gapSel === gap.i) chip.classList.add('sel');
        chip.dataset.gap = gap.i;
        chip.style.left = `${x0}px`;
        chip.style.width = `${Math.max(3, x1 - x0 - 2)}px`;
        if (x1 - x0 > 26) chip.textContent = `${seconds.toFixed(1)}s`;
        chip.title = this.cutGaps.has(gap.i)
          ? `Pause shortened to ${seconds.toFixed(1)}s (⌫ restores ${(gap.end - gap.start).toFixed(1)}s)`
          : `Pause ${seconds.toFixed(1)}s (select and press ⌫ to shorten)`;
        frag.appendChild(chip);
      }
      this.chips.replaceChildren(frag);
    }

    // Track items as blocks in their lanes.
    renderLanes() {
      const frag = document.createDocumentFragment();
      for (const t of this.tracks) {
        const y = this.trackRow(t.id);
        if (!y) continue;
        for (const it of t.items) {
          const el = document.createElement('div');
          el.className = `tl-item t-${t.type} k-${it.kind ?? 'audio'}`;
          if (it.id === this.itemSel) el.classList.add('sel');
          if (t.hidden || t.muted) el.classList.add('off');
          el.dataset.item = it.id;
          el.dataset.track = t.id;
          el.style.top = `${y[0]}px`;
          el.style.height = `${y[1] - y[0]}px`;
          el.style.left = `${it.startE * this.pps}px`;
          el.style.width = `${Math.max(12, it.length * this.pps - 2)}px`;
          if (it.thumb) el.style.backgroundImage = `url("${it.thumb}")`;
          if (t.type === 'overlay' && it.kind !== 'text') el.dataset.label = it.name ?? '';
          else el.textContent = it.kind === 'text' ? `T  ${it.text ?? ''}` : it.name ?? '';
          el.title = `${it.kind === 'text' ? it.text : it.name} · ${it.length.toFixed(1)}s — drag to move (also to another track), drag the right edge to change length, ⌫ removes it`;
          const handle = document.createElement('div');
          handle.className = 'handle';
          el.appendChild(handle);
          frag.appendChild(el);
        }
      }
      this.lanes.replaceChildren(frag);
    }

    // ---------- drawing ----------

    draw() {
      const dpr = window.devicePixelRatio || 1;
      const w = this.scroll.clientWidth;
      const height = this.rows.height;
      if (this.canvas.width !== Math.round(w * dpr) || this.canvas.height !== Math.round(height * dpr)) {
        this.canvas.width = Math.round(w * dpr);
        this.canvas.height = Math.round(height * dpr);
        this.canvas.style.width = `${w}px`;
        this.canvas.style.height = `${height}px`;
      }
      const left = this.scroll.scrollLeft;
      this.canvas.style.transform = `translateX(${left}px)`;
      const ctx = this.ctx;
      ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
      ctx.clearRect(0, 0, w, height);
      if (!this.duration) return;
      const end = this.editedDuration * this.pps;
      this.drawRuler(ctx, left, w);
      ctx.fillStyle = cssVar('--lane') || 'rgba(255,255,255,0.025)';
      for (const r of this.rows.tracks) ctx.fillRect(0, r.y[0], w, r.y[1] - r.y[0]);
      this.drawFilm(ctx, left, Math.min(w, end - left));
      this.drawWave(ctx, left, Math.min(w, end - left));
      this.drawCutMarks(ctx, left, w);
      this.drawMarks(ctx, left, w);
    }

    drawRuler(ctx, left, w) {
      const [top, bottom] = this.rows.ruler;
      const step = TICK_STEPS.find((s) => s * this.pps >= 80) ?? 600;
      ctx.fillStyle = cssVar('--muted');
      ctx.strokeStyle = cssVar('--line');
      ctx.font = '11px -apple-system, BlinkMacSystemFont, sans-serif';
      ctx.textBaseline = 'middle';
      const first = Math.floor(left / this.pps / step) * step;
      for (let t = first; t * this.pps <= left + w; t += step) {
        const x = t * this.pps - left;
        ctx.fillText(fmtTick(t, step), x + 4, (top + bottom) / 2);
        ctx.beginPath();
        ctx.moveTo(x + 0.5, bottom - 6);
        ctx.lineTo(x + 0.5, bottom);
        ctx.stroke();
        for (let k = 1; k < 4; k++) {
          const mx = x + (k * step * this.pps) / 4;
          ctx.beginPath();
          ctx.moveTo(mx + 0.5, bottom - 3);
          ctx.lineTo(mx + 0.5, bottom);
          ctx.stroke();
        }
      }
    }

    // The main clip as one framed block of thumbnails, each drawn at its true shape (cropped
    // to the tile, never stretched), with a thin gap between frames.
    drawFilm(ctx, left, w) {
      const [top, bottom] = this.rows.film;
      const h = bottom - top;
      const clipW = this.editedDuration * this.pps;
      ctx.save();
      ctx.beginPath();
      ctx.roundRect(-left, top, clipW, h, 7);
      ctx.clip();
      ctx.fillStyle = cssVar('--panel-3');
      ctx.fillRect(0, top, Math.max(0, w), h);
      const img0 = this.images.find((im) => im.complete && im.naturalWidth);
      if (img0 && w > 0) {
        const aspect = img0.naturalWidth / img0.naturalHeight;
        const tileW = Math.max(28, aspect * h);
        const first = Math.floor(left / tileW);
        for (let k = first; k * tileW < left + w; k++) {
          const x = k * tileW - left;
          const src = E.toSource(this.kept, (k * tileW + tileW / 2) / this.pps);
          const img = this.images[this.nearestFrame(src)];
          if (!img?.complete || !img.naturalWidth) continue;
          // crop the frame to the tile's shape instead of squeezing it
          const want = (tileW - 1) / h;
          let sw = img.naturalWidth;
          let sh = img.naturalHeight;
          if (sw / sh > want) sw = sh * want; else sh = sw / want;
          ctx.drawImage(img, (img.naturalWidth - sw) / 2, (img.naturalHeight - sh) / 2, sw, sh, x, top, tileW - 1, h);
        }
      }
      // name tag
      if (this.clipName && clipW - left > 60) {
        ctx.font = '600 11px -apple-system, BlinkMacSystemFont, sans-serif';
        const label = this.clipName;
        const tw = Math.min(ctx.measureText(label).width, 260);
        const lx = Math.max(6, -left + 6);
        ctx.fillStyle = 'rgba(0, 0, 0, 0.55)';
        ctx.beginPath();
        ctx.roundRect(lx, top + 5, tw + 14, 18, 5);
        ctx.fill();
        ctx.fillStyle = '#fff';
        ctx.textBaseline = 'middle';
        ctx.fillText(label, lx + 7, top + 14, 260);
      }
      ctx.restore();
      ctx.strokeStyle = cssVar('--film-border') || 'rgba(236, 235, 240, 0.85)';
      ctx.lineWidth = 2;
      ctx.beginPath();
      ctx.roundRect(-left + 1, top + 1, clipW - 2, h - 2, 7);
      ctx.stroke();
      ctx.lineWidth = 1;
    }

    nearestFrame(t) {
      const f = this.frames;
      let lo = 0;
      let hi = f.length - 1;
      while (lo < hi) {
        const mid = (lo + hi) >> 1;
        if (f[mid].t < t) lo = mid + 1; else hi = mid;
      }
      if (lo > 0 && Math.abs(f[lo - 1].t - t) < Math.abs(f[lo].t - t)) lo--;
      return lo;
    }

    // The voice as an audio clip: a tinted block with mirrored bars (2 px bars when zoomed in).
    drawWave(ctx, left, w) {
      const [top, bottom] = this.rows.wave;
      const mid = (top + bottom) / 2;
      const half = (bottom - top) / 2 - 3;
      const clipW = this.editedDuration * this.pps;
      ctx.save();
      ctx.beginPath();
      ctx.roundRect(-left, top, clipW, bottom - top, 7);
      ctx.clip();
      ctx.fillStyle = cssVar('--wave-bg') || 'rgba(124, 140, 255, 0.10)';
      ctx.fillRect(0, top, Math.max(0, w), bottom - top);
      if (!this.peaks || w <= 0) {
        ctx.fillStyle = cssVar('--line');
        ctx.fillRect(0, mid, Math.max(0, w), 1);
        ctx.restore();
        return;
      }
      ctx.fillStyle = cssVar('--wave');
      const bar = this.pps > 60 ? 3 : 1; // bar pitch in pixels
      const perPixel = this.perSecond / this.pps; // peak buckets per pixel
      const start = -((left % bar) + bar) % bar;
      for (let x = start; x < w; x += bar) {
        const src = E.toSource(this.kept, (left + x) / this.pps);
        const i0 = Math.floor(src * this.perSecond);
        const i1 = Math.max(i0 + 1, Math.floor(i0 + perPixel * bar));
        let p = 0;
        for (let i = i0; i < i1 && i < this.peaks.length; i++) if (this.peaks[i] > p) p = this.peaks[i];
        // Speech peaks are often quiet; a square root keeps them visible without clipping.
        const amp = Math.max(0.75, Math.sqrt(p) * half);
        if (bar > 1) {
          ctx.beginPath();
          ctx.roundRect(x, mid - amp, bar - 1, amp * 2, 1);
          ctx.fill();
        } else {
          ctx.fillRect(x, mid - amp, 1, amp * 2);
        }
      }
      ctx.restore();
    }

    // Blade splits and the selected time range.
    drawMarks(ctx, left, w) {
      const top = this.rows.film[0];
      const bottom = this.rows.wave[1];
      const sel = this.rangeDraft
        ?? (this.rangeSel ? [E.toEdited(this.kept, this.rangeSel[0]), E.toEdited(this.kept, this.rangeSel[1])] : null);
      if (sel) {
        const x0 = Math.min(sel[0], sel[1]) * this.pps - left;
        const x1 = Math.max(sel[0], sel[1]) * this.pps - left;
        ctx.fillStyle = 'rgba(124, 140, 255, 0.22)';
        ctx.fillRect(x0, top, Math.max(2, x1 - x0), bottom - top);
        ctx.fillStyle = cssVar('--accent');
        ctx.fillRect(x0 - 1, top, 2, bottom - top);
        ctx.fillRect(x1 - 1, top, 2, bottom - top);
      }
      ctx.fillStyle = '#ffd84d';
      for (const t of this.splits) {
        const x = E.toEdited(this.kept, t) * this.pps - left;
        if (x < -2 || x > w + 2) continue;
        ctx.fillRect(Math.round(x) - 1, top - 4, 2, bottom - top + 4);
        ctx.beginPath();
        ctx.moveTo(x - 5, top - 6);
        ctx.lineTo(x + 5, top - 6);
        ctx.lineTo(x, top);
        ctx.fill();
      }
    }

    // Thin markers where something was cut, so edits stay visible on the edited timeline.
    drawCutMarks(ctx, left, w) {
      ctx.fillStyle = cssVar('--cut');
      for (const [s] of this.cuts) {
        const x = E.toEdited(this.kept, s) * this.pps - left;
        if (x < -2 || x > w + 2) continue;
        ctx.fillRect(Math.round(x) - 1, this.rows.film[0], 2, this.rows.wave[1] - this.rows.film[0]);
      }
    }

    // ---------- interaction ----------

    sourceAt(clientX) {
      const x = clientX - this.content.getBoundingClientRect().left;
      return E.toSource(this.kept, Math.max(0, x) / this.pps);
    }

    itemOf(el) {
      for (const t of this.tracks) {
        const it = t.items.find((i) => i.id === el.dataset.item);
        if (it) return { track: t, item: it };
      }
      return null;
    }

    // Move an item in time and between tracks of the same kind, or change its length.
    itemDown(e, el) {
      const found = this.itemOf(el);
      if (!found) return;
      const { track, item } = found;
      this.onSelectItem(item.id);
      const resizing = e.target.classList.contains('handle');
      const x0 = e.clientX;
      const top = this.content.getBoundingClientRect().top;
      const max = this.editedDuration;
      let next = { startE: item.startE, length: item.length, trackId: track.id };
      const node = () => this.lanes.querySelector(`[data-item="${CSS.escape(item.id)}"]`);
      this.drag((ev) => {
        const dt = (ev.clientX - x0) / this.pps;
        if (resizing) {
          next = { ...next, length: Math.max(0.3, Math.min(max - item.startE, item.length + dt)) };
        } else {
          const over = this.tracks.find((t) => t.id === this.trackAt(ev.clientY - top));
          next = {
            startE: Math.max(0, Math.min(max - item.length, item.startE + dt)),
            length: item.length,
            trackId: over && over.type === track.type ? over.id : next.trackId,
          };
        }
        const n = node();
        if (n) {
          n.style.left = `${next.startE * this.pps}px`;
          n.style.width = `${Math.max(12, next.length * this.pps - 2)}px`;
          const y = this.trackRow(next.trackId);
          if (y) n.style.top = `${y[0]}px`;
        }
      }, () => {
        if (next.startE !== item.startE || next.length !== item.length || next.trackId !== track.id) {
          this.onChangeItem(item.id, next);
        }
      });
    }

    // Slip: drag a video or audio item sideways to change which part of it plays; its place
    // and length on the timeline stay the same.
    slipDown(e, el) {
      const found = this.itemOf(el);
      if (!found) return;
      const { item } = found;
      this.onSelectItem(item.id);
      if (item.kind === 'image' || item.kind === 'text' || !item.duration) return;
      const x0 = e.clientX;
      const off0 = item.offset ?? 0;
      const max = Math.max(0, item.duration - item.length);
      let offset = off0;
      this.drag((ev) => {
        offset = Math.max(0, Math.min(max, off0 - (ev.clientX - x0) / this.pps));
        const n = this.lanes.querySelector(`[data-item="${CSS.escape(item.id)}"]`);
        if (n) n.style.backgroundPositionX = `${-offset * 20}px`;
      }, () => {
        if (offset !== off0) this.onChangeItem(item.id, { offset });
      });
    }

    pointerDown(e) {
      if (e.button !== 0) return;
      const tool = this.tool;
      if (tool === 'hand') {
        e.preventDefault();
        const x0 = e.clientX;
        const y0 = e.clientY;
        const s0 = this.scroll.scrollLeft;
        const v0 = this.body.scrollTop;
        this.drag((ev) => {
          this.scroll.scrollLeft = s0 - (ev.clientX - x0);
          this.body.scrollTop = v0 - (ev.clientY - y0);
        });
        return;
      }
      const block = e.target.closest('.tl-item');
      if (block) {
        e.preventDefault();
        if (tool === 'slip') this.slipDown(e, block);
        else this.itemDown(e, block);
        return;
      }
      if (tool === 'blade') {
        e.preventDefault();
        this.onBlade(this.sourceAt(e.clientX));
        return;
      }
      if (tool === 'range') {
        e.preventDefault();
        const r = this.content.getBoundingClientRect();
        const at = (x) => Math.min(this.editedDuration, Math.max(0, (x - r.left) / this.pps));
        const e0 = at(e.clientX);
        this.rangeDraft = [e0, e0];
        this.draw();
        this.drag((ev) => {
          this.rangeDraft = [e0, at(ev.clientX)];
          this.draw();
        }, () => {
          const [a, b] = this.rangeDraft;
          this.rangeDraft = null;
          if (Math.abs(b - a) < 0.05) { this.draw(); this.onSeek(E.toSource(this.kept, a)); return; }
          this.onSelectRange(E.toSource(this.kept, Math.min(a, b)), E.toSource(this.kept, Math.max(a, b)));
        });
        return;
      }
      const chip = e.target.closest('.tl-chip');
      if (chip?.dataset.word != null) {
        this.onSelectWord(Number(chip.dataset.word), e.shiftKey);
        return;
      }
      if (chip?.dataset.gap != null) {
        this.onSelectGap(Number(chip.dataset.gap));
        return;
      }
      e.preventDefault();
      // With blade splits, clicking the clip track selects the piece between them.
      const y = e.clientY - this.content.getBoundingClientRect().top;
      if (this.splits.length && y >= this.rows.film[0] && y <= this.rows.film[1]) {
        this.onSelectSegment(this.sourceAt(e.clientX));
        return;
      }
      this.onSeek(this.sourceAt(e.clientX));
      this.drag((ev) => this.onSeek(this.sourceAt(ev.clientX)));
    }
  }

  root.CutlineTimeline = Timeline;
})(window);
