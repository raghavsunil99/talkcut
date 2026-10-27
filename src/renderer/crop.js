// Crop on the video: a box over the whole picture with the outside dimmed, eight handles,
// thirds lines, shape presets (Free, Original, 9:16, 1:1 ...) and rotate / flip buttons.
// The box is a rect in fractions of the picture as shown; the app converts it to crop values.
(function (root) {
  const RATIOS = [
    ['free', 'Free', null], ['original', 'Original', 'src'], ['9:16', '9:16', 9 / 16], ['1:1', '1:1', 1],
    ['4:5', '4:5', 4 / 5], ['4:3', '4:3', 4 / 3], ['16:9', '16:9', 16 / 9],
  ];
  const HANDLES = ['nw', 'n', 'ne', 'e', 'se', 's', 'sw', 'w'];
  const MIN = 0.05;

  class CropEditor {
    // callbacks: change(rect), done(), cancel(), rotate(dir), flip(axis)
    constructor(player, callbacks) {
      this.player = player;
      this.cb = callbacks;
      this.ui = document.createElement('div');
      this.ui.className = 'crop-ui';
      this.ui.hidden = true;
      this.box = document.createElement('div');
      this.box.className = 'crop-box';
      for (const h of HANDLES) {
        const el = document.createElement('div');
        el.className = `crop-handle ${h}`;
        el.dataset.handle = h;
        this.box.appendChild(el);
      }
      for (let i = 0; i < 4; i++) this.box.appendChild(document.createElement('i'));
      this.ui.appendChild(this.box);
      this.bar = document.createElement('div');
      this.bar.className = 'crop-bar';
      this.bar.hidden = true;
      const ratios = document.createElement('div');
      ratios.className = 'crop-ratios';
      for (const [key, label] of RATIOS) {
        const b = document.createElement('button');
        b.type = 'button';
        b.dataset.ratio = key;
        b.textContent = label;
        b.addEventListener('click', () => this.setRatio(key));
        ratios.appendChild(b);
      }
      const btn = (label, title, fn, cls = '') => {
        const b = document.createElement('button');
        b.type = 'button';
        b.textContent = label;
        b.title = title;
        if (cls) b.className = cls;
        b.addEventListener('click', fn);
        return b;
      };
      this.sizeLabel = document.createElement('span');
      this.sizeLabel.className = 'crop-size';
      this.bar.append(
        ratios,
        btn('⟲', 'Rotate left', () => this.cb.rotate(-1)),
        btn('⟳', 'Rotate right', () => this.cb.rotate(1)),
        btn('⇋', 'Flip horizontally', () => this.cb.flip('h')),
        btn('⥮', 'Flip vertically', () => this.cb.flip('v')),
        btn('Reset', 'Show the whole picture', () => { this.ratio = 'free'; this.set({ x: 0, y: 0, w: 1, h: 1 }); this.paintRatios(); }),
        this.sizeLabel,
        btn('Cancel', 'Leave the crop as it was (Esc)', () => this.cb.cancel()),
        btn('Done', 'Apply the crop (Enter)', () => this.cb.done(), 'primary'),
      );
      player.append(this.ui, this.bar);
      this.ui.addEventListener('mousedown', (e) => this.down(e));
      this.bar.addEventListener('mousedown', (e) => e.stopPropagation());
      this.rect = { x: 0, y: 0, w: 1, h: 1 };
      this.ratio = 'free';
    }

    get active() { return !this.ui.hidden; }

    // area: the whole picture in player pixels { left, top, width, height }; srcAspect: its width / height.
    start(rect, area, srcAspect) {
      this.rect = { ...rect };
      this.area = area;
      this.srcAspect = srcAspect;
      this.ratio = 'free';
      this.ui.hidden = false;
      this.bar.hidden = false;
      this.paintRatios();
      this.render();
    }

    stop() {
      this.ui.hidden = true;
      this.bar.hidden = true;
    }

    // The picture moved or turned (window resize, rotate, flip).
    setArea(area, srcAspect, rect) {
      this.area = area;
      this.srcAspect = srcAspect;
      if (rect) this.rect = { ...rect };
      this.render();
    }

    // Wanted width / height of the box in fractions of the picture, for the chosen shape.
    fractionRatio() {
      const r = RATIOS.find(([k]) => k === this.ratio)?.[2];
      if (!r) return null;
      const pixels = r === 'src' ? this.srcAspect : r;
      return pixels / (this.area.width / this.area.height);
    }

    setRatio(key) {
      this.ratio = key;
      this.paintRatios();
      const fr = this.fractionRatio();
      if (!fr) return;
      // the largest box of that shape, centred on the current one
      const cx = this.rect.x + this.rect.w / 2;
      const cy = this.rect.y + this.rect.h / 2;
      let w = 1;
      let h = w / fr;
      if (h > 1) { h = 1; w = h * fr; }
      this.set({ x: Math.min(1 - w, Math.max(0, cx - w / 2)), y: Math.min(1 - h, Math.max(0, cy - h / 2)), w, h });
    }

    paintRatios() {
      this.bar.querySelectorAll('[data-ratio]').forEach((b) => b.classList.toggle('on', b.dataset.ratio === this.ratio));
    }

    set(rect) {
      this.rect = rect;
      this.render();
      this.cb.change({ ...rect });
    }

    render() {
      if (!this.area) return;
      const a = this.area;
      const r = this.rect;
      Object.assign(this.ui.style, { left: `${a.left}px`, top: `${a.top}px`, width: `${a.width}px`, height: `${a.height}px` });
      Object.assign(this.box.style, { left: `${r.x * a.width}px`, top: `${r.y * a.height}px`, width: `${r.w * a.width}px`, height: `${r.h * a.height}px` });
      const pw = Math.round(r.w * (this.srcPixels?.w ?? 0));
      const ph = Math.round(r.h * (this.srcPixels?.h ?? 0));
      this.sizeLabel.textContent = pw && ph ? `${pw} × ${ph}` : '';
      // toolbar under the picture, inside the player
      const p = this.player.getBoundingClientRect();
      this.bar.style.maxWidth = `${p.width - 12}px`;
      const barW = this.bar.offsetWidth || 560;
      const left = Math.max(6, Math.min(p.width - barW - 6, a.left + a.width / 2 - barW / 2));
      const barH = this.bar.offsetHeight || 40;
      const top = Math.min(p.height - barH - 6, a.top + a.height + 8);
      Object.assign(this.bar.style, { left: `${left}px`, top: `${Math.max(6, top)}px` });
    }

    down(e) {
      if (e.button !== 0) return;
      e.preventDefault();
      const handle = e.target.dataset?.handle ?? (e.target.closest('.crop-box') ? 'move' : null);
      if (!handle) return;
      const a = this.area;
      const r0 = { ...this.rect };
      const fr = this.fractionRatio();
      const move = (ev) => {
        const dx = (ev.clientX - e.clientX) / a.width;
        const dy = (ev.clientY - e.clientY) / a.height;
        let { x, y, w, h } = r0;
        if (handle === 'move') {
          x = Math.min(1 - w, Math.max(0, r0.x + dx));
          y = Math.min(1 - h, Math.max(0, r0.y + dy));
        } else {
          let x1 = r0.x;
          let y1 = r0.y;
          let x2 = r0.x + r0.w;
          let y2 = r0.y + r0.h;
          if (handle.includes('w')) x1 = Math.min(x2 - MIN, Math.max(0, r0.x + dx));
          if (handle.includes('e')) x2 = Math.max(x1 + MIN, Math.min(1, x2 + dx));
          if (handle.includes('n')) y1 = Math.min(y2 - MIN, Math.max(0, r0.y + dy));
          if (handle.includes('s')) y2 = Math.max(y1 + MIN, Math.min(1, y2 + dy));
          w = x2 - x1;
          h = y2 - y1;
          if (fr) {
            // keep the shape: follow the larger change, anchored at the opposite side
            const byW = ['e', 'w'].includes(handle) || (handle.length === 2 && Math.abs(dx) * a.width >= Math.abs(dy) * a.height);
            if (byW) h = w / fr; else w = h * fr;
            if (handle === 'n' || handle === 's') { x1 = r0.x + (r0.w - w) / 2; }
            if (handle === 'e' || handle === 'w') { y1 = r0.y + (r0.h - h) / 2; }
            if (handle.includes('w')) x1 = x2 - w;
            if (handle.includes('n')) y1 = y2 - h;
            // stay inside the picture
            const k = Math.min(1, x1 < 0 ? (w + x1) / w : 1, y1 < 0 ? (h + y1) / h : 1, x1 + w > 1 ? (1 - x1) / w : 1, y1 + h > 1 ? (1 - y1) / h : 1);
            if (k < 1) {
              const nw = w * k;
              const nh = h * k;
              if (handle.includes('w')) x1 = x2 - nw;
              if (handle.includes('n')) y1 = y2 - nh;
              w = nw;
              h = nh;
            }
            x1 = Math.max(0, Math.min(1 - w, x1));
            y1 = Math.max(0, Math.min(1 - h, y1));
          }
          x = x1;
          y = y1;
        }
        this.set({ x, y, w, h });
      };
      const up = () => {
        window.removeEventListener('mousemove', move);
        window.removeEventListener('mouseup', up);
      };
      window.addEventListener('mousemove', move);
      window.addEventListener('mouseup', up);
    }
  }

  root.CutlineCrop = CropEditor;
})(window);
