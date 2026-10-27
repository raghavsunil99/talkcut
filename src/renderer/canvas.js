// Direct editing on the preview: click the video or an overlay to select it, drag to move,
// drag a corner to resize (keeps the shape; hold Shift to change it), plus a small toolbar.
// The app supplies the targets and applies the changes; this module only handles the pointer.
(function (root) {
  const HANDLES = ['nw', 'ne', 'sw', 'se'];

  class CanvasEditor {
    // callbacks:
    //   targets()            -> [{ id, label, rect: {x, y, w, h} (stage px), main?: bool }] bottom to top
    //   selected()           -> id or null
    //   select(id)           -> select a target (null clears)
    //   change(id, rect, phase) -> apply a moved or resized rect; phase 'start' | 'move' | 'end'
    //   action(name, id)     -> toolbar buttons
    constructor(stage, callbacks) {
      this.stage = stage;
      this.cb = callbacks;
      this.ui = document.createElement('div');
      this.ui.className = 'canvas-ui';
      this.box = document.createElement('div');
      this.box.className = 'canvas-box';
      for (const h of HANDLES) {
        const el = document.createElement('div');
        el.className = `canvas-handle ${h}`;
        el.dataset.handle = h;
        this.box.appendChild(el);
      }
      this.bar = document.createElement('div');
      this.bar.className = 'canvas-bar';
      this.ui.append(this.box);
      // Outside the stage, which clips its content: handles on the frame's edge must stay grabbable.
      stage.parentElement.appendChild(this.ui);
      stage.parentElement.appendChild(this.bar);
      this.ui.addEventListener('mousedown', (e) => this.down(e));
      this.bar.addEventListener('mousedown', (e) => e.stopPropagation());
      this.enabled = false;
    }

    setEnabled(on) {
      this.enabled = on;
      this.ui.style.pointerEvents = on ? 'auto' : 'none';
      if (!on) this.hide();
    }

    hide() {
      this.box.hidden = true;
      this.bar.hidden = true;
    }

    // Topmost target under a stage point.
    hit(x, y) {
      const list = this.cb.targets();
      for (let i = list.length - 1; i >= 0; i--) {
        const r = list[i].rect;
        if (x >= r.x && x <= r.x + r.w && y >= r.y && y <= r.y + r.h) return list[i];
      }
      return null;
    }

    // Redraw the selection frame and toolbar for the current selection.
    // Keep the editing layer exactly over the stage.
    align() {
      const s = this.stage.getBoundingClientRect();
      const p = this.stage.parentElement.getBoundingClientRect();
      Object.assign(this.ui.style, { left: `${s.left - p.left}px`, top: `${s.top - p.top}px`, width: `${s.width}px`, height: `${s.height}px` });
    }

    update() {
      this.align();
      const id = this.cb.selected();
      const t = id ? this.cb.targets().find((x) => x.id === id) : null;
      if (!this.enabled || !t) { this.hide(); return; }
      const r = t.rect;
      Object.assign(this.box.style, { left: `${r.x}px`, top: `${r.y}px`, width: `${r.w}px`, height: `${r.h}px` });
      this.box.hidden = false;
      this.renderBar(t);
    }

    renderBar(t) {
      const key = `${t.id}|${t.label}|${t.size}|${t.main}`;
      if (this.barKey !== key) {
        this.barKey = key;
        const btn = (label, title, name) => {
          const b = document.createElement('button');
          b.type = 'button';
          b.textContent = label;
          b.title = title;
          b.addEventListener('click', () => this.cb.action(name, t.id));
          return b;
        };
        const name = document.createElement('span');
        name.className = 'canvas-bar-name';
        name.textContent = t.label;
        const size = document.createElement('span');
        size.className = 'canvas-bar-size';
        size.textContent = t.size ?? '';
        const parts = t.captions ? [name, size] : [name, size, btn('Fit', 'Fit inside the frame', 'fit'), btn('Fill', 'Fill the frame (crops the edges)', 'fill'), btn('Center', 'Center in the frame', 'center')];
        if (t.captions) parts.push(btn('Top', 'Move captions to the top', 'top'), btn('Middle', 'Middle of the frame', 'middle'), btn('Bottom', 'Move captions to the bottom', 'bottom'), btn('A−', 'Smaller', 'smaller'), btn('A+', 'Bigger', 'bigger'), btn('Style', 'Caption styles', 'style'), btn('Hide', 'Turn captions off', 'off'));
        else if (t.main) parts.push(btn('Crop', 'Crop on the video', 'crop'));
        else parts.push(btn('↑', 'Bring forward (move to the track above)', 'forward'), btn('↓', 'Send backward (move to the track below)', 'backward'), btn('🗑', 'Remove', 'remove'));
        this.bar.replaceChildren(...parts);
      }
      // Above the selection, kept inside the player.
      const stageRect = this.stage.getBoundingClientRect();
      const parentRect = this.stage.parentElement.getBoundingClientRect();
      const r = t.rect;
      const barW = this.bar.offsetWidth || 300;
      let left = stageRect.left - parentRect.left + r.x + r.w / 2 - barW / 2;
      left = Math.max(6, Math.min(parentRect.width - barW - 6, left));
      let top = stageRect.top - parentRect.top + r.y - 44;
      if (top < 6) top = Math.min(parentRect.height - 40, stageRect.top - parentRect.top + r.y + 8);
      Object.assign(this.bar.style, { left: `${left}px`, top: `${top}px` });
      this.bar.hidden = false;
    }

    down(e) {
      if (e.button !== 0) return;
      e.preventDefault();
      const s = this.stage.getBoundingClientRect();
      const px = e.clientX - s.left;
      const py = e.clientY - s.top;
      const handle = e.target.dataset?.handle;
      let target;
      if (handle) {
        target = this.cb.targets().find((x) => x.id === this.cb.selected());
      } else {
        target = this.hit(px, py);
        this.cb.select(target?.id ?? null);
        this.update();
      }
      if (!target) return;
      const r0 = { ...target.rect };
      const aspect = r0.w / r0.h;
      let moved = false;
      this.cb.change(target.id, r0, 'start');
      const move = (ev) => {
        const dx = ev.clientX - e.clientX;
        const dy = ev.clientY - e.clientY;
        if (!moved && Math.abs(dx) + Math.abs(dy) < 3) return;
        moved = true;
        let r;
        if (!handle) {
          r = { ...r0, x: r0.x + dx, y: r0.y + dy };
          // Snap to the frame's centre lines and edges within 6 px.
          const W = s.width;
          const H = s.height;
          const snap = (v, targets) => { for (const t of targets) if (Math.abs(v - t) < 6) return t; return v; };
          r.x = snap(r.x, [0, W - r.w, (W - r.w) / 2]);
          r.y = snap(r.y, [0, H - r.h, (H - r.h) / 2]);
        } else {
          const left = handle.includes('w');
          const top = handle.includes('n');
          let w = Math.max(16, r0.w + (left ? -dx : dx));
          let h = Math.max(16, r0.h + (top ? -dy : dy));
          if (!ev.shiftKey) {
            // Follow the drag along the corner's diagonal, keeping the shape.
            const f = Math.max(16 / r0.w, (w * r0.w + h * r0.h) / (r0.w * r0.w + r0.h * r0.h));
            w = r0.w * f;
            h = w / aspect;
          }
          r = { x: left ? r0.x + r0.w - w : r0.x, y: top ? r0.y + r0.h - h : r0.y, w, h };
        }
        this.cb.change(target.id, r, 'move');
        this.update();
      };
      const up = () => {
        window.removeEventListener('mousemove', move);
        window.removeEventListener('mouseup', up);
        this.cb.change(target.id, null, moved ? 'end' : 'cancel');
        this.update();
      };
      window.addEventListener('mousemove', move);
      window.addEventListener('mouseup', up);
    }
  }

  root.CutlineCanvas = CanvasEditor;
})(window);
