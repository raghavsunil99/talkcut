// Caption styles, word grouping and ASS subtitle generation. Shared by the live preview
// (renderer) and the export (main process) so both show the same thing.
(function (root) {
  const PRESETS = {
    highlight: {
      label: 'Highlight', maxWords: 4, maxChars: 24, mode: 'highlight', upper: false,
      text: '#FFFFFF', hi: '#FFD84D', outline: '#000000', outlineW: 0.06, shadow: 0.025, box: null, size: 0.075, weight: 800,
    },
    oneword: {
      label: 'One word', maxWords: 1, maxChars: 40, mode: 'highlight', upper: true,
      text: '#FFD84D', hi: '#FFD84D', outline: '#000000', outlineW: 0.08, shadow: 0.03, box: null, size: 0.11, weight: 900,
    },
    red: {
      label: 'Bold red', maxWords: 3, maxChars: 20, mode: 'highlight', upper: true,
      text: '#FFFFFF', hi: '#FF4D4D', outline: '#000000', outlineW: 0.07, shadow: 0.03, box: null, size: 0.08, weight: 900,
    },
    boxed: {
      label: 'Boxed', maxWords: 5, maxChars: 28, mode: 'highlight', upper: false,
      text: '#FFFFFF', hi: '#8EA2FF', outline: '#000000', outlineW: 0, shadow: 0, box: 'rgba(12,12,16,0.72)', size: 0.062, weight: 700,
    },
    clean: {
      label: 'Clean', maxWords: 5, maxChars: 28, mode: 'highlight', upper: false,
      text: '#FFFFFF', hi: '#5BE38B', outline: '#000000', outlineW: 0.0, shadow: 0.05, box: null, size: 0.065, weight: 700,
    },
    subtitle: {
      label: 'Subtitle', maxWords: 9, maxChars: 40, mode: 'line', upper: false,
      text: '#FFFFFF', hi: '#FFFFFF', outline: '#000000', outlineW: 0.035, shadow: 0.02, box: null, size: 0.05, weight: 600,
    },
  };

  const SIZES = { small: 0.8, medium: 1, large: 1.25 };
  const POSITIONS = { bottom: 'Bottom', middle: 'Middle', top: 'Top' };
  // position 'custom' places the caption's centre at (x, y), fractions of the frame, after
  // it was dragged on the video; scale multiplies the size (resized on the video).
  const DEFAULTS = { enabled: false, preset: 'highlight', position: 'bottom', size: 'medium', x: 0.5, y: 0.75, scale: 1 };

  // Fonts that cover each script; macOS ships all of these. Their Latin letters cover the
  // English words in code-mixed speech.
  const SCRIPT_FONTS = {
    te: 'Kohinoor Telugu',
    hi: 'Kohinoor Devanagari',
    mr: 'Kohinoor Devanagari',
    bn: 'Kohinoor Bangla',
    kn: 'Noto Sans Kannada',
    ta: 'Tamil Sangam MN',
    ml: 'Malayalam Sangam MN',
  };
  const LATIN_FONT = 'Avenir Next';

  function fontFor(language) {
    return SCRIPT_FONTS[language] ?? LATIN_FONT;
  }

  function settingsOf(s) {
    const out = { ...DEFAULTS, ...(s || {}) };
    if (!PRESETS[out.preset]) out.preset = DEFAULTS.preset;
    if (!SIZES[out.size]) out.size = DEFAULTS.size;
    if (!POSITIONS[out.position] && out.position !== 'custom') out.position = DEFAULTS.position;
    const num = (v, lo, hi, d) => (Number.isFinite(Number(v)) ? Math.min(hi, Math.max(lo, Number(v))) : d);
    out.x = num(out.x, 0, 1, DEFAULTS.x);
    out.y = num(out.y, 0, 1, DEFAULTS.y);
    out.scale = num(out.scale, 0.3, 3, 1);
    return out;
  }

  // Font size in pixels for a frame of this size.
  function fontPx(settings, width, height) {
    const s = settingsOf(settings);
    return PRESETS[s.preset].size * SIZES[s.size] * s.scale * Math.min(width, height);
  }

  // Split kept words into short caption groups: a group ends at a sentence end, a pause,
  // or when it reaches the preset's word or character limit.
  function groupWords(words, deleted, presetId) {
    const p = PRESETS[presetId] ?? PRESETS.highlight;
    const groups = [];
    let cur = [];
    let chars = 0;
    const flush = () => { if (cur.length) groups.push(cur); cur = []; chars = 0; };
    words.forEach((w, i) => {
      if (deleted.has(i)) return;
      const prev = cur.length ? words[cur[cur.length - 1]] : null;
      if (prev && (w.start - prev.end > 0.7 || cur.length >= p.maxWords || chars + w.text.length + 1 > p.maxChars)) flush();
      cur.push(i);
      chars += w.text.length + 1;
      if (/[.!?।]["')\]]?$/.test(w.text)) flush();
    });
    flush();
    return groups;
  }

  // Caption timing on the source timeline: a group shows from its first word until the next
  // group starts, but no longer than 0.6 s after its last word.
  function groupSpans(groups, words) {
    return groups.map((g, k) => {
      const start = words[g[0]].start;
      const lastEnd = Math.max(words[g[g.length - 1]].end, words[g[g.length - 1]].start + 0.2);
      const next = groups[k + 1] ? words[groups[k + 1][0]].start : Infinity;
      return { words: g, start, end: Math.min(next, lastEnd + 0.6) };
    });
  }

  // What to show at source time t: the group and the index of the word being spoken.
  function activeAt(spans, words, t) {
    let lo = 0;
    let hi = spans.length - 1;
    while (lo <= hi) {
      const mid = (lo + hi) >> 1;
      if (t < spans[mid].start) hi = mid - 1;
      else if (t >= spans[mid].end) lo = mid + 1;
      else {
        const span = spans[mid];
        let current = span.words[0];
        for (const i of span.words) if (words[i].start <= t) current = i;
        return { span, current };
      }
    }
    return null;
  }

  function displayText(text, preset) {
    return preset.upper ? text.toUpperCase() : text;
  }

  // ---------- subtitle files ----------

  // SRT or WebVTT for the edited video: the same caption groups as the burned-in captions.
  // `toEdited` maps source time to edited time; speed is the clip's playback speed.
  function buildSubtitles({ words, deleted, settings, toEdited, speed = 1, format = 'srt' }) {
    const s = settingsOf(settings);
    const spans = groupSpans(groupWords(words, deleted, s.preset), words);
    const stamp = (t) => {
      const ms = Math.max(0, Math.round((t / speed) * 1000));
      const hh = String(Math.floor(ms / 3600000)).padStart(2, '0');
      const mm = String(Math.floor((ms % 3600000) / 60000)).padStart(2, '0');
      const ss = String(Math.floor((ms % 60000) / 1000)).padStart(2, '0');
      return `${hh}:${mm}:${ss}${format === 'vtt' ? '.' : ','}${String(ms % 1000).padStart(3, '0')}`;
    };
    const cues = [];
    for (const span of spans) {
      const start = toEdited(span.start);
      const end = toEdited(span.end);
      if (end - start < 0.05) continue;
      const text = span.words.map((i) => words[i].text.trim()).join(' ').replace(/\s+/g, ' ').trim();
      if (text) cues.push({ start, end, text });
    }
    const body = cues.map((c, n) => `${format === 'srt' ? `${n + 1}\n` : ''}${stamp(c.start)} --> ${stamp(c.end)}\n${c.text}\n`).join('\n');
    return format === 'vtt' ? `WEBVTT\n\n${body}` : body;
  }

  // ---------- ASS ----------

  function assColor(hex, alpha = 0) {
    const m = /^#?([0-9a-f]{2})([0-9a-f]{2})([0-9a-f]{2})$/i.exec(hex);
    const [r, g, b] = m ? [m[1], m[2], m[3]] : ['FF', 'FF', 'FF'];
    return `&H${alpha.toString(16).padStart(2, '0').toUpperCase()}${b}${g}${r}`.toUpperCase();
  }

  function assBoxColor(rgba) {
    const m = /rgba\((\d+),\s*(\d+),\s*(\d+),\s*([\d.]+)\)/.exec(rgba || '');
    if (!m) return '&H80000000';
    const hex = (n) => Number(n).toString(16).padStart(2, '0').toUpperCase();
    return `&H${hex(Math.round((1 - Number(m[4])) * 255))}${hex(m[3])}${hex(m[2])}${hex(m[1])}`;
  }

  function assTime(t) {
    const cs = Math.max(0, Math.round(t * 100));
    const h = Math.floor(cs / 360000);
    const m = Math.floor((cs % 360000) / 6000);
    const s = Math.floor((cs % 6000) / 100);
    return `${h}:${String(m).padStart(2, '0')}:${String(s).padStart(2, '0')}.${String(cs % 100).padStart(2, '0')}`;
  }

  function assEscape(text) {
    return text.replace(/\\/g, '＼').replace(/[{}]/g, (c) => (c === '{' ? '(' : ')')).replace(/\n/g, ' ');
  }

  // Full ASS document for the edited video. `toEdited` maps source time to edited time.
  function buildAss({ words, deleted, settings, language, width, height, toEdited }) {
    const s = settingsOf(settings);
    const p = PRESETS[s.preset];
    const short = Math.min(width, height);
    const fontSize = Math.round(fontPx(s, width, height));
    const custom = s.position === 'custom';
    const pos = custom ? `{\\an5\\pos(${Math.round(s.x * width)},${Math.round(s.y * height)})}` : '';
    const outline = Math.round(p.outlineW * fontSize * 10) / 10;
    const shadow = Math.round(p.shadow * fontSize * 10) / 10;
    const align = custom ? 5 : s.position === 'top' ? 8 : s.position === 'middle' ? 5 : 2;
    const marginV = s.position === 'middle' ? 0 : Math.round(height * (s.position === 'top' ? 0.12 : 0.16));
    const marginH = Math.round(width * 0.08);
    const borderStyle = p.box ? 3 : 1;
    const outlineColour = p.box ? assBoxColor(p.box) : assColor(p.outline);
    const boxOutline = p.box ? Math.round(fontSize * 0.28) : outline;

    const header = [
      '[Script Info]',
      'ScriptType: v4.00+',
      `PlayResX: ${width}`,
      `PlayResY: ${height}`,
      'WrapStyle: 0',
      'ScaledBorderAndShadow: yes',
      '',
      '[V4+ Styles]',
      'Format: Name, Fontname, Fontsize, PrimaryColour, SecondaryColour, OutlineColour, BackColour, Bold, Italic, Underline, StrikeOut, ScaleX, ScaleY, Spacing, Angle, BorderStyle, Outline, Shadow, Alignment, MarginL, MarginR, MarginV, Encoding',
      `Style: Cap,${fontFor(language)},${fontSize},${assColor(p.text)},${assColor(p.hi)},${outlineColour},&H96000000,${p.weight >= 700 ? -1 : 0},0,0,0,100,100,0,0,${borderStyle},${boxOutline},${p.box ? 0 : shadow},${align},${marginH},${marginH},${marginV},1`,
      '',
      '[Events]',
      'Format: Layer, Start, End, Style, Name, MarginL, MarginR, MarginV, Effect, Text',
    ];

    const events = [];
    const spans = groupSpans(groupWords(words, deleted, s.preset), words);
    for (const span of spans) {
      const line = (current) => span.words.map((i) => {
        const text = assEscape(displayText(words[i].text, p));
        if (p.mode !== 'highlight' || i !== current || p.hi === p.text) return text;
        return `{\\c${assColor(p.hi)}}${text}{\\c${assColor(p.text)}}`;
      }).join(' ');
      if (p.mode === 'line' || p.hi === p.text) {
        const a = toEdited(span.start);
        const b = toEdited(span.end);
        if (b - a > 0.02) events.push(`Dialogue: 0,${assTime(a)},${assTime(b)},Cap,,0,0,0,,${pos}${line(-1)}`);
        continue;
      }
      // One event per spoken word, so the highlight moves with the speech.
      span.words.forEach((i, k) => {
        const from = k === 0 ? span.start : words[i].start;
        const to = k === span.words.length - 1 ? span.end : words[span.words[k + 1]].start;
        const a = toEdited(from);
        const b = toEdited(to);
        if (b - a > 0.02) events.push(`Dialogue: 0,${assTime(a)},${assTime(b)},Cap,,0,0,0,,${pos}${line(i)}`);
      });
    }
    return `${header.join('\n')}\n${events.join('\n')}\n`;
  }

  const api = { PRESETS, SIZES, POSITIONS, DEFAULTS, SCRIPT_FONTS, LATIN_FONT, fontFor, fontPx, settingsOf, groupWords, groupSpans, activeAt, displayText, buildAss, buildSubtitles, assColor, assTime };
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  else root.CutlineCaptions = api;
})(typeof window !== 'undefined' ? window : globalThis);
