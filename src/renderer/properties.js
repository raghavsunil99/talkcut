/* global CutlineFrame */
// Properties panel for the main clip: speed and duration, audio, frame shape, size and
// position, rotation and crop. Changes are reported live (for the preview) and committed on
// release (for undo).
(function (root) {
  const F = CutlineFrame;
  const $ = (id) => document.getElementById(id);

  function fmt(seconds) {
    if (!Number.isFinite(seconds)) return '—';
    const m = Math.floor(seconds / 60);
    const s = seconds - m * 60;
    return `${m}:${s.toFixed(1).padStart(4, '0')}`;
  }

  class PropertiesPanel {
    // onChange(props, { final }) — final is true when a drag ends or a field is committed.
    constructor({ onChange }) {
      this.onChange = onChange;
      this.props = F.normalize(null);
      this.editedLength = 0;
      this.build();
      this.render();
    }

    set(change, final) {
      this.props = F.normalize({ ...this.props, ...change, crop: { ...this.props.crop, ...(change.crop || {}) } });
      this.render();
      this.onChange(this.props, { final });
    }

    setProps(props, editedLength, sourceSize) {
      if (sourceSize) this.sourceSize = sourceSize;
      this.props = F.normalize(props);
      this.editedLength = editedLength;
      this.render();
    }

    setEditedLength(len) {
      this.editedLength = len;
      this.renderDuration();
    }

    // A range slider with a number box; live while dragging, committed on release.
    slider(id, { min, max, step, toValue, fromValue, apply }) {
      const range = $(id);
      const box = $(`${id}-num`);
      range.min = min;
      range.max = max;
      range.step = step;
      range.addEventListener('input', () => this.set(apply(toValue(Number(range.value))), false));
      range.addEventListener('change', () => this.set(apply(toValue(Number(range.value))), true));
      box.addEventListener('change', () => this.set(apply(toValue(Number(box.value))), true));
      return (v) => {
        const shown = fromValue(v);
        if (document.activeElement !== range) range.value = shown;
        if (document.activeElement !== box) box.value = Math.round(shown * 10) / 10;
      };
    }

    build() {
      this.renderers = [];
      // speed and duration
      $('prop-speed').addEventListener('change', () => this.set({ speed: Number($('prop-speed').value) || 1 }, true));
      $('prop-duration').addEventListener('change', () => {
        const [m, s] = $('prop-duration').value.includes(':') ? $('prop-duration').value.split(':').map(Number) : [0, Number($('prop-duration').value)];
        const target = m * 60 + s;
        if (target > 0 && this.editedLength > 0) this.set({ speed: this.editedLength / target }, true);
        else this.renderDuration();
      });
      // audio
      this.renderers.push(['volume', this.slider('prop-volume', {
        min: 0, max: 200, step: 1, toValue: (v) => v / 100, fromValue: (v) => v * 100, apply: (v) => ({ volume: v, muted: false }),
      })]);
      $('prop-mute').addEventListener('click', () => this.set({ muted: !this.props.muted }, true));
      $('prop-enhance').addEventListener('change', () => this.set({ enhance: $('prop-enhance').checked }, true));
      // frame
      const canvas = $('prop-canvas');
      for (const [key, { label, hint, w, h }] of Object.entries(F.CANVASES)) {
        const b = document.createElement('button');
        b.type = 'button';
        b.dataset.value = key;
        b.title = hint ?? '';
        // a little rectangle in the frame's shape
        const shape = document.createElement('i');
        const [sw, sh] = key === 'original' ? [16, 12] : key === 'custom' ? [14, 14] : [w, h];
        const k = 20 / Math.max(sw, sh);
        Object.assign(shape.style, { width: `${Math.round(sw * k)}px`, height: `${Math.round(sh * k)}px` });
        if (key === 'custom') shape.style.borderStyle = 'dashed';
        const name = document.createElement('span');
        name.textContent = label;
        const small = document.createElement('small');
        small.textContent = hint ?? 'Source shape';
        b.append(shape, name, small);
        b.addEventListener('click', () => this.set({ canvas: key }, true));
        canvas.appendChild(b);
      }
      const custom = () => this.set({ customW: Number($('prop-custom-w').value), customH: Number($('prop-custom-h').value) }, true);
      $('prop-custom-w').addEventListener('change', custom);
      $('prop-custom-h').addEventListener('change', custom);
      $('prop-custom-swap').addEventListener('click', () => this.set({ customW: this.props.customH, customH: this.props.customW }, true));
      $('prop-bgmode').querySelectorAll('button').forEach((b) => b.addEventListener('click', () => this.set({ bgMode: b.dataset.value }, true)));
      $('prop-bg').addEventListener('input', () => this.set({ background: $('prop-bg').value, bgMode: 'color' }, false));
      $('prop-bg').addEventListener('change', () => this.set({ background: $('prop-bg').value, bgMode: 'color' }, true));
      $('prop-flip-h').addEventListener('click', () => this.set({ flipH: !this.props.flipH }, true));
      $('prop-flip-v').addEventListener('click', () => this.set({ flipV: !this.props.flipV }, true));
      // size and position
      this.renderers.push(['scale', this.slider('prop-scale', {
        min: 10, max: 400, step: 1, toValue: (v) => v / 100, fromValue: (v) => v * 100, apply: (v) => ({ scale: v }),
      })]);
      this.renderers.push(['x', this.slider('prop-x', {
        min: -100, max: 100, step: 1, toValue: (v) => v / 100, fromValue: (v) => v * 100, apply: (v) => ({ x: v }),
      })]);
      this.renderers.push(['y', this.slider('prop-y', {
        min: -100, max: 100, step: 1, toValue: (v) => v / 100, fromValue: (v) => v * 100, apply: (v) => ({ y: v }),
      })]);
      $('prop-rotate-left').addEventListener('click', () => this.set({ rotate: (this.props.rotate + 270) % 360 }, true));
      $('prop-rotate-right').addEventListener('click', () => this.set({ rotate: (this.props.rotate + 90) % 360 }, true));
      $('prop-reset-position').addEventListener('click', () => this.set({ scale: 1, x: 0, y: 0, rotate: 0 }, true));
      // crop
      for (const side of ['l', 't', 'r', 'b']) {
        this.renderers.push([`crop.${side}`, this.slider(`prop-crop-${side}`, {
          min: 0, max: 90, step: 0.5, toValue: (v) => v / 100, fromValue: (v) => v * 100, apply: (v) => ({ crop: { [side]: v } }),
        })]);
      }
      $('prop-reset-crop').addEventListener('click', () => this.set({ crop: { l: 0, t: 0, r: 0, b: 0 } }, true));
      $('prop-reset-all').addEventListener('click', () => this.set(F.normalize(null), true));
    }

    renderDuration() {
      const out = this.editedLength / this.props.speed;
      if (document.activeElement !== $('prop-duration')) $('prop-duration').value = fmt(out);
      $('prop-duration-note').textContent = this.props.speed === 1
        ? 'Length of the exported video.'
        : `Edited ${fmt(this.editedLength)} played at ${this.props.speed.toFixed(2)}x.`;
    }

    render() {
      const p = this.props;
      const speedBox = $('prop-speed');
      if (![...speedBox.options].some((o) => Number(o.value) === p.speed)) {
        speedBox.add(new Option(`${p.speed.toFixed(2)}x`, String(p.speed)));
      }
      speedBox.value = String([...speedBox.options].find((o) => Number(o.value) === p.speed)?.value ?? p.speed);
      this.renderDuration();
      for (const [key, renderer] of this.renderers) {
        renderer(key.startsWith('crop.') ? p.crop[key.slice(5)] : p[key]);
      }
      $('prop-mute').textContent = p.muted ? 'Unmute' : 'Mute';
      $('prop-mute').classList.toggle('on', p.muted);
      $('prop-enhance').checked = p.enhance;
      $('prop-canvas').querySelectorAll('button').forEach((b) => b.classList.toggle('on', b.dataset.value === p.canvas));
      $('prop-custom').hidden = p.canvas !== 'custom';
      if (document.activeElement !== $('prop-custom-w')) $('prop-custom-w').value = p.customW;
      if (document.activeElement !== $('prop-custom-h')) $('prop-custom-h').value = p.customH;
      $('prop-bgmode').querySelectorAll('button').forEach((b) => b.classList.toggle('on', b.dataset.value === p.bgMode));
      $('prop-flip-h').classList.toggle('on', p.flipH);
      $('prop-flip-v').classList.toggle('on', p.flipV);
      if (this.sourceSize) {
        const L = F.layout(this.sourceSize.w, this.sourceSize.h, p);
        $('prop-frame-size').textContent = `Exports at ${L.frame.w} × ${L.frame.h}`;
      }
      if (document.activeElement !== $('prop-bg')) $('prop-bg').value = p.background;
      $('prop-rotation').textContent = `${p.rotate}°`;
      $('prop-reset-all').disabled = F.isDefault(p);
    }
  }

  root.CutlineProperties = PropertiesPanel;
})(window);
