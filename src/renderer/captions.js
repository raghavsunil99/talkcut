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

  // Fonts: Noto Sans (SIL Open Font License, files in assets/fonts) on every platform, in the
  // preview and in the export, so a caption looks the same wherever it is made and no system
  // font has to exist. One family per script; Latin letters (the English words in code-mixed
  // speech) always use Noto Sans, because the script fonts have no Latin letters of their own.
  const LATIN_FONT = 'Noto Sans';
  const SCRIPT_FONTS = {
    te: 'Noto Sans Telugu',
    hi: 'Noto Sans Devanagari',
    mr: 'Noto Sans Devanagari',
    bn: 'Noto Sans Bengali',
    kn: 'Noto Sans Kannada',
    ta: 'Noto Sans Tamil',
    ml: 'Noto Sans Malayalam',
  };
  // Every font file the export needs, and the family each one provides. Static Regular and Bold
  // files, cut from Google's variable fonts by scripts/make-static-fonts.py: libass cannot pick a
  // weight inside a variable font and would draw everything regular.
  const FONT_FILES = {
    'NotoSans-Regular.ttf': 'Noto Sans',
    'NotoSans-Bold.ttf': 'Noto Sans',
    'NotoSansTelugu-Regular.ttf': 'Noto Sans Telugu',
    'NotoSansTelugu-Bold.ttf': 'Noto Sans Telugu',
    'NotoSansDevanagari-Regular.ttf': 'Noto Sans Devanagari',
    'NotoSansDevanagari-Bold.ttf': 'Noto Sans Devanagari',
    'NotoSansBengali-Regular.ttf': 'Noto Sans Bengali',
    'NotoSansBengali-Bold.ttf': 'Noto Sans Bengali',
    'NotoSansKannada-Regular.ttf': 'Noto Sans Kannada',
    'NotoSansKannada-Bold.ttf': 'Noto Sans Kannada',
    'NotoSansTamil-Regular.ttf': 'Noto Sans Tamil',
    'NotoSansTamil-Bold.ttf': 'Noto Sans Tamil',
    'NotoSansMalayalam-Regular.ttf': 'Noto Sans Malayalam',
    'NotoSansMalayalam-Bold.ttf': 'Noto Sans Malayalam',
  };

  // libass reads "font size" as the font's whole line height (usWinAscent + usWinDescent from the
  // font's OS/2 table), while CSS font-size is the em. To draw the same size as the preview, ASS
  // sizes are the CSS size times this factor. test/fonts.test.js recomputes the factors from the
  // font files, so they cannot go stale.
  const LINE_HEIGHT = {
    'Noto Sans': 1.519,
    'Noto Sans Telugu': 1.478,
    'Noto Sans Devanagari': 1.906,
    'Noto Sans Bengali': 1.403,
    'Noto Sans Kannada': 1.645,
    'Noto Sans Tamil': 1.24,
    'Noto Sans Malayalam': 1.247,
  };

  // ---------- how wide text is ----------
  //
  // Caption lines are filled up to a width, so text must be measured the way it looks. A count of
  // characters (UTF-16 code units) is close for English but treats a Telugu vowel sign or virama
  // as a letter of its own; a count of letters (grapheme clusters) treats every script alike,
  // but a Tamil or Malayalam letter is about twice as wide as an English one. So each letter is
  // weighted by its script's average width relative to English (a space counting as one English
  // letter), measured from the bundled fonts at caption weight; test/codemix.test.js measures
  // them again with libass, so these cannot go stale.
  const SCRIPT_WIDTH = { latin: 1, deva: 1.23, beng: 1.64, taml: 2.3, telu: 1.81, knda: 1.8, mlym: 2.44 };
  function scriptOf(ch) {
    const c = ch.codePointAt(0);
    if (c >= 0x0900 && c <= 0x097f) return 'deva';
    if (c >= 0x0980 && c <= 0x09ff) return 'beng';
    if (c >= 0x0b80 && c <= 0x0bff) return 'taml';
    if (c >= 0x0c00 && c <= 0x0c7f) return 'telu';
    if (c >= 0x0c80 && c <= 0x0cff) return 'knda';
    if (c >= 0x0d00 && c <= 0x0d7f) return 'mlym';
    return 'latin';
  }
  const segmenter = typeof Intl !== 'undefined' && Intl.Segmenter ? new Intl.Segmenter(undefined, { granularity: 'grapheme' }) : null;
  function graphemes(text) {
    return segmenter ? [...segmenter.segment(String(text))].map((s) => s.segment) : [...String(text)];
  }
  // How wide `text` looks, in English letters.
  function visualLength(text) {
    let n = 0;
    for (const g of graphemes(text)) n += SCRIPT_WIDTH[scriptOf(g)] ?? 1;
    return n;
  }

  // ASS font size that draws `family` at `px` CSS pixels.
  function assSize(family, px) {
    return Math.round(px * (LINE_HEIGHT[family] ?? LINE_HEIGHT[LATIN_FONT]) * 10) / 10;
  }

  // The font a language's captions use for its own script.
  function fontFor(language) {
    return SCRIPT_FONTS[language] ?? LATIN_FONT;
  }

  // CSS font stack for the preview. Noto Sans comes first so Latin letters always use it; the
  // script's font supplies the glyphs Noto Sans does not have.
  function fontStack(language) {
    const script = fontFor(language);
    return script === LATIN_FONT ? `"${LATIN_FONT}", sans-serif` : `"${LATIN_FONT}", "${script}", sans-serif`;
  }

  // ASS text with a font switch around each run that starts with a Latin letter or digit, when
  // the line's own font is a script font. libass would otherwise pick whatever system font has
  // the letters. Both fonts are given the size that draws `px` CSS pixels. `text` must already
  // be escaped for ASS.
  // `colors` ({ latin, text }), when given, also draws the English runs in their own colour.
  const LATIN_RUN = /[A-Za-z0-9\u00C0-\u024F][\u0000-\u024F\u2000-\u206F]*/g;
  function withFontRuns(text, language, px, colors = null) {
    const script = fontFor(language);
    if (script === LATIN_FONT) return text;
    const tint = colors ? `\\c${assColor(colors.latin)}` : '';
    const untint = colors ? `\\c${assColor(colors.text)}` : '';
    const back = `\\fn${script}\\fs${assSize(script, px)}${untint}`;
    return text.replace(LATIN_RUN, (run) => `{\\fn${LATIN_FONT}\\fs${assSize(LATIN_FONT, px)}${tint}}${run}{${back}}`);
  }

  // A word split into English (Latin-letter) runs and the rest, for the preview: [{ text, latin }].
  // In a caption whose language uses its own script, these are the runs withFontRuns switches.
  function latinRuns(text, language) {
    const s = String(text);
    if (fontFor(language) === LATIN_FONT) return [{ text: s, latin: false }];
    const out = [];
    let at = 0;
    for (const m of s.matchAll(LATIN_RUN)) {
      if (m.index > at) out.push({ text: s.slice(at, m.index), latin: false });
      out.push({ text: m[0], latin: true });
      at = m.index + m[0].length;
    }
    if (at < s.length) out.push({ text: s.slice(at), latin: false });
    return out;
  }

  // ---------- custom styles ----------
  //
  // A caption style is a built-in preset with some of its values changed. Settings keep the
  // preset id and, in `style`, only the values that differ; styleOf() resolves the two into one
  // object, which is what everything that draws or groups captions reads. A project stores the
  // resolved values, so it exports the same even if a saved style is later renamed or deleted.

  // Whole-line animations, the same in the preview (CSS transform) and the export (ASS \t):
  //   pop      the line springs in when it appears (70% → 108% → 100% over 0.2 s)
  //   grow     the line grows slowly from 100% to 108% while it is shown
  //   karaoke  each word fills with the highlight colour from left to right as it is spoken
  // Animating one word inside a line would push its neighbours sideways in libass but not in the
  // browser, so pop and grow move the whole line.
  const ANIMATIONS = { none: 'None', pop: 'Pop in', grow: 'Grow', karaoke: 'Karaoke fill' };
  const POP = { from: 0.7, over: 1.08, mid: 0.12, end: 0.2 }; // scale, seconds
  const GROW = 0.08;
  // Outline thickness choices, as a fraction of the font size.
  const OUTLINES = { none: 0, thin: 0.035, medium: 0.06, thick: 0.09 };
  const STYLE_KEYS = ['text', 'hi', 'outline', 'outlineW', 'box', 'upper', 'weight', 'maxWords', 'lines', 'animation', 'latin'];
  const HEX = /^#[0-9a-f]{6}$/i;

  // The values in `style` that are valid, everything else dropped.
  function cleanStyle(style) {
    const out = {};
    if (!style || typeof style !== 'object') return out;
    for (const k of ['text', 'hi', 'outline']) if (HEX.test(String(style[k]))) out[k] = String(style[k]).toUpperCase();
    // English words' own colour in an Indian-language caption, or null for the text colour.
    if (style.latin === null) out.latin = null;
    else if (HEX.test(String(style.latin))) out.latin = String(style.latin).toUpperCase();
    if (Number.isFinite(Number(style.outlineW))) out.outlineW = Math.min(0.15, Math.max(0, Number(style.outlineW)));
    if (style.box === null) out.box = null;
    else if (HEX.test(String(style.box))) out.box = hexToRgba(style.box, 0.72);
    else if (/^rgba\(\d+,\s*\d+,\s*\d+,\s*[\d.]+\)$/.test(String(style.box))) out.box = String(style.box);
    if (typeof style.upper === 'boolean') out.upper = style.upper;
    if (style.weight != null) out.weight = Number(style.weight) >= 700 ? 800 : 400;
    if (Number.isFinite(Number(style.maxWords))) out.maxWords = Math.min(12, Math.max(1, Math.round(Number(style.maxWords))));
    if (Number(style.lines) === 1 || Number(style.lines) === 2) out.lines = Number(style.lines);
    if (ANIMATIONS[style.animation]) out.animation = style.animation;
    return out;
  }

  function hexToRgba(hex, alpha) {
    const n = parseInt(String(hex).slice(1), 16);
    return `rgba(${(n >> 16) & 255},${(n >> 8) & 255},${n & 255},${alpha})`;
  }

  // The resolved style for caption settings (or a preset id).
  function styleOf(settings) {
    if (typeof settings === 'string' || settings == null) return { ...(PRESETS[settings] ?? PRESETS.highlight), lines: 1, animation: 'none', latin: null };
    if (settings.maxChars && settings.mode) return settings; // already resolved
    const base = PRESETS[settings.preset] ?? PRESETS.highlight;
    const style = { lines: 1, animation: 'none', latin: null, ...base, ...cleanStyle(settings.style) };
    // Karaoke fills the words one by one, so it needs the highlight colour and one line per group.
    if (style.animation === 'karaoke') style.mode = 'highlight';
    return style;
  }

  // The line's scale `o` seconds after its group appears, for a group shown `len` seconds.
  // The preview calls this every frame; the export writes the same curve as ASS \\t tags.
  function lineScale(style, o, len) {
    if (style.animation === 'pop') {
      if (o <= 0) return POP.from;
      if (o < POP.mid) return POP.from + ((POP.over - POP.from) * o) / POP.mid;
      if (o < POP.end) return POP.over + ((1 - POP.over) * (o - POP.mid)) / (POP.end - POP.mid);
      return 1;
    }
    if (style.animation === 'grow') return 1 + (GROW * Math.min(1, Math.max(0, o / Math.max(0.01, len))));
    return 1;
  }

  // True when the settings change the preset's look (so the panel says "Custom").
  function isCustom(settings) {
    return Object.keys(cleanStyle(settings?.style)).length > 0;
  }

  function settingsOf(s) {
    const out = { ...DEFAULTS, ...(s || {}) };
    out.style = cleanStyle(out.style);
    if (!Object.keys(out.style).length) delete out.style;
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
  // or when it reaches the preset's word or character limit. `ends` (optional, from
  // Edits.pieceEnds) says where each word's piece of the recording ends: after words have been
  // moved, a group never runs across a join.
  function groupWords(words, deleted, presetId, ends = null) {
    // `presetId` may also be caption settings or a resolved style. With two lines a group holds
    // twice as many words and characters, and breakLines() splits it.
    const p0 = styleOf(presetId);
    const p = { ...p0, maxWords: p0.maxWords * (p0.lines || 1), maxChars: p0.maxChars * (p0.lines || 1) };
    const groups = [];
    let cur = [];
    let chars = 0;
    const flush = () => { if (cur.length) groups.push(cur); cur = []; chars = 0; };
    words.forEach((w, i) => {
      if (deleted.has(i)) return;
      const prevIndex = cur.length ? cur[cur.length - 1] : -1;
      const prev = prevIndex >= 0 ? words[prevIndex] : null;
      const width = visualLength(w.text);
      if (prev && (w.start - prev.end > 0.7 || w.start < prev.start || (ends && ends[i] !== ends[prevIndex]) || cur.length >= p.maxWords || chars + width + 1 > p.maxChars)) flush();
      cur.push(i);
      chars += width + 1;
      if (/[.!?।]["')\]]?$/.test(w.text)) flush();
    });
    flush();
    return groups;
  }

  // Where a two-line group breaks: the word index (within the group) that starts line two, or -1.
  // The break balances the two lines' length in characters. Preview and export both use it, so
  // they break at the same word whatever their own wrapping would do.
  function breakAt(texts, style) {
    if ((style.lines || 1) < 2 || texts.length < 2) return -1;
    const total = texts.reduce((n, t) => n + visualLength(t) + 1, 0);
    if (texts.length <= style.maxWords && total <= style.maxChars + 1) return -1; // fits on one line
    let best = -1;
    let bestDiff = Infinity;
    let left = 0;
    for (let k = 1; k < texts.length; k++) {
      left += visualLength(texts[k - 1]) + 1;
      const diff = Math.abs(left - (total - left));
      if (diff < bestDiff) { best = k; bestDiff = diff; }
    }
    return best;
  }

  // Caption timing on the source timeline: a group shows from its first word until the next
  // group starts, but no longer than 0.6 s after its last word.
  // At a join the next group is somewhere else in the recording, so the group ends with its piece.
  function groupSpans(groups, words, ends = null) {
    return groups.map((g, k) => {
      const start = words[g[0]].start;
      const last = g[g.length - 1];
      const lastEnd = Math.max(words[last].end, words[last].start + 0.2);
      const nextStart = groups[k + 1] ? words[groups[k + 1][0]].start : Infinity;
      const joined = groups[k + 1] && (nextStart < start || (ends && ends[groups[k + 1][0]] !== ends[last]));
      const limit = ends ? Math.max(ends[last], start + 0.05) : Infinity;
      return { words: g, start, end: Math.min(joined ? Infinity : nextStart, lastEnd + 0.6, limit) };
    });
  }

  // What to show at source time t: the group and the index of the word being spoken.
  // Spans are in play order; the search runs over them sorted by source time.
  const sortedSpans = new WeakMap();
  function activeAt(spans, words, t) {
    let list = sortedSpans.get(spans);
    if (!list) {
      list = spans.every((sp, n) => n === 0 || sp.start >= spans[n - 1].start) ? spans : spans.slice().sort((a, b) => a.start - b.start);
      sortedSpans.set(spans, list);
    }
    let lo = 0;
    let hi = list.length - 1;
    while (lo <= hi) {
      const mid = (lo + hi) >> 1;
      if (t < list[mid].start) hi = mid - 1;
      else if (t >= list[mid].end) lo = mid + 1;
      else {
        const span = list[mid];
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
  // `toEdited(t, end)` maps source time to edited time (end: t is where something stops);
  // speed is the clip's playback speed; `ends` is Edits.pieceEnds when words have been moved.
  function buildSubtitles({ words, deleted, settings, toEdited, speed = 1, format = 'srt', ends = null }) {
    const s = settingsOf(settings);
    const style = styleOf(s);
    const spans = groupSpans(groupWords(words, deleted, style, ends), words, ends);
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
      const end = toEdited(span.end, true);
      if (end - start < 0.05) continue;
      const texts = span.words.map((i) => words[i].text.trim());
      const at = breakAt(texts, style);
      const text = texts.map((t, k) => (k === at ? `\n${t}` : (k ? ` ${t}` : t))).join('').replace(/[ \t]+/g, ' ').trim();
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
  function buildAss({ words, deleted, settings, language, width, height, toEdited, ends = null }) {
    const s = settingsOf(settings);
    const p = styleOf(s);
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
      // 1: break lines greedily, like the preview (0 balances line lengths, so the two break differently)
      'WrapStyle: 1',
      'ScaledBorderAndShadow: yes',
      '',
      '[V4+ Styles]',
      'Format: Name, Fontname, Fontsize, PrimaryColour, SecondaryColour, OutlineColour, BackColour, Bold, Italic, Underline, StrikeOut, ScaleX, ScaleY, Spacing, Angle, BorderStyle, Outline, Shadow, Alignment, MarginL, MarginR, MarginV, Encoding',
      `Style: Cap,${fontFor(language)},${assSize(fontFor(language), fontSize)},${assColor(p.text)},${assColor(p.hi)},${outlineColour},&H96000000,${p.weight >= 700 ? -1 : 0},0,0,0,100,100,0,0,${borderStyle},${boxOutline},${p.box ? 0 : shadow},${align},${marginH},${marginH},${marginV},1`,
      '',
      '[Events]',
      'Format: Layer, Start, End, Style, Name, MarginL, MarginR, MarginV, Effect, Text',
    ];

    const events = [];
    const spans = groupSpans(groupWords(words, deleted, p, ends), words, ends);
    const ms = (sec) => Math.max(0, Math.round(sec * 1000));
    for (const span of spans) {
      const texts = span.words.map((i) => words[i].text);
      const brk = breakAt(texts, p);
      const join = (parts) => parts.map((t, k) => (k === brk ? `\\N${t}` : (k ? ` ${t}` : t))).join('');
      // English words in their own colour, when the style asks for it (not on the spoken word,
      // which takes the highlight colour, and not in karaoke, which fills every word).
      const latinColors = p.latin && p.animation !== 'karaoke' ? { latin: p.latin, text: p.text } : null;
      const line = (current) => join(span.words.map((i) => {
        const spoken = p.mode === 'highlight' && i === current && p.hi !== p.text;
        const text = withFontRuns(assEscape(displayText(words[i].text, p)), language, fontSize, spoken ? null : latinColors);
        if (p.mode !== 'highlight' || i !== current || p.hi === p.text) return text;
        return `{\\c${assColor(p.hi)}}${text}{\\c${assColor(p.text)}}`;
      }));
      const spanA = toEdited(span.start);
      const spanB = toEdited(span.end, true);
      // The whole-line animation for an event running from edited time a to b.
      const motion = (a, b) => {
        if (p.animation === 'pop') {
          // Keyframes of the scale after the group appears, from where this event starts.
          const o = a - spanA;
          if (o >= POP.end) return '';
          const keys = [[0, POP.from], [POP.mid, POP.over], [POP.end, 1]];
          const pc = (x) => Math.round(x * 1000) / 10;
          let tags = `\\fscx${pc(lineScale(p, o, 1))}\\fscy${pc(lineScale(p, o, 1))}`;
          let prev = o;
          for (const [t, v] of keys) {
            if (t <= o) continue;
            tags += `\\t(${ms(prev - o)},${ms(t - o)},\\fscx${pc(v)}\\fscy${pc(v)})`;
            prev = t;
          }
          return `{${tags}}`;
        }
        if (p.animation === 'grow') {
          const len = Math.max(0.01, spanB - spanA);
          const s0 = Math.round((1 + (GROW * (a - spanA)) / len) * 1000) / 10;
          const s1 = Math.round((1 + (GROW * (b - spanA)) / len) * 1000) / 10;
          return `{\\fscx${s0}\\fscy${s0}\\t(0,${ms(b - a)},\\fscx${s1}\\fscy${s1})}`;
        }
        return '';
      };
      if (p.animation === 'karaoke') {
        // One event per group: each word fills from the text colour to the highlight colour over
        // the time until the next word starts (edited time, so cut pauses inside it shorten it).
        if (spanB - spanA <= 0.02) continue;
        let used = 0;
        const parts = span.words.map((i, k) => {
          const until = k === span.words.length - 1 ? toEdited(Math.max(words[i].end, words[i].start), true) : toEdited(words[span.words[k + 1]].start);
          const cs = Math.max(1, Math.round((until - spanA) * 100) - used);
          used += cs;
          return `{\\kf${cs}}${withFontRuns(assEscape(displayText(words[i].text, p)), language, fontSize)}`;
        });
        events.push(`Dialogue: 0,${assTime(spanA)},${assTime(spanB)},Cap,,0,0,0,,${pos}{\\1c${assColor(p.hi)}\\2c${assColor(p.text)}}${join(parts)}`);
        continue;
      }
      if (p.mode === 'line' || p.hi === p.text) {
        if (spanB - spanA > 0.02) events.push(`Dialogue: 0,${assTime(spanA)},${assTime(spanB)},Cap,,0,0,0,,${pos}${motion(spanA, spanB)}${line(-1)}`);
        continue;
      }
      // One event per spoken word, so the highlight moves with the speech.
      span.words.forEach((i, k) => {
        const from = k === 0 ? span.start : words[i].start;
        const to = k === span.words.length - 1 ? span.end : words[span.words[k + 1]].start;
        const a = toEdited(from);
        const b = toEdited(to, true);
        if (b - a > 0.02) events.push(`Dialogue: 0,${assTime(a)},${assTime(b)},Cap,,0,0,0,,${pos}${motion(a, b)}${line(i)}`);
      });
    }
    return `${header.join('\n')}\n${events.join('\n')}\n`;
  }

  const api = { PRESETS, SIZES, POSITIONS, DEFAULTS, SCRIPT_WIDTH, scriptOf, graphemes, visualLength, latinRuns, ANIMATIONS, POP, GROW, OUTLINES, STYLE_KEYS, cleanStyle, styleOf, isCustom, breakAt, lineScale, hexToRgba, SCRIPT_FONTS, FONT_FILES, LINE_HEIGHT, LATIN_FONT, fontFor, fontStack, assSize, withFontRuns, fontPx, settingsOf, groupWords, groupSpans, activeAt, displayText, buildAss, buildSubtitles, assColor, assTime };
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  else root.CutlineCaptions = api;
})(typeof window !== 'undefined' ? window : globalThis);
