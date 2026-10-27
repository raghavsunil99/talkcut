// Text and titles on overlay tracks: presets, the live preview, and ASS events for the
// export. A text item's box sets where it sits and how big it is; the font size follows the
// box height so resizing on the canvas scales the text.
(function (root) {
  const isNode = typeof module !== 'undefined' && module.exports;
  const C = isNode ? require('./captions.js') : root.CutlineCaptions;

  const PRESETS = {
    title: {
      label: 'Title', text: 'Your title here', box: { x: 0.08, y: 0.38, w: 0.84, h: 0.12 },
      color: '#FFFFFF', accent: '#FFD84D', bg: null, weight: 800, align: 'center', upper: false, shadow: true,
    },
    lower: {
      label: 'Lower third', text: 'Your Name\nWhat you do', box: { x: 0.06, y: 0.72, w: 0.7, h: 0.1 },
      color: '#FFFFFF', accent: '#7C8CFF', bg: 'rgba(20,20,28,0.78)', weight: 700, align: 'left', upper: false, shadow: false,
    },
    callout: {
      label: 'Callout', text: 'Important!', box: { x: 0.25, y: 0.12, w: 0.5, h: 0.07 },
      color: '#111111', accent: '#FFD84D', bg: '#FFD84D', weight: 800, align: 'center', upper: true, shadow: false,
    },
    bar: {
      label: 'Text bar', text: 'Add your text', box: { x: 0, y: 0.86, w: 1, h: 0.06 },
      color: '#FFFFFF', accent: '#FFFFFF', bg: 'rgba(0,0,0,0.6)', weight: 600, align: 'center', upper: false, shadow: false,
    },
  };

  function styleOf(item) {
    const p = PRESETS[item.style?.preset] ?? PRESETS.title;
    return { ...p, ...(item.style || {}) };
  }

  function linesOf(item) {
    const s = styleOf(item);
    const text = String(item.text ?? '').replace(/\r/g, '');
    return (s.upper ? text.toUpperCase() : text).split('\n');
  }

  // Font size in pixels for a box this many pixels tall.
  function fontPx(item, boxH) {
    return Math.max(6, (boxH / Math.max(1, linesOf(item).length)) * 0.78);
  }

  function fontFamily(language) {
    return C.fontFor(language);
  }

  // ---------- preview ----------

  function renderDom(el, item, language) {
    const s = styleOf(item);
    const h = el.clientHeight || parseFloat(el.style.height) || 40;
    const lines = linesOf(item);
    const size = fontPx(item, h);
    el.classList.add('text-layer');
    el.style.display = 'flex';
    el.style.flexDirection = 'column';
    el.style.justifyContent = 'center';
    el.style.alignItems = s.align === 'left' ? 'flex-start' : s.align === 'right' ? 'flex-end' : 'center';
    el.style.textAlign = s.align;
    el.style.fontFamily = `"${fontFamily(language)}", "${C.LATIN_FONT}", sans-serif`;
    el.style.fontWeight = String(s.weight);
    el.style.fontSize = `${size}px`;
    el.style.lineHeight = '1.18';
    el.style.color = s.color;
    el.style.background = s.bg ?? 'transparent';
    el.style.borderRadius = s.bg ? `${size * 0.25}px` : '0';
    el.style.padding = s.bg ? `0 ${size * 0.45}px` : '0';
    el.style.boxSizing = 'border-box';
    el.style.textShadow = s.shadow ? `0 ${size * 0.05}px ${size * 0.18}px rgba(0,0,0,0.7)` : '';
    el.style.whiteSpace = 'pre';
    el.style.overflow = 'visible';
    const key = JSON.stringify([lines, s.accent, item.style?.preset]);
    if (el.dataset.key !== key) {
      el.dataset.key = key;
      el.replaceChildren(...lines.map((line, i) => {
        const span = document.createElement('span');
        span.textContent = line || ' ';
        // Lower third: the name line is bigger, the second line smaller and in the accent colour.
        if (item.style?.preset === 'lower' && i > 0) { span.style.fontSize = '0.72em'; span.style.color = s.accent; span.style.fontWeight = '600'; }
        if (item.style?.preset === 'title' && i > 0) span.style.color = s.accent;
        return span;
      }));
    }
  }

  // ---------- export (ASS) ----------

  function assColor(css, fallbackAlpha = 0) {
    const m = /rgba?\((\d+),\s*(\d+),\s*(\d+)(?:,\s*([\d.]+))?\)/.exec(css || '');
    const hex = (n) => Number(n).toString(16).padStart(2, '0').toUpperCase();
    if (m) {
      const a = m[4] == null ? 0 : Math.round((1 - Number(m[4])) * 255);
      return `&H${hex(a)}${hex(m[3])}${hex(m[2])}${hex(m[1])}`;
    }
    const h = /^#?([0-9a-f]{2})([0-9a-f]{2})([0-9a-f]{2})$/i.exec(css || '');
    if (!h) return `&H${hex(fallbackAlpha)}FFFFFF`;
    return `&H${hex(fallbackAlpha)}${h[3]}${h[2]}${h[1]}`.toUpperCase();
  }

  // \\1c-style tag value and alpha for a CSS colour.
  function tagColor(css) {
    const c = assColor(css);
    return { color: `&H${c.slice(4)}&`, alpha: `&H${c.slice(2, 4)}&` };
  }

  const esc = (t) => t.replace(/\\/g, '＼').replace(/[{}]/g, (c) => (c === '{' ? '(' : ')'));

  // One ASS document holding every text item; times are edited seconds.
  function buildAss(items, { width, height, language }) {
    const font = fontFamily(language);
    const header = [
      '[Script Info]', 'ScriptType: v4.00+', `PlayResX: ${width}`, `PlayResY: ${height}`, 'WrapStyle: 2', 'ScaledBorderAndShadow: yes', '',
      '[V4+ Styles]',
      'Format: Name, Fontname, Fontsize, PrimaryColour, SecondaryColour, OutlineColour, BackColour, Bold, Italic, Underline, StrikeOut, ScaleX, ScaleY, Spacing, Angle, BorderStyle, Outline, Shadow, Alignment, MarginL, MarginR, MarginV, Encoding',
      `Style: Text,${font},48,&H00FFFFFF,&H00FFFFFF,&H00000000,&H80000000,-1,0,0,0,100,100,0,0,1,0,0,7,0,0,0,1`,
      '', '[Events]', 'Format: Layer, Start, End, Style, Name, MarginL, MarginR, MarginV, Effect, Text',
    ];
    const t = (sec) => {
      const cs = Math.max(0, Math.round(sec * 100));
      return `${Math.floor(cs / 360000)}:${String(Math.floor((cs % 360000) / 6000)).padStart(2, '0')}:${String(Math.floor((cs % 6000) / 100)).padStart(2, '0')}.${String(cs % 100).padStart(2, '0')}`;
    };
    const events = [];
    items.forEach((item, layer) => {
      const s = styleOf(item);
      const bx = item.box.x * width;
      const by = item.box.y * height;
      const bw = item.box.w * width;
      const bh = item.box.h * height;
      const size = Math.round(fontPx(item, bh));
      const an = s.align === 'left' ? 4 : s.align === 'right' ? 6 : 5;
      const px = s.align === 'left' ? bx + (s.bg ? size * 0.45 : 0) : s.align === 'right' ? bx + bw - (s.bg ? size * 0.45 : 0) : bx + bw / 2;
      const py = by + bh / 2;
      const fade = '\\fad(200,200)';
      const opacity = item.opacity ?? 1;
      const textAlpha = `&H${Math.round((1 - opacity) * 255).toString(16).padStart(2, '0').toUpperCase()}&`;
      // Background box drawn as a filled rectangle under the text.
      if (s.bg) {
        const r = Math.round(size * 0.25);
        const w = Math.round(bw);
        const h = Math.round(bh);
        const shape = `m ${r} 0 l ${w - r} 0 b ${w} 0 ${w} 0 ${w} ${r} l ${w} ${h - r} b ${w} ${h} ${w} ${h} ${w - r} ${h} l ${r} ${h} b 0 ${h} 0 ${h} 0 ${h - r} l 0 ${r} b 0 0 0 0 ${r} 0`;
        const bg = tagColor(s.bg);
        const a = Math.round(255 - (255 - parseInt(bg.alpha.slice(2, 4), 16)) * opacity).toString(16).padStart(2, '0').toUpperCase();
        events.push(`Dialogue: ${layer * 2},${t(item.start)},${t(item.end)},Text,,0,0,0,,{\\an7\\pos(${Math.round(bx)},${Math.round(by)})\\bord0\\shad0\\1c${bg.color}\\1a&H${a}&${fade}\\p1}${shape}{\\p0}`);
      }
      const lines = linesOf(item).map((line, i) => {
        if (item.style?.preset === 'lower' && i > 0) return `{\\fs${Math.round(size * 0.72)}\\c${tagColor(s.accent).color}\\b0}${esc(line)}`;
        if (item.style?.preset === 'title' && i > 0) return `{\\c${tagColor(s.accent).color}}${esc(line)}`;
        return esc(line);
      });
      const shadow = s.shadow ? `\\shad${Math.max(1, Math.round(size * 0.05))}\\4a&H60&` : '\\shad0';
      events.push(`Dialogue: ${layer * 2 + 1},${t(item.start)},${t(item.end)},Text,,0,0,0,,{\\an${an}\\pos(${Math.round(px)},${Math.round(py)})\\fs${size}\\b${s.weight >= 600 ? 1 : 0}\\c${tagColor(s.color).color}\\alpha${textAlpha}\\bord0${shadow}${fade}}${lines.join('\\N')}`);
    });
    return `${header.join('\n')}\n${events.join('\n')}\n`;
  }

  const api = { PRESETS, styleOf, tagColor, linesOf, fontPx, renderDom, buildAss };
  if (isNode) module.exports = api;
  else root.CutlineText = api;
})(typeof window !== 'undefined' ? window : globalThis);
