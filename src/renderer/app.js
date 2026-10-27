/* global CutlineEdits, CutlineCaptions, CutlineTimeline, CutlinePanels, CutlineFrame, CutlineProperties, CutlineHome, CutlineTracks, CutlineCanvas, cutline */
(() => {
  const E = CutlineEdits;
  const C = CutlineCaptions;
  const F = CutlineFrame;
  const T = CutlineTracks;
  // file:// URL for a local path (Windows paths become file:///C:/...).
  const fileUrl = (p) => {
    const posix = p.replace(/\\/g, '/');
    return `file://${posix.startsWith('/') ? '' : '/'}${encodeURI(posix).replace(/#/g, '%23').replace(/\?/g, '%3F')}`;
  };
  const baseName = (p) => p.split(/[\\/]/).pop();

  // Windows: Ctrl instead of ⌘ in every label, hint and message, and PC words instead of Mac ones.
  const IS_MOBILE = cutline.platform === 'android';
  const IS_WIN = cutline.platform === 'win32';
  document.documentElement.dataset.platform = cutline.platform;
  function forPlatform(text) {
    if (!text) return text;
    if (IS_MOBILE) {
      return String(text)
        .replace(/Keys are stored encrypted on this Mac/g, 'Keys are kept on this phone only')
        .replace(/transcribes it on this Mac/g, 'transcribes it with ElevenLabs')
        .replace(/ on this Mac/g, ' on this phone').replace(/this Mac/g, 'this phone')
        .replace(/\bClick /g, 'Tap ').replace(/\bclick /g, 'tap ').replace(/double-click/g, 'double-tap')
        .replace(/ \((?:⇧|⌥)?⌘[^)]*\)/g, '').replace(/(?:⇧|⌥)?⌘\S+/g, '').replace(/Ctrl\+\S+/g, '');
    }
    if (!IS_WIN) return text;
    return String(text)
      .replace(/⇧⌘/g, 'Ctrl+Shift+').replace(/⌥⌘/g, 'Ctrl+Alt+').replace(/⌘/g, 'Ctrl+')
      .replace(/⇧/g, 'Shift+').replace(/⌥/g, 'Alt+')
      .replace(/Show in Finder/g, 'Show in File Explorer').replace(/Finder/g, 'File Explorer')
      .replace(/this Mac/g, 'this PC').replace(/your Mac/g, 'your PC').replace(/Match Mac/g, 'Match Windows');
  }
  function localize(rootEl) {
    if (!IS_WIN && !IS_MOBILE) return;
    const walk = document.createTreeWalker(rootEl, NodeFilter.SHOW_TEXT);
    for (let n = walk.nextNode(); n; n = walk.nextNode()) {
      const t = forPlatform(n.nodeValue);
      if (t !== n.nodeValue) n.nodeValue = t;
    }
    const els2 = rootEl.querySelectorAll ? [rootEl, ...rootEl.querySelectorAll('[title], [placeholder]')] : [];
    for (const el of els2) {
      if (el.title) { const t = forPlatform(el.title); if (t !== el.title) el.title = t; }
      if (el.placeholder) { const t = forPlatform(el.placeholder); if (t !== el.placeholder) el.placeholder = t; }
    }
  }
  if (IS_WIN || IS_MOBILE) {
    localize(document.body);
    new MutationObserver((list) => {
      for (const m of list) for (const n of m.addedNodes) localize(n.nodeType === 1 ? n : n.parentNode ?? document.body);
    }).observe(document.body, { childList: true, subtree: true });
  }
  const $ = (id) => document.getElementById(id);

  const els = {
    empty: $('empty'),
    transcriptWrap: $('transcript-wrap'),
    transcript: $('transcript'),
    docTitle: $('doc-title'),
    docLanguage: $('doc-language'),
    player: $('player'),
    video: $('video'),
    layers: $('overlay-layers'),
    captionLayer: $('caption-layer'),
    audioArt: $('audio-art'),
    audioName: $('audio-name'),
    play: $('btn-play'),
    back: $('btn-back'),
    fwd: $('btn-fwd'),
    speed: $('speed'),
    timeCurrent: $('time-current'),
    timeTotal: $('time-total'),
    statOriginal: $('stat-original'),
    statEdited: $('stat-edited'),
    statCut: $('stat-cut'),
    language: $('language'),
    quality: $('quality'),
    overlay: $('overlay'),
    overlayTitle: $('overlay-title'),
    overlayDetail: $('overlay-detail'),
    overlayBar: $('overlay-bar'),
    toast: $('toast'),
    dropHint: $('drop-hint'),
    buttons: {
      open: $('btn-open'),
      openEmpty: $('btn-open-empty'),
      openProject: $('btn-open-project'),
      save: $('btn-save'),
      cut: $('btn-cut'),
      restore: $('btn-restore'),
      fillers: $('btn-fillers'),
      retakes: $('btn-retakes'),
      pauses: $('btn-pauses'),
      undo: $('btn-undo'),
      redo: $('btn-redo'),
      export: $('btn-export'),
    },
  };

  const state = {
    media: null, // { path, url, name, duration, hasVideo, hasAudio, width, height }
    words: [],
    language: null, // what the transcript is in, e.g. 'te'
    speakers: {}, // speaker id -> name, when words are labelled
    deleted: new Set(),
    cutGaps: new Set(), // pauses shortened, keyed like CutlineEdits.gaps
    // B-roll laid over the picture. `start` is a time in the original media, so a clip stays
    // with the words under it when other parts are cut; `length` is seconds of edited video.
    tracks: [], // overlay and audio tracks, see tracks.js
    captions: C.settingsOf(null),
    clip: F.normalize(null), // speed, audio, frame, size, position, rotation, crop
    splits: [], // blade splits, source seconds
    rangeCuts: [], // exact time cuts from the Range and Blade tools, source seconds
    rangeSel: null, // selected [start, end] on the timeline, source seconds
    tool: 'select',
    cuts: [],
    kept: [],
    captionSpans: [],
    undo: [],
    redo: [],
    anchor: -1,
    focus: -1,
    gapSel: null,
    itemSel: null, // selected track item id
    mainSel: false, // main video selected on the canvas
    caret: null, // text cursor: index of the word it sits before (words.length = after the last)
    textVersion: 0, // bumps whenever words or cuts change, so the transcript re-renders
    projectPath: null,
    dirty: false,
    busy: false,
    nowIndex: -1,
    loadToken: 0,
  };
  let spans = []; // word index -> visible span (null for cut words)
  let canvasEditor = null; // created with the canvas section below
  let renderedVersion = -1;
  const languageNames = {};

  // ---------- helpers ----------

  function fmt(seconds) {
    if (!Number.isFinite(seconds)) return '—';
    const s = Math.max(0, seconds);
    const h = Math.floor(s / 3600);
    const m = Math.floor((s % 3600) / 60);
    const sec = Math.floor(s % 60);
    return h ? `${h}:${String(m).padStart(2, '0')}:${String(sec).padStart(2, '0')}` : `${m}:${String(sec).padStart(2, '0')}`;
  }

  function fmtTenths(seconds) {
    const s = Math.max(0, seconds || 0);
    return `${fmt(Math.floor(s))}.${Math.floor((s * 10) % 10)}`;
  }

  let toastTimer = null;
  function toast(message, { error = false, ms = 4000 } = {}) {
    els.toast.textContent = forPlatform(message);
    els.toast.classList.toggle('error', error);
    els.toast.hidden = false;
    clearTimeout(toastTimer);
    toastTimer = setTimeout(() => { els.toast.hidden = true; }, ms);
  }

  function showError(err) {
    const msg = String(err?.message ?? err).replace(/^Error invoking remote method '[^']+': (Error: )?/, '');
    toast(msg, { error: true, ms: 7000 });
  }

  function showOverlay(title, detail = '', progress = null) {
    els.overlay.hidden = false;
    els.overlayTitle.textContent = title;
    els.overlayDetail.textContent = detail;
    const bar = els.overlayBar.parentElement;
    bar.classList.toggle('indeterminate', progress == null);
    els.overlayBar.style.width = progress == null ? '' : `${Math.round(progress * 100)}%`;
  }

  function hideOverlay() { els.overlay.hidden = true; }

  function selectionRange() {
    if (state.anchor < 0 || state.focus < 0) return null;
    return [Math.min(state.anchor, state.focus), Math.max(state.anchor, state.focus)];
  }

  // A project is open once its media is loaded; the transcript is optional.
  function hasProject() { return !!state.media && !state.loadingMedia; }

  function duration() {
    return state.media?.duration || els.video.duration || 0;
  }

  function editedLength() {
    return E.totalLength(state.kept);
  }

  function projectName() {
    return state.projectPath ? baseName(state.projectPath).replace(/\.(talkcut|cutline)$/, '') : state.media?.name.replace(/\.[^.]+$/, '') ?? 'Talkcut';
  }

  function setSaveStatus(text, unsaved = false) {
    const el = $('save-status');
    el.hidden = !text;
    el.textContent = text;
    el.classList.toggle('unsaved', unsaved);
  }

  // Projects save themselves a moment after each change.
  let autosaveTimer = null;
  function setDirty(dirty) {
    state.dirty = dirty;
    cutline.setDirty(dirty, Boolean(state.projectPath));
    document.title = `${dirty ? '• ' : ''}${state.media ? projectName() : 'Talkcut'} — Talkcut by Raghav`;
    clearTimeout(autosaveTimer);
    if (!state.media) { setSaveStatus(''); return; }
    if (!dirty) { setSaveStatus(state.projectPath ? 'Saved' : ''); return; }
    if (state.projectPath) {
      setSaveStatus('Editing…');
      autosaveTimer = setTimeout(() => autosave(), 1500);
    } else {
      setSaveStatus('Not saved', true);
    }
  }

  let saving = null;
  async function autosave() {
    if (!state.projectPath || !hasProject()) return;
    if (state.busy) { autosaveTimer = setTimeout(() => autosave(), 1500); return; }
    if (saving) await saving;
    setSaveStatus('Saving…');
    saving = cutline.saveProject(buildProject(), state.projectPath, false, true)
      .then(() => { if (!autosaveTimer || state.dirty) setDirty(false); })
      .catch((err) => { setSaveStatus('Not saved', true); showError(err); })
      .finally(() => { saving = null; });
    await saving;
  }

  function itemCount() {
    return state.tracks.reduce((n, t) => n + t.items.length, 0);
  }

  // ---------- timeline and sidebar ----------

  const timeline = new CutlineTimeline($('timeline'), {
    onBlade: (t) => {
      if (!hasProject()) return;
      const splits = [...new Set([...state.splits, Math.round(t * 1000) / 1000])].sort((a, b) => a - b);
      commit({ splits });
      toast(`Split at ${fmtTenths(E.toEdited(state.kept, t))}. With Select (A), click a piece of the clip and press ⌫ to remove it.`, { ms: 5000 });
    },
    onSelectRange: (a, b) => {
      clearSelection();
      state.rangeSel = [a, b];
      refresh();
      seek(a);
    },
    onSelectSegment: (t) => {
      clearSelection();
      state.rangeSel = E.segmentAt(state.splits, t, duration());
      refresh();
      seek(state.rangeSel[0]);
    },
    onSeek: (t) => {
      clearSelection();
      seek(t);
    },
    onSelectWord: (i, shift) => {
      state.gapSel = null;
      state.itemSel = null;
      if (shift && state.anchor >= 0) setSelection(state.anchor, i);
      else setSelection(i);
      seek(state.words[i].start);
      keepVisible(spans[i]);
    },
    onSelectGap: (i) => {
      state.anchor = state.focus = -1;
      state.itemSel = null;
      state.gapSel = i;
      refresh();
      const gap = E.gaps(state.words, duration()).find((g) => g.i === i);
      if (gap) seek(gap.start);
    },
    onSelectItem: (id) => {
      state.anchor = state.focus = -1;
      state.gapSel = null;
      state.rangeSel = null;
      state.itemSel = id;
      const kind = id ? T.find(state.tracks, id)?.item.kind : null;
      if (kind === 'text') openRailPanel('elements');
      else if (id) openRailPanel('properties');
      refresh();
    },
    onSelectCaption: (span) => {
      state.itemSel = null;
      state.gapSel = null;
      state.mainSel = false;
      state.captionSel = true;
      setSelection(span.words[0], span.words[span.words.length - 1]);
      seek(span.start + 0.01);
      canvasEditor?.update();
    },
    onEditCaption: (span) => beginEdit(span.words[0], span.words[span.words.length - 1]),
    onChangeItem: (id, { startE, length, offset, trackId }) => {
      const change = {};
      if (startE != null) change.start = E.toSource(state.kept, startE);
      if (length != null) change.length = length;
      if (offset != null) change.offset = offset;
      let tracks = T.update(state.tracks, id, change);
      if (trackId) tracks = T.move(tracks, id, trackId);
      commit({ tracks });
    },
    onTrackChange: (trackId, change) => commit({ tracks: T.setTrack(state.tracks, trackId, change) }),
    onRemoveTrack: (trackId) => {
      const t = state.tracks.find((x) => x.id === trackId);
      if (t?.items.length && !window.confirm(`Remove “${t.name}” and its ${t.items.length} item${t.items.length === 1 ? '' : 's'}?`)) return;
      commit({ tracks: T.removeTrack(state.tracks, trackId) });
    },
  });

  const properties = new CutlineProperties({
    onChange: (clip, { final }) => {
      if (!hasProject()) {
        state.clip = clip;
      } else if (final) {
        commit({ clip });
      } else {
        state.clip = clip;
        lastCaptionKey = null;
        applyAudio();
        updatePlayhead();
      }
      applyAudio();
    },
  });

  const panels = new CutlinePanels.Panels({
    onCaptionsChange: (settings) => {
      state.captions = settings;
      if (hasProject()) setDirty(true);
      refresh();
      if (settings.enabled && state.media && !state.media.hasVideo) toast('Captions are burned into video, so they need a video file.');
    },
    onInsertMedia: (media) => insertMedia(media),
    onError: showError,
    onToast: (msg) => toast(msg),
  });

  // ---------- rendering ----------

  // The transcript reads like a document: cut words disappear, leaving a small marker that
  // shows what was cut and restores it on click.
  function renderTranscript() {
    els.transcript.textContent = '';
    $('no-transcript').hidden = state.words.length > 0;
    $('btn-speakers').hidden = !state.words.length;
    spans = new Array(state.words.length).fill(null);
    const fillers = new Set(E.fillerIndices(state.words));
    let para = document.createElement('p');
    let run = null; // open marker for consecutive cut words
    // With speakers, each change of speaker starts a paragraph headed by their name.
    const labels = Object.keys(state.speakers).length > 0;
    let paraSpeaker;
    const label = (id) => {
      const el = document.createElement('span');
      el.className = 'speaker-label';
      el.dataset.speaker = id ?? '';
      el.textContent = id != null ? state.speakers[id] ?? 'Speaker' : 'Unlabelled';
      return el;
    };
    state.words.forEach((w, i) => {
      const prev = state.words[i - 1];
      const gap = prev ? w.start - prev.end : 0;
      const sentenceEnd = prev && /[.!?।]["')\]]?$/.test(prev.text);
      const newSpeaker = labels && prev && (w.speaker ?? null) !== (paraSpeaker ?? null);
      if (prev && (gap > 1.6 || (sentenceEnd && gap > 0.9) || newSpeaker) && para.childNodes.length) {
        els.transcript.appendChild(para);
        para = document.createElement('p');
        run = null;
      }
      if (labels && !para.childNodes.length) {
        // Name the speaker when it changes (or at the very top).
        if (i === 0 || (w.speaker ?? null) !== (paraSpeaker ?? null) || newSpeaker) para.appendChild(label(w.speaker));
        paraSpeaker = w.speaker;
      }
      if (state.deleted.has(i)) {
        if (!run) {
          run = document.createElement('span');
          run.className = 'del';
          run.dataset.from = i;
          run.textContent = '⌁';
          if (para.childNodes.length) para.appendChild(document.createTextNode(' '));
          para.appendChild(run);
        }
        run.dataset.to = i;
        run.title = `Cut: ${state.words.slice(Number(run.dataset.from), i + 1).map((x) => x.text).join(' ')} (click to restore)`;
        return;
      }
      run = null;
      if (para.childNodes.length) para.appendChild(document.createTextNode(' '));
      const span = document.createElement('span');
      span.className = 'w';
      if (fillers.has(i)) span.classList.add('filler');
      span.dataset.i = i;
      span.textContent = w.text;
      para.appendChild(span);
      spans[i] = span;
    });
    if (para.childNodes.length) els.transcript.appendChild(para);
    els.docTitle.textContent = projectName();
    els.docLanguage.textContent = languageNames[state.language] ?? state.language ?? '';
    els.docLanguage.hidden = !state.language;
    els.empty.hidden = true;
    els.transcriptWrap.hidden = false;
    renderedVersion = state.textVersion;
    state.nowIndex = -1;
  }

  // Visible (not cut) word at or after i, or -1.
  function visibleFrom(i) {
    for (let k = Math.max(0, i); k < state.words.length; k++) if (!state.deleted.has(k)) return k;
    return -1;
  }

  // Visible word before i, or -1.
  function visibleBefore(i) {
    for (let k = Math.min(i, state.words.length) - 1; k >= 0; k--) if (!state.deleted.has(k)) return k;
    return -1;
  }

  function paintCaret() {
    els.transcript.querySelectorAll('.caret-before, .caret-after').forEach((el) => el.classList.remove('caret-before', 'caret-after'));
    if (state.caret == null || selectionRange()) return;
    const at = visibleFrom(state.caret);
    if (at >= 0) spans[at]?.classList.add('caret-before');
    else spans[visibleBefore(state.words.length)]?.classList.add('caret-after');
  }

  function refresh() {
    const d = duration();
    state.cuts = E.computeCuts(state.words, state.deleted, d, state.cutGaps, state.rangeCuts);
    state.kept = E.keptRanges(state.cuts, d);
    state.captionSpans = C.groupSpans(C.groupWords(state.words, state.deleted, state.captions.preset), state.words);
    lastCaptionKey = null;
    const sel = selectionRange();
    if (state.media && !state.loadingMedia && renderedVersion !== state.textVersion) renderTranscript();
    spans.forEach((span, i) => {
      span?.classList.toggle('sel', !!sel && i >= sel[0] && i <= sel[1]);
    });
    paintCaret();
    if (hasProject()) {
      timeline.setEdits({ words: state.words, deleted: state.deleted, cutGaps: state.cutGaps, selection: sel, gapSel: state.gapSel, rangeCuts: state.rangeCuts });
      timeline.setMarks({ splits: state.splits, rangeSel: state.rangeSel });
      timeline.setTracks(T.placed(state.tracks, state.kept), state.itemSel);
      const capsOn = state.captions.enabled && state.media?.hasVideo;
      timeline.setCaptions(capsOn ? state.captionSpans.map((sp) => ({ ...sp, text: C.displayText(sp.words.map((i) => state.words[i].text).join(' '), C.PRESETS[state.captions.preset]) })) : [], sel);
    }

    const total = editedLength();
    els.statOriginal.textContent = state.media ? fmt(d) : '—';
    els.statEdited.textContent = state.media ? fmt(total) : '—';
    els.statCut.textContent = state.media ? `${state.deleted.size} words · ${state.cutGaps.size} pauses · ${itemCount()} on tracks` : '—';
    els.timeTotal.textContent = fmtTenths(state.media ? total : 0);
    properties.setProps(state.clip, total, state.media ? { w: els.video.videoWidth || state.media.width || 1920, h: els.video.videoHeight || state.media.height || 1080 } : null);
    renderTextEditor();
    renderItemInspector();
    $('ai-studio').textContent = state.clip.enhance ? 'Turn off' : 'Turn on';
    $('ai-studio').classList.toggle('on', state.clip.enhance);
    for (const id of ['ai-studio', 'ai-autoframe', 'ai-speakers', 'ai-find']) $(id).disabled = !hasProject() || state.busy;
    $('ai-autoframe').disabled ||= !state.media?.hasVideo;
    $('ai-speakers').disabled ||= !state.words.length;
    $('ai-find').disabled ||= !state.words.length;
    canvasEditor?.setEnabled(hasProject() && Boolean(state.media?.hasVideo) && !state.cropping);
    applyAudio();

    const b = els.buttons;
    const ready = hasProject() && !state.busy;
    const anySel = !!sel || state.gapSel != null || state.itemSel != null;
    b.save.disabled = !ready;
    b.export.disabled = !ready || state.kept.length === 0;
    b.fillers.disabled = !ready;
    b.retakes.disabled = !ready;
    b.pauses.disabled = !ready;
    b.cut.disabled = !ready || !anySel;
    b.restore.disabled = !ready || (!sel && state.gapSel == null);
    b.undo.disabled = !ready || state.undo.length === 0;
    b.redo.disabled = !ready || state.redo.length === 0;
    b.open.disabled = state.busy;
    b.openEmpty.disabled = state.busy;
    b.openProject.disabled = state.busy;
    els.language.disabled = state.busy;
    els.quality.disabled = state.busy;
    els.play.disabled = !state.media;
    updatePlayhead();
  }

  // The output frame, fitted inside the player. Captions and B-roll cover this area.
  function frameLayout() {
    const srcW = els.video.videoWidth || state.media?.width || 16;
    const srcH = els.video.videoHeight || state.media?.height || 9;
    // While cropping, show the whole picture (turned and flipped) so the box can grow too.
    if (state.cropping) return F.layout(srcW, srcH, { ...state.clip, crop: null, scale: 1, x: 0, y: 0, canvas: 'original', bgMode: 'color' });
    return F.layout(srcW, srcH, state.clip);
  }

  function contentRect() {
    const box = els.player.getBoundingClientRect();
    const { frame } = frameLayout();
    const k = Math.min(box.width / frame.w, box.height / frame.h);
    const w = frame.w * k;
    const h = frame.h * k;
    return { left: (box.width - w) / 2, top: (box.height - h) / 2, width: w, height: h };
  }

  // Lay the preview out exactly as the export will: the frame (with its background), and the
  // cropped, rotated, scaled picture placed inside it.
  function applyPreviewLayout() {
    const stage = $('stage');
    const L = frameLayout();
    const r = contentRect();
    const k = r.width / L.frame.w;
    place(stage, r);
    stage.style.background = L.props.background;
    const pic = $('pic');
    pic.style.left = `${L.draw.x * k}px`;
    pic.style.top = `${L.draw.y * k}px`;
    pic.style.width = `${L.draw.w * k}px`;
    pic.style.height = `${L.draw.h * k}px`;
    const turned = L.rotate % 180 === 90;
    const k2 = (L.draw.w * k) / (turned ? L.crop.h : L.crop.w);
    const inner = $('pic-inner');
    inner.style.width = `${L.crop.w * k2}px`;
    inner.style.height = `${L.crop.h * k2}px`;
    inner.style.transform = `translate(-50%, -50%) scale(${L.props.flipH ? -1 : 1}, ${L.props.flipV ? -1 : 1}) rotate(${L.rotate}deg)`;
    syncBackgroundVideo(L);
    if (state.cropping && cropEditor) cropEditor.setArea(cropArea(), r.width / r.height);
    const srcW = els.video.videoWidth || state.media?.width || 16;
    const srcH = els.video.videoHeight || state.media?.height || 9;
    els.video.style.width = `${srcW * k2}px`;
    els.video.style.height = `${srcH * k2}px`;
    els.video.style.left = `${-L.crop.x * k2}px`;
    els.video.style.top = `${-L.crop.y * k2}px`;
    return r;
  }

  // Blurred background: a muted copy of the video, zoomed to cover the frame and blurred.
  let bgVideo = null;
  function syncBackgroundVideo(L = frameLayout()) {
    const want = L.props.bgMode === 'blur' && state.media?.hasVideo;
    if (!want) { if (bgVideo) { bgVideo.pause(); bgVideo.hidden = true; } return; }
    if (!bgVideo) {
      bgVideo = document.createElement('video');
      bgVideo.className = 'bg-video';
      bgVideo.muted = true;
      bgVideo.playsInline = true;
      bgVideo.preload = 'auto';
      $('stage').prepend(bgVideo);
    }
    bgVideo.hidden = false;
    if (bgVideo.getAttribute('src') !== state.media.url) bgVideo.src = state.media.url;
    bgVideo.style.transform = `scale(${L.props.flipH ? -1 : 1}, ${L.props.flipV ? -1 : 1}) rotate(${L.rotate}deg)`;
    if (Math.abs(bgVideo.currentTime - els.video.currentTime) > 0.25) bgVideo.currentTime = els.video.currentTime;
    bgVideo.playbackRate = els.video.playbackRate;
    if (els.video.paused) bgVideo.pause();
    else if (bgVideo.paused) bgVideo.play().catch(() => {});
  }

  // Studio Sound preview: a cleaned copy of the voice plays in step with the (muted) video.
  const enhancedEl = new Audio();
  enhancedEl.preload = 'auto';
  const enhancedUrls = new Map(); // media path -> url, or a pending promise
  function enhancedReady() {
    const url = state.media && enhancedUrls.get(state.media.path);
    return state.clip.enhance && typeof url === 'string' ? url : null;
  }
  function prepareEnhanced() {
    const media = state.media;
    if (!media || enhancedUrls.has(media.path)) return;
    toast('Preparing Studio Sound preview…', { ms: 2500 });
    const pending = cutline.enhancedAudio(media.path).then((url) => {
      enhancedUrls.set(media.path, url);
      if (state.media?.path === media.path) { applyAudio(); toast('Studio Sound is on. The export uses it too.'); }
    }).catch((err) => { enhancedUrls.delete(media.path); showError(err); });
    enhancedUrls.set(media.path, pending);
  }
  function syncEnhanced() {
    const url = enhancedReady();
    if (!url) { if (!enhancedEl.paused) enhancedEl.pause(); return; }
    if (enhancedEl.getAttribute('src') !== url) enhancedEl.src = url;
    if (Math.abs(enhancedEl.currentTime - els.video.currentTime) > 0.15) enhancedEl.currentTime = els.video.currentTime;
    enhancedEl.playbackRate = els.video.playbackRate;
    if (els.video.paused) enhancedEl.pause();
    else if (enhancedEl.paused) enhancedEl.play().catch(() => {});
  }

  // Volume up to 200%: the media element stops at 100%, so louder goes through Web Audio.
  let audioGain = null;
  function applyAudio() {
    const { volume, muted, speed } = state.clip;
    if (state.clip.enhance) prepareEnhanced();
    const enhanced = Boolean(enhancedReady());
    enhancedEl.muted = muted;
    enhancedEl.volume = Math.min(1, volume);
    els.video.muted = muted || enhanced;
    if (volume > 1 && !audioGain) {
      try {
        const ctx = new AudioContext();
        audioGain = ctx.createGain();
        ctx.createMediaElementSource(els.video).connect(audioGain).connect(ctx.destination);
      } catch (err) { console.error(err); }
    }
    if (audioGain) {
      els.video.volume = 1;
      audioGain.gain.value = volume;
      if (audioGain.context.state === 'suspended') audioGain.context.resume().catch(() => {});
    } else {
      els.video.volume = Math.min(1, volume);
    }
    els.video.playbackRate = speed * (Number(els.speed.value) || 1);
  }

  function place(el, r) {
    el.style.left = `${r.left}px`;
    el.style.top = `${r.top}px`;
    el.style.width = `${r.width}px`;
    el.style.height = `${r.height}px`;
  }

  // Track preview: overlays drawn in their boxes (later tracks on top) and audio-track items
  // played in step with the edit. Elements are kept per item and reused.
  const layerEls = new Map(); // item id -> element
  function syncMedia(el, item, e, volume) {
    const want = (item.offset || 0) + (e - item.startE);
    if (Math.abs(el.currentTime - want) > 0.3) el.currentTime = want;
    el.playbackRate = els.video.playbackRate;
    el.volume = Math.min(1, Math.max(0, volume));
    el.muted = volume <= 0;
    if (els.video.paused) el.pause();
    else if (el.paused) el.play().catch(() => {});
  }

  function updateTrackPreview(e, r) {
    const active = hasProject() ? T.activeAt(state.tracks, state.kept, e) : [];
    const seen = new Set();
    // While a word is being spoken, ducked music plays quieter (the export does this precisely).
    const t = els.video.currentTime;
    const wi = E.wordAt(state.words, t);
    const speaking = wi >= 0 && t <= state.words[wi].end + 0.15 && !state.deleted.has(wi);
    active.forEach(({ track, item }, z) => {
      if (track.type === 'overlay' && (track.hidden || !state.media?.hasVideo)) return;
      seen.add(item.id);
      let el = layerEls.get(item.id);
      const tag = track.type === 'audio' ? 'AUDIO' : item.kind === 'image' ? 'IMG' : item.kind === 'text' ? 'DIV' : 'VIDEO';
      if (!el || el.tagName !== tag) {
        el?.remove();
        el = document.createElement(tag.toLowerCase());
        el.className = track.type === 'audio' ? 'track-audio' : 'overlay-layer';
        el.dataset.item = item.id;
        if (tag === 'VIDEO' || tag === 'AUDIO') { el.preload = 'auto'; el.playsInline = true; }
        els.layers.appendChild(el);
        layerEls.set(item.id, el);
      }
      if (tag === 'AUDIO') {
        if (el.getAttribute('src') !== item.url) el.src = item.url;
        const gain = track.muted ? 0 : item.volume * state.clip.volume * (item.duck && speaking ? 0.3 : 1);
        syncMedia(el, item, e, state.clip.muted ? 0 : gain);
        return;
      }
      const box = item.box;
      el.style.left = `${box.x * r.width}px`;
      el.style.top = `${box.y * r.height}px`;
      el.style.width = `${box.w * r.width}px`;
      el.style.height = `${box.h * r.height}px`;
      el.style.opacity = String(T.fadeAt(item, e - item.startE));
      el.style.objectFit = item.fit === 'contain' ? 'contain' : 'cover';
      el.style.zIndex = String(10 + z);
      el.classList.toggle('selected', item.id === state.itemSel);
      if (tag === 'IMG' && el.getAttribute('src') !== item.url) el.src = item.url;
      if (tag === 'VIDEO') {
        if (el.getAttribute('src') !== item.url) el.src = item.url;
        syncMedia(el, item, e, track.muted ? 0 : item.volume ?? 0);
      }
      if (tag === 'DIV') renderTextLayer(el, item, r);
    });
    for (const [id, el] of layerEls) {
      if (!seen.has(id)) {
        if (el.pause) el.pause();
        el.remove();
        layerEls.delete(id);
      }
    }
  }

  function renderTextLayer(el, item) {
    CutlineText.renderDom(el, item, state.language);
  }

  // Caption preview, drawn with the same styles the export burns in.
  let lastCaptionKey = null;
  function updateCaptionPreview(t, r) {
    const layer = els.captionLayer;
    const on = state.captions.enabled && hasProject() && state.media.hasVideo;
    const active = on ? C.activeAt(state.captionSpans, state.words, t) : null;
    if (!active) {
      layer.hidden = true;
      lastCaptionKey = null;
      return;
    }
    const s = state.captions;
    const key = `${active.span.start}:${active.current}:${s.preset}:${s.size}:${s.position}:${s.x}:${s.y}:${s.scale}:${Math.round(r.width)}x${Math.round(r.height)}`;
    if (key === lastCaptionKey) return;
    lastCaptionKey = key;
    place(layer, r);
    const fontPx = C.fontPx(s, r.width, r.height);
    const custom = s.position === 'custom';
    layer.style.alignItems = s.position === 'top' ? 'flex-start' : s.position === 'middle' ? 'center' : 'flex-end';
    layer.style.paddingTop = s.position === 'top' ? `${r.height * 0.12}px` : '0';
    layer.style.paddingBottom = s.position === 'bottom' ? `${r.height * 0.16}px` : '0';
    let line = layer.firstElementChild;
    if (!line) {
      line = document.createElement('span');
      line.className = 'caption-line';
      layer.appendChild(line);
    }
    // Dragged captions sit with their centre on (x, y).
    Object.assign(line.style, custom
      ? { position: 'absolute', left: `${s.x * r.width}px`, top: `${s.y * r.height}px`, transform: 'translate(-50%, -50%)', width: 'max-content' }
      : { position: '', left: '', top: '', transform: '', width: '' });
    CutlinePanels.styleLine(line, s.preset, fontPx, state.language);
    CutlinePanels.fillLine(line, active.span.words.map((i) => ({ text: state.words[i].text, i })), s.preset, active.current);
    layer.hidden = false;
  }

  function updatePlayhead() {
    syncEnhanced();
    if (bgVideo && !bgVideo.hidden) syncBackgroundVideo();
    const t = els.video.currentTime;
    const e = E.toEdited(state.kept, t);
    els.timeCurrent.textContent = fmtTenths(e);
    if (hasProject()) timeline.setTime(t, !els.video.paused);
    if (state.media?.hasVideo) {
      // B-roll and captions live inside the frame, so they cover it from its own corner.
      const frame = applyPreviewLayout();
      const r = { left: 0, top: 0, width: frame.width, height: frame.height };
      updateTrackPreview(e, r);
      canvasEditor?.update();
      updateCaptionPreview(t, r);
    }

    const i = E.wordAt(state.words, t);
    const now = i >= 0 && t <= state.words[i].end + 0.25 ? i : -1;
    if (now !== state.nowIndex) {
      spans[state.nowIndex]?.classList.remove('now');
      state.nowIndex = now;
      const span = spans[now];
      if (span) {
        span.classList.add('now');
        if (!els.video.paused) keepVisible(span);
      }
    }
  }

  function keepVisible(span) {
    if (!span) return;
    const box = els.transcriptWrap.getBoundingClientRect();
    const r = span.getBoundingClientRect();
    if (r.top < box.top + 40 || r.bottom > box.bottom - 60) {
      span.scrollIntoView({ block: 'center', behavior: 'smooth' });
    }
  }

  window.addEventListener('resize', () => {
    lastCaptionKey = null;
    updatePlayhead();
  });

  // ---------- edits ----------

  function snapshot() {
    return { words: state.words, deleted: new Set(state.deleted), cutGaps: new Set(state.cutGaps), tracks: state.tracks, clip: state.clip, splits: state.splits, rangeCuts: state.rangeCuts, captions: state.captions };
  }

  function restore(snap) {
    if (snap.words !== state.words) state.anchor = state.focus = -1;
    state.words = snap.words;
    state.deleted = snap.deleted;
    state.cutGaps = snap.cutGaps;
    if (snap.tracks) state.tracks = snap.tracks;
    if (snap.clip) state.clip = snap.clip;
    if (snap.splits) state.splits = snap.splits;
    if (snap.rangeCuts) state.rangeCuts = snap.rangeCuts;
    if (snap.captions && snap.captions !== state.captions) { state.captions = snap.captions; panels.setCaptions(state.captions); }
    if (state.itemSel && !T.find(state.tracks, state.itemSel)) state.itemSel = null;
    state.textVersion++;
  }

  function commit({ words = state.words, deleted = state.deleted, cutGaps = state.cutGaps, tracks = state.tracks, clip = state.clip, splits = state.splits, rangeCuts = state.rangeCuts }) {
    state.undo.push(snapshot());
    if (state.undo.length > 500) state.undo.shift();
    state.redo = [];
    restore({ words, deleted, cutGaps, tracks, clip, splits, rangeCuts });
    setDirty(true);
    refresh();
  }

  function cutSelection({ restore: restoreSel = false, toggle = false } = {}) {
    if (!hasProject()) return;
    if (state.rangeSel && !restoreSel) {
      const r = E.cutRange(state.words, state.deleted, state.rangeCuts, state.rangeSel[0], state.rangeSel[1]);
      const [a, b] = state.rangeSel;
      state.rangeSel = null;
      commit(r);
      toast(`Cut ${(b - a).toFixed(1)}s. Press ⌘Z to undo.`);
      return;
    }
    if (state.itemSel != null && !restoreSel) {
      const id = state.itemSel;
      state.itemSel = null;
      commit({ tracks: T.remove(state.tracks, id) });
      return;
    }
    if (state.gapSel != null) {
      const next = new Set(state.cutGaps);
      const isCut = next.has(state.gapSel);
      if (restoreSel || (toggle && isCut)) next.delete(state.gapSel);
      else next.add(state.gapSel);
      commit({ cutGaps: next });
      return;
    }
    const sel = selectionRange();
    if (!sel) return;
    const next = new Set(state.deleted);
    let allCut = true;
    for (let i = sel[0]; i <= sel[1]; i++) if (!next.has(i)) { allCut = false; break; }
    const shouldRestore = restoreSel || (toggle && allCut);
    for (let i = sel[0]; i <= sel[1]; i++) {
      if (shouldRestore) next.delete(i); else next.add(i);
    }
    // Like deleting text: the cursor stays where the selection was.
    if (!shouldRestore) {
      state.caret = sel[1] + 1;
      state.anchor = state.focus = -1;
    }
    commit({ deleted: next });
  }

  // Backspace / Delete with only a text cursor: cut the word before / after it.
  function cutAtCaret(forward) {
    if (state.caret == null) return;
    const i = forward ? visibleFrom(state.caret) : visibleBefore(state.caret);
    if (i < 0) return;
    const next = new Set(state.deleted);
    next.add(i);
    state.caret = forward ? i + 1 : i;
    commit({ deleted: next });
  }

  function restoreRun(from, to) {
    const r = E.restoreWords(state.words, state.deleted, state.rangeCuts, from, to);
    state.anchor = from;
    state.focus = to;
    state.caret = null;
    commit(r);
  }

  // ---------- correcting text ----------

  // Edit the text of words from..to in place. The media is untouched; only the spelling
  // changes (like Descript's correct mode). Enter or clicking away saves, Escape cancels.
  function beginEdit(from, to, initial = null) {
    if (!hasProject() || state.busy) return;
    for (let i = from; i <= to; i++) {
      if (state.deleted.has(i)) { toast('Restore the cut words in this selection before correcting it.'); return; }
    }
    const first = spans[from];
    if (!first) return;
    els.video.pause();
    const editor = document.createElement('span');
    editor.className = 'editing';
    editor.contentEditable = 'plaintext-only';
    editor.spellcheck = false;
    editor.textContent = initial ?? state.words.slice(from, to + 1).map((w) => w.text).join(' ');
    first.before(editor);
    for (let i = from; i <= to; i++) {
      const sp = spans[i];
      if (!sp) continue;
      if (sp.previousSibling?.nodeType === Node.TEXT_NODE && i > from) sp.previousSibling.remove();
      sp.remove();
    }
    let done = false;
    const finish = (save) => {
      if (done) return;
      done = true;
      const text = editor.textContent;
      if (save && text.trim() !== state.words.slice(from, to + 1).map((w) => w.text).join(' ')) {
        const r = E.replaceWords(state.words, state.deleted, state.cutGaps, from, to, text);
        state.anchor = state.focus = -1;
        state.caret = from + (text.trim() ? text.trim().split(/\s+/).length : to - from + 1);
        commit(r);
      } else {
        state.textVersion++;
        refresh();
      }
      els.transcript.focus();
    };
    editor.addEventListener('keydown', (e) => {
      e.stopPropagation();
      if (e.key === 'Enter') { e.preventDefault(); finish(true); }
      else if (e.key === 'Escape') { e.preventDefault(); finish(false); }
    });
    editor.addEventListener('blur', () => finish(true));
    editor.focus();
    const range = document.createRange();
    range.selectNodeContents(editor);
    if (initial != null) range.collapse(false);
    const selection = window.getSelection();
    selection.removeAllRanges();
    selection.addRange(range);
  }

  function removeFillers() {
    const fillers = E.fillerIndices(state.words).filter((i) => !state.deleted.has(i));
    if (!fillers.length) {
      toast('No filler words found in the transcript.');
      return;
    }
    const next = new Set(state.deleted);
    fillers.forEach((i) => next.add(i));
    commit({ deleted: next });
    toast(`Cut ${fillers.length} filler word${fillers.length === 1 ? '' : 's'}. Press ⌘Z to undo.`);
  }

  function removeRetakes() {
    const takes = E.findRetakes(state.words, state.deleted);
    if (!takes.length) {
      toast('No repeated takes found. Lines said again right after a pause or a false start are what this looks for.');
      return;
    }
    const next = new Set(state.deleted);
    takes.forEach((t) => t.idx.forEach((i) => next.add(i)));
    commit({ deleted: next });
    const words = takes.reduce((n, t) => n + t.idx.length, 0);
    toast(`Cut ${takes.length} earlier take${takes.length === 1 ? '' : 's'} (${words} words), keeping the last one each time. Press ⌘Z to undo.`, { ms: 6000 });
  }

  function shortenPauses() {
    const long = E.gaps(state.words, duration(), 1.0).filter((g) => !state.cutGaps.has(g.i));
    if (!long.length) {
      toast('No pauses longer than 1 second to shorten.');
      return;
    }
    const next = new Set(state.cutGaps);
    long.forEach((g) => next.add(g.i));
    const saved = long.reduce((sum, g) => sum + (g.end - g.start - E.GAP_KEEP), 0);
    commit({ cutGaps: next });
    toast(`Shortened ${long.length} pause${long.length === 1 ? '' : 's'}, saving ${saved.toFixed(1)}s. Press ⌘Z to undo.`);
  }

  // Put a video, photo or sound at the playhead on the first free track of its kind (a new
  // track is added when they are all busy). Videos run up to 4 s, photos 3 s, sounds their
  // whole length.
  function insertMedia(media) {
    if (!hasProject()) { toast('Open a project first, then add media to it.'); return; }
    const audio = media.kind === 'audio';
    if (!audio && !state.media.hasVideo) { toast('Overlays cover the picture, so they need a video project.', { error: true }); return; }
    const total = editedLength();
    let startE = E.toEdited(state.kept, els.video.currentTime);
    const want = audio ? (media.duration || total) : media.kind === 'image' ? 3 : Math.min(4, media.duration || 4);
    const length = Math.min(want, total);
    if (startE + length > total) startE = Math.max(0, total - length);
    const place = audio ? null : T.placement(brollPlacement(), mediaAspect(media));
    const { tracks, itemId, trackId } = T.insert(state.tracks, audio ? 'audio' : 'overlay', {
      ...(place ?? {}),
      path: media.path,
      url: media.url,
      kind: media.kind,
      name: media.name,
      thumb: media.thumb,
      duration: media.duration,
      start: E.toSource(state.kept, startE),
      length,
    }, state.kept);
    state.itemSel = itemId;
    state.anchor = state.focus = -1;
    state.gapSel = null;
    commit({ tracks });
    const track = tracks.find((t) => t.id === trackId);
    toast(`Added ${media.name} to “${track.name}” at ${fmtTenths(startE)}. Change its placement, timing and fades in Properties.`);
    if (!audio) openRailPanel('properties');
  }

  // ---------- correcting the transcript ----------

  function wordList() {
    try { return JSON.parse(localStorage.getItem('cutline.wordList') || '[]'); } catch { return []; }
  }
  function saveWordList(list) {
    try { localStorage.setItem('cutline.wordList', JSON.stringify(list)); } catch {}
  }

  function correctSelection() {
    const sel = selectionRange();
    if (sel) beginEdit(sel[0], sel[1]);
    else if (state.caret != null) { const i = visibleFrom(state.caret); if (i >= 0) beginEdit(i, i); }
    else toast('Select the words to correct, or double-click a word.');
  }
  $('btn-correct').addEventListener('click', correctSelection);

  // Right-click menu on the transcript.
  const wordMenu = $('word-menu');
  els.transcript.addEventListener('contextmenu', (e) => {
    const i = wordIndexFrom(e.target);
    if (i < 0 || !hasProject()) return;
    e.preventDefault();
    let sel = selectionRange();
    if (!sel || i < sel[0] || i > sel[1]) { setSelection(i, i); sel = [i, i]; }
    const item = (text, key, fn) => {
      const li = document.createElement('li');
      li.textContent = text;
      if (key) { const k = document.createElement('kbd'); k.textContent = key; li.appendChild(k); }
      li.addEventListener('click', () => { wordMenu.hidden = true; fn(); });
      return li;
    };
    const text = state.words.slice(sel[0], sel[1] + 1).map((w) => w.text).join(' ');
    wordMenu.replaceChildren(
      item('Correct text…', '↵', () => beginEdit(sel[0], sel[1])),
      item('Cut', '⌫', () => cutSelection()),
      item('Find and replace this…', '⌘F', () => openFind(text)),
      item('Speaker…', '', () => showSpeakerMenu(e.clientX, e.clientY, sel, state.words[sel[0]].speaker)),
      item('Play from here', '', () => { seek(state.words[sel[0]].start); els.video.play(); }),
      item('Copy text', '⌘C', () => navigator.clipboard?.writeText(text)),
    );
    wordMenu.hidden = false;
    wordMenu.style.left = `${Math.min(window.innerWidth - 230, e.clientX)}px`;
    wordMenu.style.top = `${Math.min(window.innerHeight - wordMenu.offsetHeight - 8, e.clientY)}px`;
  });
  window.addEventListener('mousedown', (e) => { if (!e.target.closest('#word-menu')) wordMenu.hidden = true; });

  // Find and replace.
  let findHits = [];
  let findAt = -1;
  function paintFind() {
    els.transcript.querySelectorAll('.w.found').forEach((x) => x.classList.remove('found'));
    findHits = hasProject() ? E.findPhrase(state.words, state.deleted, $('find-text').value) : [];
    for (const [a, b] of findHits) for (let i = a; i <= b; i++) spans[i]?.classList.add('found');
    $('find-count').textContent = $('find-text').value.trim() ? `${findHits.length} match${findHits.length === 1 ? '' : 'es'} in the transcript` : '';
    $('find-go').disabled = !findHits.length;
  }
  function renderWordList() {
    const list = wordList();
    const ul = $('word-list');
    if (!list.length) {
      const li = document.createElement('li');
      li.className = 'empty-note';
      li.textContent = 'Nothing yet. Tick the box above to add a fix.';
      ul.replaceChildren(li);
      return;
    }
    ul.replaceChildren(...list.map(([from, to], n) => {
      const li = document.createElement('li');
      const span = document.createElement('span');
      span.textContent = `${from} → ${to}`;
      const x = document.createElement('button');
      x.type = 'button';
      x.textContent = '×';
      x.title = 'Remove from the word list';
      x.addEventListener('click', () => { saveWordList(wordList().filter((_, k) => k !== n)); renderWordList(); });
      li.append(span, x);
      return li;
    }));
  }
  function openFind(initial = '') {
    if (!hasProject() || !state.words.length) { toast('There is no transcript to search yet.'); return; }
    $('find-dialog').hidden = false;
    if (initial) $('find-text').value = initial;
    $('find-remember').checked = false;
    renderWordList();
    paintFind();
    $('find-text').focus();
    $('find-text').select();
  }
  const closeFind = () => {
    $('find-dialog').hidden = true;
    els.transcript.querySelectorAll('.w.found').forEach((x) => x.classList.remove('found'));
  };
  $('btn-find').addEventListener('click', () => openFind(selectionRange() ? state.words.slice(selectionRange()[0], selectionRange()[1] + 1).map((w) => w.text).join(' ') : ''));
  $('find-close').addEventListener('click', closeFind);
  $('find-text').addEventListener('input', () => { findAt = -1; paintFind(); });
  $('find-dialog').addEventListener('keydown', (e) => {
    e.stopPropagation();
    if (e.key === 'Escape') closeFind();
    if (e.key === 'Enter' && e.target.id === 'find-replace') $('find-go').click();
  });
  $('find-next').addEventListener('click', () => {
    if (!findHits.length) return;
    findAt = (findAt + 1) % findHits.length;
    const [a] = findHits[findAt];
    spans[a]?.scrollIntoView({ block: 'center', behavior: 'smooth' });
    seek(state.words[a].start);
  });
  $('find-go').addEventListener('click', () => {
    const from = $('find-text').value.trim();
    const to = $('find-replace').value.trim();
    if (!from || !to) { $('find-count').textContent = 'Type both the wrong text and the right text.'; return; }
    const r = E.replaceAll(state.words, state.deleted, state.cutGaps, from, to);
    if (!r.count) return;
    if ($('find-remember').checked) {
      saveWordList([...wordList().filter(([f]) => f.toLowerCase() !== from.toLowerCase()), [from, to]]);
    }
    commit({ words: r.words, deleted: r.deleted, cutGaps: r.cutGaps });
    renderTranscript();
    toast(`Replaced ${r.count} × “${from}” with “${to}”. ⌘Z to undo.${$('find-remember').checked ? ' Added to your word list.' : ''}`);
    closeFind();
  });

  // ---------- speakers ----------

  const SP = CutlineSpeakers;
  const speakerMenu = $('speaker-menu');

  // Words a speaker action applies to: the selection, or the paragraph a label heads.
  function showSpeakerMenu(x, y, range, currentId) {
    const items = [];
    const head = (text) => { const li = document.createElement('li'); li.className = 'menu-head'; li.textContent = text; return li; };
    const item = (text, fn, on = false) => {
      const li = document.createElement('li');
      li.textContent = text;
      li.classList.toggle('on', on);
      li.addEventListener('click', () => { speakerMenu.hidden = true; fn(); });
      return li;
    };
    if (range) {
      items.push(head(`${range[1] - range[0] + 1} word${range[1] === range[0] ? '' : 's'} said by`));
      for (const [id, name] of Object.entries(state.speakers)) items.push(item(name, () => assignSpeaker(range, id), id === currentId));
      items.push(item('+ New speaker…', () => {
        const id = SP.newId(state.speakers);
        state.speakers = { ...state.speakers, [id]: `Speaker ${Object.keys(state.speakers).length + 1}` };
        assignSpeaker(range, id);
        requestAnimationFrame(() => renameSpeaker(id));
      }));
    } else {
      items.push(head('Select words in the transcript first, then choose who said them.'));
    }
    if (currentId != null && state.speakers[currentId]) items.push(item(`Rename “${state.speakers[currentId]}”…`, () => renameSpeaker(currentId)));
    if (Object.keys(state.speakers).length) items.push(item('Remove all speaker labels', clearSpeakers));
    speakerMenu.replaceChildren(...items);
    speakerMenu.hidden = false;
    const w = 220;
    speakerMenu.style.left = `${Math.min(window.innerWidth - w - 8, x)}px`;
    speakerMenu.style.top = `${Math.min(window.innerHeight - speakerMenu.offsetHeight - 8, y)}px`;
  }

  function assignSpeaker([from, to], id) {
    const words = SP.assign(state.words, from, to, id);
    state.speakers = SP.prune(words, state.speakers);
    commit({ words });
    renderTranscript();
    refresh();
  }

  function clearSpeakers() {
    state.speakers = {};
    commit({ words: state.words.map(({ speaker, ...rest }) => rest) });
    renderTranscript();
    refresh();
  }

  // Rename in place: the label turns into a text field.
  function renameSpeaker(id) {
    const el = els.transcript.querySelector(`.speaker-label[data-speaker="${CSS.escape(id)}"]`);
    if (!el) return;
    const input = document.createElement('input');
    input.className = 'text-input';
    input.value = state.speakers[id];
    input.maxLength = 40;
    el.replaceChildren(input);
    input.focus();
    input.select();
    let done = false;
    const finish = (keep) => {
      if (done) return;
      done = true;
      const name = input.value.trim();
      if (keep && name) { state.speakers = { ...state.speakers, [id]: name }; setDirty(true); }
      renderTranscript();
      refresh();
    };
    input.addEventListener('keydown', (e) => {
      e.stopPropagation();
      if (e.key === 'Enter') finish(true);
      if (e.key === 'Escape') finish(false);
    });
    input.addEventListener('blur', () => finish(true));
    input.addEventListener('mousedown', (e) => e.stopPropagation());
  }

  // The paragraph a label heads: from its first word to the word before the next label.
  function labelRange(labelEl) {
    const first = labelEl.parentElement.querySelector('.w, .del');
    if (!first) return null;
    const from = Number(first.dataset.i ?? first.dataset.from);
    let to = from;
    for (let p = labelEl.parentElement; p; p = p.nextElementSibling) {
      if (p !== labelEl.parentElement && p.querySelector('.speaker-label')) break;
      for (const el of p.querySelectorAll('.w, .del')) to = Math.max(to, Number(el.dataset.i ?? el.dataset.to));
    }
    return [from, to];
  }

  $('btn-speakers').addEventListener('click', (e) => {
    const r = e.currentTarget.getBoundingClientRect();
    const sel = selectionRange();
    showSpeakerMenu(r.left, r.bottom + 4, sel, sel ? state.words[sel[0]].speaker : null);
  });
  window.addEventListener('mousedown', (e) => {
    if (!e.target.closest('#speaker-menu') && !e.target.closest('#btn-speakers') && !e.target.closest('.speaker-label')) speakerMenu.hidden = true;
  });

  // ---------- B-roll inspector ----------

  function openRailPanel(name) {
    document.querySelector(`.rail-btn[data-panel="${name}"]:not(.on)`)?.click();
  }

  function brollPlacement() {
    try { return localStorage.getItem('cutline.brollPlacement') || 'full'; } catch { return 'full'; }
  }
  $('broll-placement').querySelectorAll('button').forEach((b) => b.addEventListener('click', () => {
    try { localStorage.setItem('cutline.brollPlacement', b.dataset.value); } catch {}
    paintPlacementChoice();
  }));
  function paintPlacementChoice() {
    $('broll-placement').querySelectorAll('button').forEach((b) => b.classList.toggle('on', b.dataset.value === brollPlacement()));
  }
  paintPlacementChoice();

  // A picture's shape relative to the frame's (1 = same shape).
  function frameAspect() {
    const L = frameLayout();
    return L.frame.w / L.frame.h;
  }
  function mediaAspect(media) {
    return media.width && media.height ? (media.width / media.height) / frameAspect() : 16 / 9 / frameAspect();
  }

  function placedItem(id) {
    for (const t of T.placed(state.tracks, state.kept)) {
      const item = t.items.find((i) => i.id === id);
      if (item) return { track: t, item };
    }
    return null;
  }

  // Inspector edits: live while dragging or typing, one undo step when finished.
  let itemBefore = null;
  function changeItem(change, final) {
    const id = state.itemSel;
    if (!id || !T.find(state.tracks, id)) return;
    if (!itemBefore) itemBefore = snapshot();
    state.tracks = T.update(state.tracks, id, change);
    if (final) {
      state.undo.push(itemBefore);
      if (state.undo.length > 500) state.undo.shift();
      state.redo = [];
      itemBefore = null;
      setDirty(true);
      refresh();
    } else {
      lastCaptionKey = null;
      updatePlayhead();
      canvasEditor?.update();
    }
  }

  const secs = (text) => {
    const v = String(text).trim();
    if (v.includes(':')) { const [m, s2] = v.split(':').map(Number); return m * 60 + s2; }
    return Number(v);
  };

  function buildItemInspector() {
    const grid = $('item-place');
    for (const [name, p] of Object.entries(T.PLACEMENTS)) {
      const b = document.createElement('button');
      b.type = 'button';
      b.dataset.value = name;
      b.title = p.label;
      b.appendChild(document.createElement('i'));
      b.addEventListener('click', () => {
        const found = T.find(state.tracks, state.itemSel);
        if (!found) return;
        changeItem(T.placement(name, itemAspect(found.item.id) ? itemAspect(found.item.id) / frameAspect() : mediaAspect(found.item)), true);
      });
      grid.appendChild(b);
    }
    $('item-fit').querySelectorAll('button').forEach((b) => b.addEventListener('click', () => changeItem({ fit: b.dataset.value }, true)));
    const slider = (id, apply) => {
      const range = $(id);
      const num = $(`${id}-num`);
      range.addEventListener('input', () => changeItem(apply(Number(range.value)), false));
      range.addEventListener('change', () => changeItem(apply(Number(range.value)), true));
      num.addEventListener('change', () => changeItem(apply(Number(num.value)), true));
    };
    const box = () => T.find(state.tracks, state.itemSel)?.item.box;
    slider('item-size', (v) => {
      const b = box();
      const w = Math.max(0.05, v / 100);
      const h = b.h * (w / b.w);
      return { box: { x: b.x + (b.w - w) / 2, y: b.y + (b.h - h) / 2, w, h } };
    });
    slider('item-x', (v) => ({ box: { x: v / 100 } }));
    slider('item-y', (v) => ({ box: { y: v / 100 } }));
    slider('item-opacity', (v) => ({ opacity: v / 100 }));
    slider('item-volume', (v) => ({ volume: v / 100 }));
    $('item-name').addEventListener('change', () => changeItem({ name: $('item-name').value.trim() || 'Clip' }, true));
    $('item-name').addEventListener('keydown', (e) => e.stopPropagation());
    for (const id of ['item-start', 'item-length', 'item-offset', 'item-fade-in', 'item-fade-out']) $(id).addEventListener('keydown', (e) => { e.stopPropagation(); if (e.key === 'Enter') e.target.blur(); });
    $('item-start').addEventListener('change', () => {
      const v = secs($('item-start').value);
      if (Number.isFinite(v) && v >= 0) changeItem({ start: E.toSource(state.kept, Math.min(v, editedLength() - 0.1)) }, true);
      else refresh();
    });
    $('item-length').addEventListener('change', () => {
      const v = secs($('item-length').value);
      const found = placedItem(state.itemSel);
      if (!found || !(v > 0)) { refresh(); return; }
      let length = Math.min(v, editedLength() - found.item.startE);
      if (found.item.kind === 'video' && found.item.duration) length = Math.min(length, found.item.duration - (found.item.offset || 0));
      changeItem({ length }, true);
    });
    $('item-offset').addEventListener('change', () => {
      const v = secs($('item-offset').value);
      const it = T.find(state.tracks, state.itemSel)?.item;
      if (!it || !(v >= 0)) { refresh(); return; }
      changeItem({ offset: it.duration ? Math.min(v, Math.max(0, it.duration - 0.2)) : v }, true);
    });
    $('item-fade-in').addEventListener('change', () => changeItem({ fadeIn: Number($('item-fade-in').value) || 0 }, true));
    $('item-fade-out').addEventListener('change', () => changeItem({ fadeOut: Number($('item-fade-out').value) || 0 }, true));
    $('item-duck').addEventListener('change', () => changeItem({ duck: $('item-duck').checked }, true));
    $('item-to-playhead').addEventListener('click', () => changeItem({ start: els.video.currentTime }, true));
    $('item-delete').addEventListener('click', () => {
      const id = state.itemSel;
      state.itemSel = null;
      commit({ tracks: T.remove(state.tracks, id) });
    });
    $('item-duplicate').addEventListener('click', () => {
      const found = placedItem(state.itemSel);
      if (!found) return;
      const { id, startE, url, ...rest } = found.item;
      const at = Math.min(startE + found.item.length, Math.max(0, editedLength() - found.item.length));
      const { tracks, itemId } = T.insert(state.tracks, found.track.type, { ...rest, url, start: E.toSource(state.kept, at) }, state.kept);
      state.itemSel = itemId;
      commit({ tracks });
    });
    $('item-replace').addEventListener('click', async () => {
      const found = T.find(state.tracks, state.itemSel);
      if (!found) return;
      try {
        const [m] = found.track.type === 'audio' ? await cutline.openAudio() : await cutline.openBroll();
        if (!m) return;
        panels.addToLibrary(m);
        changeItem({ path: m.path, url: m.url, kind: m.kind, name: m.name, thumb: m.thumb, duration: m.duration, offset: 0 }, true);
      } catch (err) { showError(err); }
    });
    $('item-back').addEventListener('click', () => { state.itemSel = null; state.mainSel = true; refresh(); });
  }
  buildItemInspector();

  function setSlider(id, v) {
    if (document.activeElement !== $(id)) $(id).value = Math.round(v);
    if (document.activeElement !== $(`${id}-num`)) $(`${id}-num`).value = Math.round(v);
  }
  const setField = (id, v) => { if (document.activeElement !== $(id)) $(id).value = v; };

  function renderItemInspector() {
    const found = state.itemSel ? placedItem(state.itemSel) : null;
    $('item-props').hidden = !found;
    $('clip-props').hidden = Boolean(found);
    $('prop-reset-all').hidden = Boolean(found);
    $('item-back').hidden = !found;
    if (!found) { $('props-title').textContent = 'Properties'; return; }
    const { track, item } = found;
    const overlay = track.type === 'overlay';
    const text = item.kind === 'text';
    $('props-title').textContent = text ? 'Text' : overlay ? 'B-roll' : 'Audio';
    setField('item-name', item.name ?? '');
    $('item-kind').textContent = `${text ? 'Text' : item.kind === 'image' ? 'Photo' : item.kind === 'audio' ? 'Sound' : 'Video'} on “${track.name}”${item.duration ? ` · clip is ${fmtTenths(item.duration)} long` : ''}`;
    $('item-place-group').hidden = !overlay || text;
    $('item-look-group').hidden = !overlay;
    $('item-audio-group').hidden = text || item.kind === 'image';
    $('item-duck-row').hidden = overlay;
    $('item-trim-row').hidden = !(item.kind === 'video' || item.kind === 'audio');
    $('item-replace').hidden = text;
    if (overlay && !text) {
      const shape = itemAspect(item.id) ? itemAspect(item.id) / frameAspect() : mediaAspect(item);
      $('item-place').querySelectorAll('button').forEach((b) => {
        const p = T.placement(b.dataset.value, shape);
        Object.assign(b.firstChild.style, { left: `${p.box.x * 100}%`, top: `${p.box.y * 100}%`, width: `${p.box.w * 100}%`, height: `${p.box.h * 100}%` });
        const same = ['x', 'y', 'w', 'h'].every((k) => Math.abs(p.box[k] - item.box[k]) < 0.01);
        b.classList.toggle('on', same);
      });
      $('item-fit').querySelectorAll('button').forEach((b) => b.classList.toggle('on', b.dataset.value === item.fit));
      setSlider('item-size', item.box.w * 100);
      setSlider('item-x', item.box.x * 100);
      setSlider('item-y', item.box.y * 100);
    }
    if (overlay) {
      setSlider('item-opacity', (item.opacity ?? 1) * 100);
      setField('item-fade-in', item.fadeIn ?? 0);
      setField('item-fade-out', item.fadeOut ?? 0);
    }
    setSlider('item-volume', (item.volume ?? 0) * 100);
    $('item-duck').checked = item.duck !== false;
    setField('item-start', fmtTenths(item.startE));
    setField('item-length', item.length.toFixed(1));
    setField('item-offset', (item.offset || 0).toFixed(1));
  }

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

  function undo() {
    if (!state.undo.length) return;
    state.redo.push(snapshot());
    restore(state.undo.pop());
    setDirty(true);
    refresh();
  }

  function redo() {
    if (!state.redo.length) return;
    state.undo.push(snapshot());
    restore(state.redo.pop());
    setDirty(true);
    refresh();
  }

  function setSelection(anchor, focus = anchor) {
    state.anchor = anchor;
    state.focus = focus;
    if (anchor >= 0) {
      state.gapSel = null;
      state.itemSel = null;
    }
    refresh();
  }

  function clearSelection() {
    state.rangeSel = null;
    state.mainSel = false;
    state.gapSel = null;
    state.itemSel = null;
    setSelection(-1, -1);
  }

  // ---------- playback ----------

  function seek(t) {
    els.video.currentTime = Math.min(Math.max(0, t), duration());
    updatePlayhead();
  }

  function seekEdited(delta) {
    seek(E.toSource(state.kept, E.toEdited(state.kept, els.video.currentTime) + delta));
  }

  function togglePlay() {
    if (!state.media) return;
    if (els.video.paused) {
      const lastKept = state.kept[state.kept.length - 1];
      if (els.video.ended || (lastKept && els.video.currentTime >= lastKept[1] - 0.05)) seek(state.kept[0]?.[0] ?? 0);
      els.video.play().catch(showError);
    } else {
      els.video.pause();
    }
  }

  // Skip over cut regions while playing. rAF gives ~16 ms resolution, which is far finer than
  // timeupdate. No new jump starts while a seek is still in flight.
  function tick() {
    if (!els.video.paused && !els.video.seeking) {
      const skip = E.skipTarget(state.cuts, els.video.currentTime, duration());
      if (skip?.stopAt != null) {
        els.video.pause();
        els.video.currentTime = skip.stopAt;
      } else if (skip) {
        els.video.currentTime = skip.seekTo;
      }
      updatePlayhead();
    }
    requestAnimationFrame(tick);
  }

  els.video.addEventListener('play', () => { els.play.textContent = '❚❚'; });
  els.video.addEventListener('pause', () => { els.play.textContent = '▶'; updatePlayhead(); });
  els.video.addEventListener('seeked', updatePlayhead);
  els.video.addEventListener('loadedmetadata', () => {
    if (state.media && !state.media.duration) state.media.duration = els.video.duration;
    lastCaptionKey = null;
    refresh();
  });
  els.video.addEventListener('error', () => {
    if (state.media) toast('This file can be edited and exported, but the built-in player cannot preview its format.', { error: true, ms: 8000 });
  });
  els.play.addEventListener('click', togglePlay);
  els.back.addEventListener('click', () => seekEdited(-5));
  els.fwd.addEventListener('click', () => seekEdited(5));
  els.speed.addEventListener('change', () => {
    applyAudio();
  });

  // ---------- transcript: cursor, selection, typing ----------

  let dragging = false;
  let dragMoved = false;
  let dragFrom = -1;

  function wordIndexFrom(target) {
    const span = target.closest?.('.w');
    return span ? Number(span.dataset.i) : -1;
  }

  // Clicking a word puts the cursor before or after it, depending on which half was clicked.
  function caretFromPoint(i, clientX) {
    const r = spans[i].getBoundingClientRect();
    return clientX > r.left + r.width / 2 ? i + 1 : i;
  }

  els.transcript.addEventListener('mousedown', (e) => {
    if (e.button !== 0 || e.target.closest('.editing')) return;
    const speakerLabel = e.target.closest('.speaker-label');
    if (speakerLabel) {
      if (e.target.closest('input')) return;
      e.preventDefault();
      const id = speakerLabel.dataset.speaker || null;
      const sel = selectionRange();
      showSpeakerMenu(e.clientX, e.clientY + 8, sel ?? labelRange(speakerLabel), id);
      return;
    }
    const marker = e.target.closest('.del');
    if (marker) {
      e.preventDefault();
      restoreRun(Number(marker.dataset.from), Number(marker.dataset.to));
      return;
    }
    const i = wordIndexFrom(e.target);
    els.transcript.focus();
    if (i < 0) { clearSelection(); return; }
    e.preventDefault();
    state.gapSel = null;
    state.itemSel = null;
    if (e.shiftKey && (state.anchor >= 0 || state.caret != null)) {
      const from = state.anchor >= 0 ? state.anchor : Math.min(visibleFrom(state.caret), i);
      setSelection(from < 0 ? i : from, i);
      return;
    }
    dragging = true;
    dragMoved = false;
    dragFrom = i;
    state.caret = caretFromPoint(i, e.clientX);
    setSelection(-1, -1);
  });

  els.transcript.addEventListener('mousemove', (e) => {
    if (!dragging) return;
    const i = wordIndexFrom(e.target);
    if (i >= 0 && (i !== dragFrom || dragMoved) && i !== state.focus) {
      dragMoved = true;
      setSelection(dragFrom, i);
    }
  });

  window.addEventListener('mouseup', () => {
    if (!dragging) return;
    dragging = false;
    // A plain click moves the cursor and the playhead to that word.
    if (!dragMoved && dragFrom >= 0) seek(state.words[dragFrom].start);
  });

  els.transcript.addEventListener('dblclick', (e) => {
    const i = wordIndexFrom(e.target);
    if (i >= 0) beginEdit(i, i);
  });

  function transcriptFocused() {
    return document.activeElement === els.transcript;
  }

  // Move the cursor one visible word left or right; with Shift, grow the selection instead.
  function moveCaret(dir, extend) {
    const n = state.words.length;
    const sel = selectionRange();
    if (extend) {
      const anchor = state.anchor >= 0 ? state.anchor : (dir > 0 ? visibleFrom(state.caret ?? 0) : visibleBefore(state.caret ?? n));
      const base = state.focus >= 0 ? state.focus : anchor;
      const next = dir > 0 ? visibleFrom(base + (state.focus >= 0 ? 1 : 0)) : visibleBefore(state.focus >= 0 ? base : base + 1);
      if (anchor < 0 || next < 0) return;
      setSelection(anchor, next);
      keepVisible(spans[next]);
      return;
    }
    let caret = state.caret ?? 0;
    if (sel) caret = dir > 0 ? sel[1] + 1 : sel[0];
    else if (dir > 0) { const k = visibleFrom(caret); caret = k < 0 ? n : k + 1; }
    else { const k = visibleBefore(caret); caret = k < 0 ? 0 : k; }
    state.caret = caret;
    setSelection(-1, -1);
    const at = visibleFrom(caret) >= 0 ? visibleFrom(caret) : visibleBefore(n);
    if (at >= 0) { seek(state.words[at].start); keepVisible(spans[at]); }
  }

  // ---------- keyboard ----------

  window.addEventListener('keydown', (e) => {
    if (state.busy || e.target.closest?.('input, textarea, select, .editing')) return;
    const mod = e.metaKey || e.ctrlKey;
    const sel = selectionRange();
    if (e.key === ' ' && !mod) {
      e.preventDefault();
      togglePlay();
    } else if ((e.key === 'Backspace' || e.key === 'Delete') && !mod) {
      e.preventDefault();
      if (sel || state.rangeSel || state.gapSel != null || state.itemSel != null) cutSelection();
      else cutAtCaret(e.key === 'Delete');
    } else if (e.key === 'Escape') {
      clearSelection();
    } else if (e.key === 'Enter' && sel && hasProject()) {
      e.preventDefault();
      beginEdit(sel[0], sel[1]);
    } else if ((e.key === 'ArrowLeft' || e.key === 'ArrowRight') && !mod && hasProject()) {
      e.preventDefault();
      const dir = e.key === 'ArrowRight' ? 1 : -1;
      if (transcriptFocused() || e.shiftKey) moveCaret(dir, e.shiftKey);
      else seekEdited(dir * 5);
    } else if (e.key.length === 1 && !mod && !e.altKey && hasProject() && transcriptFocused() && (sel || state.caret != null)) {
      // Typing over a selection replaces its text, like a word processor. With just a
      // cursor, typing continues the word before it.
      e.preventDefault();
      if (sel) beginEdit(sel[0], sel[1], e.key);
      else {
        const k = visibleBefore(state.caret);
        if (k >= 0) beginEdit(k, k, state.words[k].text + e.key);
      }
    }
  });

  // ---------- file flows ----------

  function resetFor(media) {
    els.video.pause();
    state.loadToken++;
    state.media = media;
    state.words = [];
    state.language = null;
    state.speakers = {};
    state.deleted = new Set();
    state.cutGaps = new Set();
    state.splits = [];
    state.rangeCuts = [];
    state.rangeSel = null;
    state.tracks = [];
    state.undo = [];
    state.redo = [];
    state.anchor = state.focus = state.nowIndex = -1;
    state.gapSel = null;
    state.itemSel = null;
    state.caret = null;
    state.textVersion++;
    state.projectPath = null;
    els.video.src = media.url;
    state.clip = F.normalize(null);
    properties.setProps(state.clip, 0);
    applyAudio();
    els.video.hidden = !media.hasVideo;
    els.audioArt.hidden = media.hasVideo;
    els.audioName.textContent = media.name;
    for (const el of layerEls.values()) { el.pause?.(); el.remove(); }
    layerEls.clear();
    els.captionLayer.hidden = true;
    panels.setOrientation(media.width, media.height);
    setDirty(false);
  }

  // Waveform and filmstrip load in the background so editing can start right away.
  async function loadTimelineAssets() {
    const token = state.loadToken;
    timeline.setMedia({ words: state.words, duration: duration(), name: state.media?.name ?? '' });
    timeline.setStatus(state.media.hasVideo ? 'Loading waveform and thumbnails…' : 'Loading waveform…');
    refresh();
    try {
      const assets = await cutline.timeline(state.media);
      if (token !== state.loadToken) return;
      timeline.setAssets(assets);
      timeline.setStatus('');
    } catch (err) {
      if (token === state.loadToken) timeline.setStatus('Could not load the waveform');
      console.error(err);
    }
  }

  // Saved projects just finish saving; only a project that was never saved needs asking.
  async function confirmDiscard() {
    if (!state.dirty) return true;
    if (state.projectPath) {
      clearTimeout(autosaveTimer);
      await autosave();
      return true;
    }
    return window.confirm('Discard unsaved changes to the current project?');
  }

  // Cloud transcription: when the key in use runs out of credits, offer to switch to the next
  // enabled key and try again. Nothing switches without the user's OK.
  async function transcribeWithFailover(filePath) {
    for (;;) {
      try {
        return await cutline.transcribe(filePath, els.language.value || 'auto', els.quality.value || 'fast');
      } catch (err) {
        const m = /QUOTA:(\{.*\})/s.exec(String(err?.message ?? ''));
        if (!m) throw err;
        const { current, next } = JSON.parse(m[1]);
        const name = (k) => `“${k.label}” (••••${k.last4}${k.note ? `, ${k.note}` : ''})`;
        if (!next) throw new Error(`The ElevenLabs key ${current ? name(current) : ''} has run out of credits and there is no other enabled key. Add or enable one in API keys (⇧⌘K).`);
        hideOverlay();
        const ok = window.confirm(`The ElevenLabs key ${current ? name(current) : ''} has run out of credits.\n\nSwitch to ${name(next)} and try again?`);
        if (!ok) throw new Error('Transcription stopped: the key ran out of credits.');
        await cutline.selectKey('elevenlabs', next.id);
        toast(`Switched to “${next.label}”. Trying again…`);
        showOverlay('Transcribing with ElevenLabs…', `Using “${next.label}”`);
      }
    }
  }

  // Ask how to transcribe: an engine and a language, or skip. Resolves to
  // { quality, language }, 'skip', or null when cancelled. A remembered choice skips the question.
  let engineChoice = null;
  async function askTranscription(media, { allowSkip = true } = {}) {
    const read = (k) => { try { return localStorage.getItem(k); } catch { return null; } };
    const remembered = read('cutline.engine');
    if (remembered && read('cutline.askEngine') === 'no' && (allowSkip || remembered !== 'skip')) {
      return remembered === 'skip' ? 'skip' : { quality: remembered, language: els.language.value || 'auto' };
    }
    const { hasElevenLabsKey } = await cutline.settings();
    const dlg = $('engine-dialog');
    $('engine-file').textContent = media.name;
    $('engine-title').textContent = allowSkip ? 'Transcribe this video?' : 'Transcribe';
    const cloud = dlg.querySelector('[data-engine="cloud"]');
    cloud.disabled = !hasElevenLabsKey;
    $('engine-cloud-note').textContent = hasElevenLabsKey ? 'Best for Telugu. Also tells speakers apart.' : 'Add an ElevenLabs key in API keys (⇧⌘K) to use this.';
    dlg.querySelector('[data-engine="skip"]').hidden = !allowSkip;
    const lang = $('engine-language');
    if (!lang.options.length) for (const o of els.language.options) lang.add(new Option(o.text, o.value));
    lang.value = els.language.value || 'auto';
    $('engine-remember').checked = false;
    engineChoice = remembered && !(remembered === 'cloud' && !hasElevenLabsKey) && (allowSkip || remembered !== 'skip') ? remembered : (els.quality.value || 'fast');
    // Android only has ElevenLabs: without a key, start on Skip.
    if (IS_MOBILE && engineChoice !== 'skip' && (engineChoice !== 'cloud' || !hasElevenLabsKey)) engineChoice = hasElevenLabsKey ? 'cloud' : (allowSkip ? 'skip' : 'cloud');
    const paint = () => {
      dlg.querySelectorAll('[data-engine]').forEach((b) => b.classList.toggle('on', b.dataset.engine === engineChoice));
      $('engine-go').textContent = engineChoice === 'skip' ? 'Open without transcript' : 'Transcribe';
      lang.disabled = engineChoice === 'skip';
    };
    paint();
    dlg.hidden = false;
    return new Promise((resolve) => {
      const done = (value) => {
        dlg.hidden = true;
        dlg.querySelectorAll('[data-engine]').forEach((b) => { b.onclick = null; b.ondblclick = null; });
        $('engine-go').onclick = $('engine-cancel').onclick = dlg.onkeydown = null;
        resolve(value);
      };
      const go = () => {
        try {
          localStorage.setItem('cutline.engine', engineChoice);
          localStorage.setItem('cutline.askEngine', $('engine-remember').checked ? 'no' : 'yes');
        } catch {}
        if (engineChoice === 'skip') { done('skip'); return; }
        els.language.value = lang.value;
        els.quality.value = engineChoice;
        try { localStorage.setItem('cutline.language', lang.value); localStorage.setItem('cutline.quality', engineChoice); } catch {}
        done({ quality: engineChoice, language: lang.value });
      };
      dlg.querySelectorAll('[data-engine]').forEach((b) => {
        b.onclick = () => { engineChoice = b.dataset.engine; paint(); };
        b.ondblclick = () => { engineChoice = b.dataset.engine; go(); };
      });
      $('engine-go').onclick = go;
      $('engine-cancel').onclick = () => done(null);
      dlg.onkeydown = (e) => { e.stopPropagation(); if (e.key === 'Escape') done(null); if (e.key === 'Enter') go(); };
      $('engine-go').focus();
    });
  }

  // Transcribe the open media and put the words in the project (new or existing).
  async function transcribeInto(choice) {
    showOverlay('Preparing audio…', state.media.name);
    const { words, language } = await transcribeWithFailover(state.media.path);
    if (!words.length) throw new Error('No speech was found in this file.');
    const labelled = CutlineSpeakers.fromTranscript(E.applyWordList(words, wordList()));
    state.words = labelled.words;
    state.speakers = labelled.speakers;
    state.deleted = new Set();
    state.cutGaps = new Set();
    state.language = language;
    state.textVersion++;
    panels.setLanguage(language);
    renderTranscript();
    return { count: words.length, langName: languageNames[language] ?? language };
  }

  async function loadMedia(media) {
    if (!media) return;
    home.hide();
    resetFor(media);
    state.loadingMedia = true;
    refresh();
    const choice = await askTranscription(media);
    if (!choice) {
      state.loadingMedia = false;
      state.media = null;
      els.video.removeAttribute('src');
      els.video.load();
      refresh();
      showHome();
      return;
    }
    state.busy = true;
    refresh();
    try {
      let message;
      if (choice === 'skip') {
        message = 'Opened without a transcript. Use Transcribe… in the transcript pane whenever you want one.';
      } else {
        const { count, langName } = await transcribeInto(choice);
        message = `Transcribed ${count} words (${langName})`;
      }
      state.loadingMedia = false;
      renderTranscript();
      setDirty(true);
      // Every new project gets its own file in Talkcut Projects right away.
      try {
        state.projectPath = await cutline.createProject(buildProject(), media.name.replace(/\.[^.]+$/, ''));
        els.docTitle.textContent = projectName();
      } catch (err) { console.error(err); }
      setDirty(false);
      toast(choice === 'skip' ? message : `${message} and saved as “${projectName()}”.`, { ms: 6000 });
    } catch (err) {
      state.loadingMedia = false;
      els.transcriptWrap.hidden = true;
      els.empty.hidden = false;
      state.media = null;
      els.video.removeAttribute('src');
      els.video.load();
      showError(err);
      return;
    } finally {
      state.loadingMedia = false;
      state.busy = false;
      hideOverlay();
      refresh();
    }
    loadTimelineAssets();
  }

  // Transcribe a project that was opened without a transcript.
  async function transcribeLater() {
    if (!hasProject() || state.busy || state.words.length) return;
    const choice = await askTranscription(state.media, { allowSkip: false });
    if (!choice) return;
    state.busy = true;
    refresh();
    try {
      const { count, langName } = await transcribeInto(choice);
      state.undo = [];
      state.redo = [];
      setDirty(true);
      await autosave();
      toast(`Transcribed ${count} words (${langName}).`);
      timeline.setMedia({ words: state.words, duration: duration(), name: state.media?.name ?? '' });
    } catch (err) {
      showError(err);
    } finally {
      state.busy = false;
      hideOverlay();
      refresh();
    }
  }
  $('btn-transcribe-now').addEventListener('click', transcribeLater);

  async function openMedia() {
    if (state.busy || !(await confirmDiscard())) return;
    try {
      await loadMedia(await cutline.openMedia());
    } catch (err) { showError(err); }
    if (!state.media) showHome();
  }

  // ---------- home ----------

  const home = new CutlineHome({
    onNew: () => openMedia(),
    onOpen: (filePath) => (filePath === state.projectPath ? home.hide() : openProject(filePath)),
    onOpenDialog: () => openProject(),
    onBack: () => home.hide(),
    onError: showError,
    onToast: (msg) => toast(msg),
    currentPath: () => state.projectPath,
  });
  if (IS_MOBILE) {
    const hint = $('home-folder')?.parentElement;
    if (hint) hint.textContent = 'Projects and their videos are saved on this phone. Export a finished video to share it.';
  }

  async function showHome() {
    if (state.dirty && state.projectPath) await autosave();
    els.video.pause();
    await home.show({ canGoBack: hasProject() });
  }

  async function duplicateProject() {
    if (!state.projectPath) { toast('Save the project first.'); return; }
    await autosave();
    try {
      const copy = await cutline.duplicateProject(state.projectPath);
      toast(`Duplicated as “${baseName(copy).replace(/\.(talkcut|cutline)$/, '')}”.`);
    } catch (err) { showError(err); }
  }

  async function openProject(filePath = null) {
    if (state.busy || !(await confirmDiscard())) return;
    try {
      if (state.dirty) await autosave();
      const project = await cutline.openProject(filePath);
      if (!project) return;
      home.hide();
      resetFor(project.media);
      const valid = (i, min) => Number.isInteger(i) && i >= min && i < project.words.length;
      state.words = project.words;
      state.speakers = project.speakers && typeof project.speakers === 'object' ? project.speakers : {};
      state.language = project.language;
      state.deleted = new Set(project.deleted.filter((i) => valid(i, 0)));
      state.cutGaps = new Set(project.cutGaps.filter((i) => valid(i, -1)));
      const pair = (r) => Array.isArray(r) && r.length === 2 && r.every(Number.isFinite);
      state.splits = (project.splits ?? []).filter(Number.isFinite);
      state.rangeCuts = (project.rangeCuts ?? []).filter(pair);
      const withUrls = (tracks) => tracks.map((t) => ({ ...t, items: t.items.map((i) => (i.path ? { ...i, url: cutline.mediaUrl ? cutline.mediaUrl(i.path) : fileUrl(i.path) } : i)) }));
      state.tracks = withUrls(project.tracks
        ? T.normalize(project.tracks)
        : T.fromBroll(project.broll.map((b) => ({ ...b.media, id: b.id, name: b.name ?? b.media.name, start: b.start, length: b.length, offset: b.offset }))));
      state.clip = F.normalize(project.clip);
      properties.setProps(state.clip, 0);
      applyAudio();
      if (project.captions) {
        state.captions = C.settingsOf(project.captions);
        panels.setCaptions(state.captions);
      }
      panels.setLanguage(state.language);
      panels.setLibrary(state.tracks.flatMap((t) => t.items).filter((i) => i.path).map((i) => ({ path: i.path, url: i.url, name: i.name, kind: i.kind, thumb: i.thumb, duration: i.duration })));
      state.projectPath = project.filePath;
      renderTranscript();
      setDirty(false);
      refresh();
      loadTimelineAssets();
    } catch (err) { showError(err); }
  }

  // Everything a project file holds.
  function buildProject() {
    const { path, name, duration: d, hasVideo, hasAudio, width, height } = state.media;
    return {
      media: { path, name, duration: d, hasVideo, hasAudio, width, height },
      language: state.language,
      words: state.words,
      speakers: state.speakers,
      deleted: [...state.deleted].sort((a, b) => a - b),
      cutGaps: [...state.cutGaps].sort((a, b) => a - b),
      splits: state.splits,
      rangeCuts: state.rangeCuts,
      captions: state.captions,
      tracks: state.tracks.map((t) => ({ ...t, items: t.items.map(({ url, ...rest }) => rest) })),
      clip: state.clip,
    };
  }

  async function save(saveAs = false) {
    if (!hasProject() || state.busy) return;
    try {
      clearTimeout(autosaveTimer);
      const saved = await cutline.saveProject(buildProject(), state.projectPath, saveAs);
      if (!saved) return;
      state.projectPath = saved;
      els.docTitle.textContent = projectName();
      setDirty(false);
      toast(`Saved “${projectName()}”.`);
    } catch (err) { showError(err); }
  }

  // Name the project by editing its title.
  els.docTitle.addEventListener('click', () => {
    if (!state.projectPath || els.docTitle.isContentEditable) return;
    els.docTitle.contentEditable = 'plaintext-only';
    els.docTitle.focus();
    document.getSelection().selectAllChildren(els.docTitle);
    let done = false;
    const finish = async (keep) => {
      if (done) return;
      done = true;
      els.docTitle.contentEditable = 'false';
      const name = els.docTitle.textContent.trim();
      if (!keep || !name || name === projectName()) { els.docTitle.textContent = projectName(); return; }
      try {
        state.projectPath = await cutline.renameProject(state.projectPath, name);
        els.docTitle.textContent = projectName();
        setDirty(state.dirty);
        toast(`Renamed to “${projectName()}”.`);
      } catch (err) {
        els.docTitle.textContent = projectName();
        showError(err);
      }
    };
    els.docTitle.addEventListener('keydown', (e) => {
      e.stopPropagation();
      if (e.key === 'Enter') { e.preventDefault(); finish(true); }
      if (e.key === 'Escape') { e.preventDefault(); finish(false); }
    });
    els.docTitle.addEventListener('blur', () => finish(true), { once: true });
  });
  window.addEventListener('cutline:project-renamed', (e) => {
    if (e.detail.from === state.projectPath) {
      state.projectPath = e.detail.to;
      els.docTitle.textContent = projectName();
    }
  });

  // ---------- auto-framing ----------

  // Fill a frame shape (9:16 by default) around the speaker's face.
  async function autoFrame(canvas = '9:16') {
    if (!hasProject() || state.busy) return;
    if (!state.media.hasVideo) { toast('Auto-framing needs a video.', { error: true }); return; }
    state.busy = true;
    refresh();
    showOverlay('Finding the speaker…', 'Looking for faces across the video.', null);
    try {
      const face = await cutline.findFaces(state.media.path, duration());
      if (!face) {
        toast('No face found in most of the video, so the framing was left as it is. Use Fill and drag the video to frame it yourself.', { error: true, ms: 7000 });
        return;
      }
      const w = els.video.videoWidth || state.media.width;
      const h = els.video.videoHeight || state.media.height;
      commit({ clip: F.autoFrame(w, h, state.clip, face, canvas) });
      toast(`Framed for ${F.CANVASES[canvas].label} around the speaker (found in ${face.found} of ${face.frames} sampled frames). Drag the video to adjust; ⌘Z to undo.`, { ms: 6000 });
    } catch (err) {
      showError(err);
    } finally {
      state.busy = false;
      hideOverlay();
      refresh();
    }
  }
  $('prop-autoframe').addEventListener('click', () => autoFrame());
  $('ai-autoframe').addEventListener('click', () => autoFrame());
  $('ai-studio').addEventListener('click', () => {
    if (!hasProject()) return;
    commit({ clip: F.normalize({ ...state.clip, enhance: !state.clip.enhance }) });
    toast(state.clip.enhance ? 'Studio Sound is on. The export uses it too.' : 'Studio Sound is off.');
  });
  $('ai-find').addEventListener('click', () => openFind());
  $('ai-speakers').addEventListener('click', (e) => {
    const r = e.currentTarget.getBoundingClientRect();
    const sel = selectionRange();
    showSpeakerMenu(r.left - 230, r.top, sel, sel ? state.words[sel[0]].speaker : null);
  });

  // ---------- export dialog ----------

  let exportPreset = 'edited';
  function openExport() {
    if (!hasProject() || state.busy) return;
    const video = state.media.hasVideo;
    $('export-presets').querySelectorAll('button').forEach((b) => {
      b.disabled = !video && !['audio', 'captions'].includes(b.dataset.preset);
    });
    if (!video && !['audio', 'captions'].includes(exportPreset)) exportPreset = 'audio';
    $('export-edited-note').textContent = `${F.CANVASES[state.clip.canvas].label} · ${frameLayout().frame.w}×${frameLayout().frame.h}`;
    $('export-burn').checked = state.captions.enabled;
    renderExportDialog();
    $('export-dialog').hidden = false;
  }

  function renderExportDialog() {
    $('export-presets').querySelectorAll('button').forEach((b) => b.classList.toggle('on', b.dataset.preset === exportPreset));
    const subs = exportPreset === 'captions';
    $('export-video-options').hidden = subs || exportPreset === 'audio';
    $('export-sub-options').hidden = !subs;
    const notes = {
      edited: 'Exports the frame, captions, text and tracks exactly as you see them.',
      reels: 'Instagram Reels and YouTube Shorts. Text and overlays keep their place in the frame.',
      youtube: 'Wide video. A vertical clip gets bars on the sides; use Fill in Properties to crop instead.',
      square: 'Square posts and ads.',
      audio: 'Just the sound: voice, Studio Sound and music.',
      captions: 'Only the captions, timed to the edited video, to upload with it.',
    };
    $('export-note').textContent = notes[exportPreset];
    $('export-go').textContent = subs ? 'Save captions…' : 'Export…';
  }

  $('export-presets').querySelectorAll('button').forEach((b) => b.addEventListener('click', () => { exportPreset = b.dataset.preset; renderExportDialog(); }));
  const closeExport = () => { $('export-dialog').hidden = true; };
  $('export-close').addEventListener('click', closeExport);
  $('export-cancel').addEventListener('click', closeExport);
  $('export-dialog').addEventListener('keydown', (e) => { if (e.key === 'Escape') closeExport(); e.stopPropagation(); });
  $('export-go').addEventListener('click', () => {
    closeExport();
    if (exportPreset === 'captions') saveCaptionsFile($('export-sub-format').value);
    else exportMedia({ preset: exportPreset, quality: $('export-quality').value, burn: $('export-burn').checked, subtitles: $('export-srt').checked });
  });

  function subtitlesText(format) {
    return C.buildSubtitles({
      words: state.words, deleted: state.deleted, settings: state.captions, format,
      toEdited: (t) => E.toEdited(state.kept, t), speed: state.clip.speed,
    });
  }

  async function saveCaptionsFile(format) {
    if (!state.words.length) { toast('There are no words to make captions from.', { error: true }); return; }
    try {
      const out = await cutline.saveCaptions(state.media, subtitlesText(format), format);
      if (out) toast(`Saved ${baseName(out)}`, { ms: 6000 });
    } catch (err) {
      showError(err);
    }
  }

  async function exportMedia({ preset = 'edited', quality = null, burn = state.captions.enabled, subtitles = false } = {}) {
    if (!hasProject() || state.busy) return;
    const ranges = state.kept;
    if (!ranges.length) { toast('Everything is cut. Restore some words before exporting.', { error: true }); return; }
    els.video.pause();
    state.busy = true;
    refresh();
    // The save dialog opens first; the overlay appears once rendering reports progress.
    const stop = cutline.onExportProgress(({ progress }) => {
      showOverlay('Exporting…', `${Math.round(progress * 100)}%`, progress);
    });
    try {
      const out = await cutline.exportMedia(state.media, ranges, {
        ...T.forExport(state.tracks, state.kept),
        preset,
        quality,
        subtitles: subtitles && state.words.length ? { format: 'srt', content: subtitlesText('srt') } : null,
        captions: {
          settings: { ...state.captions, enabled: burn },
          words: state.words,
          deleted: [...state.deleted],
          language: state.language,
        },
        clip: state.clip,
      });
      if (out) toast(`Exported ${baseName(out)}`, { ms: 6000 });
    } catch (err) {
      showError(err);
    } finally {
      stop();
      state.busy = false;
      hideOverlay();
      refresh();
    }
  }

  cutline.onTranscribeProgress((p) => {
    if (p.stage === 'decode') showOverlay('Preparing audio…', state.media?.name ?? '');
    else if (p.stage === 'model') showOverlay(`Downloading speech model (${p.model})…`, `One time only, about ${p.megabytes} MB`, p.progress);
    else if (p.stage === 'detect') showOverlay('Detecting language…', 'Listening to a few parts of the recording');
    else if (p.stage === 'upload') showOverlay('Transcribing with ElevenLabs…', 'Uploading the audio and waiting for the transcript');
    else if (p.stage === 'transcribe') {
      const lang = languageNames[p.language] ?? p.language ?? '';
      showOverlay(`Transcribing${lang ? ` (${lang})` : ''}…`, `Running locally on this Mac · ${Math.round(p.progress * 100)}%`, p.progress);
    }
  });

  // ---------- settings ----------

  async function loadSettings() {
    const { languages, qualities } = await cutline.options();
    const read = (key, fallback) => { try { return localStorage.getItem(key) || fallback; } catch { return fallback; } };
    const savedLang = read('cutline.language', 'auto');
    const savedQuality = read('cutline.quality', 'fast');
    for (const { code, label } of languages) {
      languageNames[code] = label;
      els.language.add(new Option(label, code, false, code === savedLang));
    }
    for (const { code, label } of qualities) els.quality.add(new Option(label, code, false, code === savedQuality));
    const remember = (key, el) => el.addEventListener('change', () => { try { localStorage.setItem(key, el.value); } catch {} });
    remember('cutline.language', els.language);
    remember('cutline.quality', els.quality);
  }

  // ---------- API keys ----------

  // Several named keys per service; the active one is used. Keys never come back to the page,
  // only their labels and last four characters.
  const keysDialog = $('keys-dialog');
  let keysFromCloud = false;
  let qualityBeforeCloud = 'fast';

  function renderKeys(all) {
    keysDialog.querySelectorAll('.key-service').forEach((section) => {
      const service = section.dataset.service;
      const list = section.querySelector('.key-list');
      list.replaceChildren();
      const items = all[service] ?? [];
      if (!items.length) {
        const li = document.createElement('li');
        li.className = 'empty';
        li.textContent = 'No keys yet. Add one below.';
        list.appendChild(li);
      }
      for (const k of items) {
        const li = document.createElement('li');
        li.classList.toggle('active', k.active);
        const radio = document.createElement('input');
        radio.type = 'radio';
        radio.name = `active-${service}`;
        radio.checked = k.active;
        radio.title = 'Use this key';
        radio.addEventListener('change', () => keyAction(() => cutline.selectKey(service, k.id), `Now using “${k.label}”.`));
        const name = document.createElement('span');
        name.className = 'key-name';
        name.textContent = k.label;
        name.title = 'Double-click to rename';
        // Electron has no window.prompt, so the name is edited in place.
        name.addEventListener('dblclick', () => {
          name.contentEditable = 'plaintext-only';
          name.focus();
          document.getSelection().selectAllChildren(name);
          let done = false;
          const finish = (save) => {
            if (done) return;
            done = true;
            name.contentEditable = 'false';
            const label = name.textContent.trim();
            if (save && label && label !== k.label) keyAction(() => cutline.renameKey(service, k.id, label));
            else name.textContent = k.label;
          };
          name.addEventListener('keydown', (e) => {
            e.stopPropagation();
            if (e.key === 'Enter') { e.preventDefault(); finish(true); }
            if (e.key === 'Escape') { e.preventDefault(); finish(false); }
          });
          name.addEventListener('blur', () => finish(true), { once: true });
        });
        const last4 = document.createElement('span');
        last4.className = 'key-last4';
        last4.textContent = `••••${k.last4}`;
        // Name plus a note saying which account the key belongs to; click the note to edit it.
        const text = document.createElement('div');
        text.className = 'key-text';
        const note = document.createElement('span');
        note.className = 'key-note';
        const showNote = () => {
          note.textContent = k.note || 'Add a note (e.g. which account)…';
          note.classList.toggle('placeholder', !k.note);
        };
        showNote();
        note.title = 'Click to edit the note';
        note.addEventListener('click', () => {
          if (note.isContentEditable) return;
          note.contentEditable = 'plaintext-only';
          note.classList.remove('placeholder');
          note.textContent = k.note;
          note.focus();
          let done = false;
          const finish = (save) => {
            if (done) return;
            done = true;
            note.contentEditable = 'false';
            const value = note.textContent.trim();
            if (save && value !== k.note) keyAction(() => cutline.setKeyNote(service, k.id, value), value ? 'Note saved.' : 'Note removed.');
            else showNote();
          };
          note.addEventListener('keydown', (e) => {
            e.stopPropagation();
            if (e.key === 'Enter') { e.preventDefault(); finish(true); }
            if (e.key === 'Escape') { e.preventDefault(); finish(false); }
          });
          note.addEventListener('blur', () => finish(true), { once: true });
        });
        text.append(name, note);
        li.classList.toggle('disabled', !k.enabled);
        radio.disabled = !k.enabled;
        const toggle = document.createElement('label');
        toggle.className = 'toggle';
        toggle.title = k.enabled ? 'Enabled — click to disable' : 'Disabled — click to enable';
        const box = document.createElement('input');
        box.type = 'checkbox';
        box.checked = k.enabled;
        box.addEventListener('change', () => keyAction(() => cutline.enableKey(service, k.id, box.checked), box.checked ? `“${k.label}” enabled.` : `“${k.label}” disabled.`));
        toggle.append(box, document.createElement('span'));
        li.append(toggle, radio, text, last4);
        if (k.active) {
          const badge = document.createElement('span');
          badge.className = 'badge';
          badge.textContent = 'Active';
          li.appendChild(badge);
        }
        const remove = document.createElement('button');
        remove.type = 'button';
        remove.className = 'btn ghost';
        remove.textContent = 'Remove';
        remove.addEventListener('click', () => {
          if (window.confirm(`Remove the key “${k.label}” (••••${k.last4})?`)) keyAction(() => cutline.removeKey(service, k.id), 'Key removed.');
        });
        li.appendChild(remove);
        list.appendChild(li);
        if (service === 'elevenlabs') {
          const usage = document.createElement('li');
          usage.className = 'key-usage';
          usage.dataset.key = k.id;
          list.appendChild(usage);
          loadUsage(usage, k.id);
        }
      }
    });
  }

  // Credits used and left on an ElevenLabs key's account, and when they reset.
  async function loadUsage(row, id) {
    row.replaceChildren();
    const text = document.createElement('span');
    text.className = 'usage-text';
    text.textContent = 'Checking usage…';
    const bar = document.createElement('div');
    bar.className = 'usage-bar';
    const fill = document.createElement('div');
    bar.appendChild(fill);
    const refresh = document.createElement('button');
    refresh.type = 'button';
    refresh.className = 'btn ghost icon';
    refresh.title = 'Refresh usage';
    refresh.textContent = '↻';
    refresh.addEventListener('click', () => loadUsage(row, id));
    row.append(text, refresh, bar);
    try {
      const u = await cutline.keyUsage('elevenlabs', id);
      const left = Math.max(0, u.limit - u.used);
      const pct = u.limit ? Math.min(1, u.used / u.limit) : 0;
      const n = (x) => x.toLocaleString();
      const reset = u.resetsAt ? new Date(u.resetsAt).toLocaleString(undefined, { day: 'numeric', month: 'short', year: 'numeric', hour: 'numeric', minute: '2-digit' }) : 'unknown';
      text.textContent = `${n(u.used)} of ${n(u.limit)} credits used · ${n(left)} left · resets ${reset}${u.tier ? ` · ${u.tier} plan` : ''}`;
      fill.style.width = `${(pct * 100).toFixed(1)}%`;
      row.classList.toggle('low', pct >= 0.9);
    } catch (err) {
      text.textContent = String(err?.message ?? err).replace(/^Error invoking remote method '[^']+': (Error: )?/, '');
      bar.remove();
    }
  }

  async function keyAction(fn, message) {
    try {
      renderKeys(await fn());
      if (message) toast(message);
      panels.refreshStockSetup();
    } catch (err) {
      showError(err);
      renderKeys(await cutline.listKeys());
    }
  }

  async function openKeys(service = null, fromCloud = false) {
    keysFromCloud = fromCloud;
    renderKeys(await cutline.listKeys());
    keysDialog.hidden = false;
    hideAddForm();
    if (service) showAddForm(service);
  }

  async function closeKeys() {
    keysDialog.hidden = true;
    hideAddForm();
    // Choosing Cloud and closing without any ElevenLabs key goes back to the previous quality.
    if (keysFromCloud && !(await cutline.settings()).hasElevenLabsKey) {
      els.quality.value = qualityBeforeCloud;
      try { localStorage.setItem('cutline.quality', qualityBeforeCloud); } catch {}
    }
    keysFromCloud = false;
  }

  // One "Add API key" form: pick the service, then name, key and note.
  const addForm = $('key-add-form');
  function showAddForm(service) {
    addForm.hidden = false;
    $('btn-add-key').hidden = true;
    if (service) $('key-service').value = service;
    addForm.querySelector('.key-label').focus();
  }
  function hideAddForm() {
    addForm.hidden = true;
    $('btn-add-key').hidden = false;
    addForm.querySelectorAll('input').forEach((i) => { i.value = ''; });
  }
  $('btn-add-key').addEventListener('click', () => showAddForm());
  $('key-add-cancel').addEventListener('click', hideAddForm);
  addForm.addEventListener('submit', async (e) => {
    e.preventDefault();
    const service = $('key-service').value;
    const button = $('key-add-save');
    button.disabled = true;
    button.textContent = 'Checking…';
    try {
      renderKeys(await cutline.addKey(service, addForm.querySelector('.key-label').value, addForm.querySelector('.key-value').value, addForm.querySelector('.key-note-input').value));
      hideAddForm();
      toast('Key added and set as active.');
      panels.refreshStockSetup();
    } catch (err) {
      showError(err);
    } finally {
      button.disabled = false;
      button.textContent = 'Add key';
    }
  });
  keysDialog.querySelectorAll('[data-link]').forEach((a) => a.addEventListener('click', (e) => {
    e.preventDefault();
    cutline.openExternal(a.dataset.link);
  }));
  $('keys-close').addEventListener('click', closeKeys);
  keysDialog.addEventListener('mousedown', (e) => { if (e.target === keysDialog) closeKeys(); });
  keysDialog.addEventListener('keydown', (e) => { if (e.key === 'Escape') closeKeys(); });
  $('btn-keys').addEventListener('click', () => openKeys());

  els.quality.addEventListener('focus', () => { if (els.quality.value !== 'cloud') qualityBeforeCloud = els.quality.value; });
  els.quality.addEventListener('change', async () => {
    if (els.quality.value !== 'cloud') return;
    const { hasElevenLabsKey } = await cutline.settings();
    if (hasElevenLabsKey) toast('Cloud quality: the audio of files you open is sent to ElevenLabs for transcription.', { ms: 6000 });
    else openKeys('elevenlabs', true);
  });

  // ---------- drag and drop ----------

  let dragDepth = 0;
  window.addEventListener('dragenter', (e) => {
    if (![...(e.dataTransfer?.types ?? [])].includes('Files')) return;
    dragDepth++;
    els.dropHint.hidden = false;
  });
  window.addEventListener('dragleave', () => {
    dragDepth = Math.max(0, dragDepth - 1);
    if (!dragDepth) els.dropHint.hidden = true;
  });
  window.addEventListener('dragover', (e) => e.preventDefault());
  window.addEventListener('drop', async (e) => {
    e.preventDefault();
    dragDepth = 0;
    els.dropHint.hidden = true;
    const file = e.dataTransfer?.files?.[0];
    if (!file || state.busy || !(await confirmDiscard())) return;
    try {
      await loadMedia(await cutline.openDroppedFile(file));
    } catch (err) { showError(err); }
  });

  cutline.onOpenProjectPath((filePath) => { if (!state.busy) openProject(filePath); });

  cutline.onOpenPath(async (filePath) => {
    if (state.busy || !(await confirmDiscard())) return;
    try {
      await loadMedia(await cutline.openPath(filePath));
    } catch (err) { showError(err); }
  });

  // ---------- wiring ----------

  const b = els.buttons;
  b.open.addEventListener('click', openMedia);
  b.openEmpty.addEventListener('click', openMedia);
  b.openProject.addEventListener('click', () => openProject());
  $('btn-home').addEventListener('click', () => (home.visible && hasProject() ? home.hide() : showHome()));
  b.save.addEventListener('click', () => save());
  b.cut.addEventListener('click', () => cutSelection());
  b.restore.addEventListener('click', () => cutSelection({ restore: true }));
  b.fillers.addEventListener('click', removeFillers);
  b.retakes.addEventListener('click', removeRetakes);
  b.pauses.addEventListener('click', shortenPauses);
  b.undo.addEventListener('click', undo);
  b.redo.addEventListener('click', redo);
  b.export.addEventListener('click', openExport);

  cutline.onMenuCommand((name) => {
    if (state.busy) return;
    const commands = {
      'open-media': openMedia,
      'open-project': () => openProject(),
      'new-project': openMedia,
      home: showHome,
      'duplicate-project': duplicateProject,
      save: () => save(),
      'save-as': () => save(true),
      export: openExport,
      undo,
      redo,
      delete: () => cutSelection({ toggle: true }),
      restore: () => cutSelection({ restore: true }),
      'remove-fillers': () => hasProject() && removeFillers(),
      find: () => openFind(),
      settings: () => appearance.open(),
      'workspace-studio': () => appearance.useWorkspace('studio'),
      'workspace-video': () => appearance.useWorkspace('video'),
      'workspace-script': () => appearance.useWorkspace('script'),
      'workspace-reels': () => appearance.useWorkspace('reels'),
      'toggle-transcript': () => appearance.toggle('transcript'),
      'toggle-timeline': () => appearance.toggle('timeline'),
      'remove-retakes': () => hasProject() && removeRetakes(),
      'shorten-pauses': () => hasProject() && shortenPauses(),
      'api-keys': () => openKeys(),
      'select-all': () => hasProject() && setSelection(0, state.words.length - 1),
      'toggle-play': togglePlay,
      'seek-back': () => seekEdited(-5),
      'seek-forward': () => seekEdited(5),
    };
    commands[name]?.();
  });

  // ---------- timeline tools ----------

  const TOOL_KEYS = { a: 'select', h: 'hand', b: 'blade', r: 'range', y: 'slip' };
  const TOOL_ICONS = { select: '➤', hand: '✋', blade: '✂', range: '⟷', slip: '⇆' };
  const TOOL_HINTS = {
    select: 'Select: click words, pauses and B-roll; with blade splits, click a piece of the clip.',
    hand: 'Hand: drag the timeline to scroll.',
    blade: 'Blade: click the timeline to split the clip there.',
    range: 'Range: drag across the timeline to select a stretch of time, then press ⌫ to cut it.',
    slip: 'Slip: drag a B-roll video to change which part of it plays.',
  };
  function setTool(tool, announce = true) {
    state.tool = tool;
    timeline.setTool(tool);
    $('tool-icon').textContent = TOOL_ICONS[tool];
    $('tool-btn').title = `Timeline tool: ${tool[0].toUpperCase()}${tool.slice(1)}`;
    $('tool-menu').querySelectorAll('li').forEach((li) => li.classList.toggle('on', li.dataset.tool === tool));
    if (announce) toast(TOOL_HINTS[tool]);
  }
  $('tool-btn').addEventListener('click', (e) => {
    e.stopPropagation();
    $('tool-menu').hidden = !$('tool-menu').hidden;
  });
  $('tool-menu').querySelectorAll('li').forEach((li) => li.addEventListener('click', () => {
    $('tool-menu').hidden = true;
    setTool(li.dataset.tool);
  }));
  window.addEventListener('mousedown', (e) => { if (!e.target.closest('.tool-picker')) $('tool-menu').hidden = true; });
  window.addEventListener('keydown', (e) => {
    if (e.metaKey || e.ctrlKey || e.altKey || state.busy) return;
    if (e.target.closest?.('input, textarea, select, .editing, [contenteditable="plaintext-only"]')) return;
    // In the transcript, letters type text; tool keys work everywhere else.
    if (document.activeElement === els.transcript) return;
    const tool = TOOL_KEYS[e.key.toLowerCase()];
    if (tool && hasProject()) setTool(tool);
  });
  setTool('select', false);

  // Closing the window: finish the pending autosave first.
  cutline.onBeforeClose(async () => {
    clearTimeout(autosaveTimer);
    try { await autosave(); } finally { cutline.closeNow(); }
  });

  // ---------- canvas editing ----------

  // Natural shape of an overlay item (width / height), from its preview element.
  function itemAspect(id) {
    const el = layerEls.get(id);
    const w = el?.naturalWidth || el?.videoWidth;
    const h = el?.naturalHeight || el?.videoHeight;
    return w && h ? w / h : null;
  }

  function canvasTargets() {
    if (!hasProject() || !state.media?.hasVideo) return [];
    const r = contentRect();
    const L = frameLayout();
    const k = r.width / L.frame.w;
    const out = [{
      id: 'main', main: true, label: 'Video', size: `${Math.round(state.clip.scale * 100)}%`,
      rect: { x: L.draw.x * k, y: L.draw.y * k, w: L.draw.w * k, h: L.draw.h * k },
    }];
    const e = E.toEdited(state.kept, els.video.currentTime);
    for (const { track, item } of T.activeAt(state.tracks, state.kept, e)) {
      if (track.type !== 'overlay' || track.hidden) continue;
      out.push({
        id: item.id, label: item.kind === 'text' ? (item.text || 'Text') : item.name, size: `${Math.round(item.box.w * 100)}%`,
        rect: { x: item.box.x * r.width, y: item.box.y * r.height, w: item.box.w * r.width, h: item.box.h * r.height },
      });
    }
    const line = els.captionLayer.firstElementChild;
    if (!els.captionLayer.hidden && line) {
      const st = $('stage').getBoundingClientRect();
      const b = line.getBoundingClientRect();
      out.push({ id: 'captions', captions: true, label: 'Captions', size: `${Math.round(state.captions.scale * 100)}%`, rect: { x: b.left - st.left, y: b.top - st.top, w: b.width, h: b.height } });
    }
    return out;
  }

  let canvasBefore = null;
  let captionDragStart = null;
  // A picture rectangle on the stage back into clip scale and position.
  function clipFromRect(rect) {
    const r = contentRect();
    const L = frameLayout();
    const k = r.width / L.frame.w;
    const scale = state.clip.scale * ((rect.w / k) / L.draw.w);
    const sized = F.layout(els.video.videoWidth || state.media.width, els.video.videoHeight || state.media.height, { ...state.clip, scale, x: 0, y: 0 });
    const x = (rect.x / k - (L.frame.w - sized.draw.w) / 2) / L.frame.w;
    const y = (rect.y / k - (L.frame.h - sized.draw.h) / 2) / L.frame.h;
    return F.normalize({ ...state.clip, scale, x, y });
  }

  function canvasCommit() {
    if (!canvasBefore) return;
    state.undo.push(canvasBefore);
    if (state.undo.length > 500) state.undo.shift();
    state.redo = [];
    canvasBefore = null;
    setDirty(true);
    refresh();
  }

  canvasEditor = new CutlineCanvas($('stage'), {
    targets: canvasTargets,
    selected: () => (state.mainSel ? 'main' : state.captionSel ? 'captions' : state.itemSel),
    select: (id) => {
      state.mainSel = id === 'main';
      state.captionSel = id === 'captions';
      state.itemSel = id && id !== 'main' && id !== 'captions' ? id : null;
      if (id) { state.anchor = state.focus = -1; state.gapSel = null; state.rangeSel = null; }
      if (id === 'main') document.querySelector('.rail-btn[data-panel="properties"]:not(.on)')?.click();
      else if (id && T.find(state.tracks, id)?.item.kind === 'text') document.querySelector('.rail-btn[data-panel="elements"]:not(.on)')?.click();
      else if (id) openRailPanel('properties');
      refresh();
    },
    change: (id, rect, phase) => {
      if (phase === 'start') { canvasBefore = snapshot(); captionDragStart = id === 'captions' ? { rect: { ...rect }, scale: state.captions.scale } : null; return; }
      if (phase === 'cancel') { canvasBefore = null; return; }
      if (phase === 'end') { canvasCommit(); return; }
      if (id === 'captions') {
        const r = contentRect();
        const start = captionDragStart;
        const scale = start && Math.abs(rect.h - start.rect.h) > 0.5 ? start.scale * (rect.h / start.rect.h) : state.captions.scale;
        state.captions = C.settingsOf({ ...state.captions, position: 'custom', x: (rect.x + rect.w / 2) / r.width, y: (rect.y + rect.h / 2) / r.height, scale });
        panels.setCaptions(state.captions);
        lastCaptionKey = null;
        updatePlayhead();
        return;
      }
      if (id === 'main') {
        state.clip = clipFromRect(rect);
        properties.setProps(state.clip, editedLength());
      } else {
        const r = contentRect();
        state.tracks = T.update(state.tracks, id, { box: { x: rect.x / r.width, y: rect.y / r.height, w: rect.w / r.width, h: rect.h / r.height } });
      }
      lastCaptionKey = null;
      updatePlayhead();
    },
    action: (name, id) => canvasAction(name, id),
  });

  function canvasAction(name, id) {
    if (id === 'captions') {
      const before = snapshot();
      if (['top', 'middle', 'bottom'].includes(name)) state.captions = C.settingsOf({ ...state.captions, position: name });
      if (name === 'smaller' || name === 'bigger') state.captions = C.settingsOf({ ...state.captions, scale: state.captions.scale * (name === 'bigger' ? 1.15 : 1 / 1.15) });
      if (name === 'style') { openRailPanel('captions'); return; }
      if (name === 'off') { state.captions = C.settingsOf({ ...state.captions, enabled: false }); state.mainSel = false; state.itemSel = null; }
      state.undo.push(before);
      state.redo = [];
      panels.setCaptions(state.captions);
      setDirty(true);
      lastCaptionKey = null;
      refresh();
      updatePlayhead();
      return;
    }
    if (id === 'main') {
      const base = F.layout(els.video.videoWidth || state.media.width, els.video.videoHeight || state.media.height, { ...state.clip, scale: 1, x: 0, y: 0 });
      if (name === 'fit') commit({ clip: F.normalize({ ...state.clip, scale: 1, x: 0, y: 0 }) });
      if (name === 'fill') commit({ clip: F.normalize({ ...state.clip, scale: Math.max(base.frame.w / base.draw.w, base.frame.h / base.draw.h), x: 0, y: 0 }) });
      if (name === 'center') commit({ clip: F.normalize({ ...state.clip, x: 0, y: 0 }) });
      if (name === 'crop') startCrop();
      return;
    }
    const found = T.find(state.tracks, id);
    if (!found) return;
    const { box } = found.item;
    const r = contentRect();
    const frameAspect = r.width / r.height;
    const aspect = itemAspect(id) ?? box.w * frameAspect / box.h;
    const rel = aspect / frameAspect; // item width / height in frame fractions
    if (name === 'fit') {
      const w = rel >= 1 ? 1 : rel;
      const h = rel >= 1 ? 1 / rel : 1;
      commit({ tracks: T.update(state.tracks, id, { box: { x: (1 - w) / 2, y: (1 - h) / 2, w, h } }) });
    }
    if (name === 'fill') commit({ tracks: T.update(state.tracks, id, { box: { x: 0, y: 0, w: 1, h: 1 } }) });
    if (name === 'center') commit({ tracks: T.update(state.tracks, id, { box: { x: (1 - box.w) / 2, y: (1 - box.h) / 2 } }) });
    if (name === 'remove') { state.itemSel = null; commit({ tracks: T.remove(state.tracks, id) }); }
    if (name === 'forward' || name === 'backward') {
      const overlays = state.tracks.filter((t) => t.type === 'overlay');
      const i = overlays.findIndex((t) => t.id === found.track.id);
      const to = overlays[name === 'forward' ? i + 1 : i - 1];
      if (to) commit({ tracks: T.move(state.tracks, id, to.id) });
      else if (name === 'forward') {
        const tracks = T.addTrack(state.tracks, 'overlay');
        commit({ tracks: T.move(tracks, id, tracks.at(-1).id) });
      } else toast('Already on the lowest overlay track.');
    }
  }

  // ---------- crop on the video ----------

  // The whole picture in player pixels while cropping (the stage shows exactly that).
  function cropArea() {
    const r = contentRect();
    return { left: r.left, top: r.top, width: r.width, height: r.height };
  }

  const cropEditor = new CutlineCrop(els.player, {
    change: (rect) => { if (state.cropping) state.cropping.crop = F.displayToCrop(rect, state.clip); },
    rotate: (dir) => turnWhileCropping({ rotate: (state.clip.rotate + (dir > 0 ? 90 : 270)) % 360 }),
    flip: (axis) => turnWhileCropping(axis === 'h' ? { flipH: !state.clip.flipH } : { flipV: !state.clip.flipV }),
    done: () => finishCrop(true),
    cancel: () => finishCrop(false),
  });

  function startCrop() {
    if (!hasProject() || !state.media?.hasVideo || state.cropping) return;
    els.video.pause();
    state.cropping = { before: snapshot(), crop: { ...state.clip.crop } };
    state.itemSel = null;
    document.body.classList.add('cropping');
    canvasEditor?.setEnabled(false);
    const r = applyPreviewLayout();
    const L = frameLayout();
    cropEditor.srcPixels = { w: L.frame.w, h: L.frame.h };
    cropEditor.start(F.cropToDisplay(state.cropping.crop, state.clip), cropArea(), r.width / r.height);
    refresh();
  }

  function turnWhileCropping(change) {
    if (!state.cropping) return;
    state.clip = F.normalize({ ...state.clip, ...change });
    const r = applyPreviewLayout();
    const L = frameLayout();
    cropEditor.srcPixels = { w: L.frame.w, h: L.frame.h };
    cropEditor.setArea(cropArea(), r.width / r.height, F.cropToDisplay(state.cropping.crop, state.clip));
    properties.setProps(state.clip, editedLength());
  }

  function finishCrop(apply) {
    if (!state.cropping) return;
    const { before, crop } = state.cropping;
    state.cropping = null;
    cropEditor.stop();
    document.body.classList.remove('cropping');
    if (apply) {
      state.clip = F.normalize({ ...state.clip, crop });
      state.undo.push(before);
      if (state.undo.length > 500) state.undo.shift();
      state.redo = [];
      setDirty(true);
      toast('Cropped. Use Fit or Fill on the video to size it in the frame; ⌘Z to undo.');
    } else {
      restore(before);
    }
    lastCaptionKey = null;
    refresh();
    updatePlayhead();
  }
  $('prop-crop-canvas').addEventListener('click', startCrop);
  window.addEventListener('keydown', (e) => {
    if (!state.cropping) return;
    if (e.key === 'Escape') { e.preventDefault(); e.stopPropagation(); finishCrop(false); }
    if (e.key === 'Enter') { e.preventDefault(); e.stopPropagation(); finishCrop(true); }
  }, true);

  // Arrow keys nudge the selected picture or overlay (1%, Shift 10%).
  window.addEventListener('keydown', (e) => {
    if (!['ArrowLeft', 'ArrowRight', 'ArrowUp', 'ArrowDown'].includes(e.key)) return;
    if (document.activeElement === els.transcript || e.target.closest?.('input, textarea, select, [contenteditable="plaintext-only"]')) return;
    const id = state.mainSel ? 'main' : state.itemSel;
    if (!id || !hasProject()) return;
    const t = canvasTargets().find((x) => x.id === id);
    if (!t) return;
    e.preventDefault();
    e.stopImmediatePropagation();
    const r = contentRect();
    const step = (e.shiftKey ? 0.1 : 0.01);
    const dx = e.key === 'ArrowLeft' ? -step * r.width : e.key === 'ArrowRight' ? step * r.width : 0;
    const dy = e.key === 'ArrowUp' ? -step * r.height : e.key === 'ArrowDown' ? step * r.height : 0;
    canvasBefore = snapshot();
    const rect = { ...t.rect, x: t.rect.x + dx, y: t.rect.y + dy };
    if (id === 'main') state.clip = clipFromRect(rect);
    else state.tracks = T.update(state.tracks, id, { box: { x: rect.x / r.width, y: rect.y / r.height } });
    canvasCommit();
  }, true);

  // ---------- tracks: add menu ----------

  const addMenu = document.querySelector('.tl-add-menu');
  addMenu.querySelectorAll('li').forEach((li) => li.addEventListener('click', () => {
    addMenu.hidden = true;
    if (!hasProject()) return;
    const tracks = T.addTrack(state.tracks, li.dataset.add);
    commit({ tracks });
    toast(`Added “${tracks.at(-1).name}”. Add media from the Media panel; it goes on a free track.`);
  }));
  window.addEventListener('mousedown', (e) => {
    if (!e.target.closest('.tl-add-menu') && !e.target.closest('.tl-head-btn.add')) addMenu.hidden = true;
  });

  // ---------- look and layout ----------

  let lastSidebarPref = null;
  const appearance = new CutlineAppearance.Appearance({
    onLayout: (s) => {
      if (lastSidebarPref !== null && lastSidebarPref !== s.sidebar) {
        const active = document.querySelector('.rail-btn.on');
        if (!s.sidebar && active) active.click();
        if (s.sidebar && !active) openRailPanel('properties');
      }
      lastSidebarPref = s.sidebar;
      $('btn-toggle-transcript').classList.toggle('on', s.transcript);
      $('btn-toggle-timeline').classList.toggle('on', s.timeline);
      $('btn-toggle-sidebar').classList.toggle('on', Boolean(document.querySelector('.rail-btn.on')));
      requestAnimationFrame(() => window.dispatchEvent(new Event('resize')));
    },
    onTimelineHeight: (h) => setTimelineHeight(h),
  });
  $('btn-settings').addEventListener('click', () => appearance.open());
  $('btn-toggle-transcript').addEventListener('click', () => appearance.toggle('transcript'));
  $('btn-toggle-timeline').addEventListener('click', () => appearance.toggle('timeline'));
  $('btn-toggle-sidebar').addEventListener('click', () => {
    const active = document.querySelector('.rail-btn.on');
    if (active) active.click(); else openRailPanel('properties');
    $('btn-toggle-sidebar').classList.toggle('on', !active);
  });
  // ⌘1–⌘4 switch workspaces; ⌘, opens Settings.
  window.addEventListener('keydown', (e) => {
    if (!(e.metaKey || e.ctrlKey) || e.altKey || e.shiftKey) return;
    const ws = Object.entries(CutlineAppearance.WORKSPACES).find(([, w]) => w.key === e.key);
    if (ws) { e.preventDefault(); appearance.useWorkspace(ws[0]); toast(`${ws[1].label} workspace`); }
    if (e.key === ',') { e.preventDefault(); appearance.open(); }
  });

  // ---------- resizable timeline ----------

  const TL_MIN = 150;
  const tlMax = () => Math.round(window.innerHeight * 0.75);
  function setTimelineHeight(h, remember = true) {
    const height = Math.round(Math.min(tlMax(), Math.max(TL_MIN, h)));
    document.documentElement.style.setProperty('--timeline-height', `${height}px`);
    if (remember) { try { localStorage.setItem('cutline.timelineHeight', String(height)); } catch {} }
    window.dispatchEvent(new Event('resize'));
  }
  try { setTimelineHeight(Number(localStorage.getItem('cutline.timelineHeight')) || 300, false); } catch { setTimelineHeight(300, false); }
  $('tl-resize').addEventListener('mousedown', (e) => {
    e.preventDefault();
    const y0 = e.clientY;
    const h0 = $('timeline').getBoundingClientRect().height;
    $('tl-resize').classList.add('dragging');
    const move = (ev) => setTimelineHeight(h0 + (y0 - ev.clientY));
    const up = () => {
      $('tl-resize').classList.remove('dragging');
      window.removeEventListener('mousemove', move);
      window.removeEventListener('mouseup', up);
    };
    window.addEventListener('mousemove', move);
    window.addEventListener('mouseup', up);
  });
  // ⌥⌘T switches between a compact and a tall timeline.
  window.addEventListener('keydown', (e) => {
    if (e.code === 'KeyT' && e.altKey && (e.metaKey || e.ctrlKey)) {
      e.preventDefault();
      const h = $('timeline').getBoundingClientRect().height;
      setTimelineHeight(h > 260 ? 180 : Math.max(380, Math.round(window.innerHeight * 0.45)));
    }
  });
  new ResizeObserver(() => { lastCaptionKey = null; updatePlayhead(); }).observe(els.player);

  // Read-only view and entry points for DevTools and automated checks.
  Object.defineProperty(window, 'cutlineState', { get: () => state });
  Object.defineProperty(window, 'cutlineTest', {
    value: Object.freeze({
      openPath: async (p) => loadMedia(await cutline.openPath(p)),
      insertBroll: async (p) => insertMedia(await cutline.describeBroll(p)),
      insertText,
      insertAudio: async (p) => insertMedia(await cutline.describeAudio(p)),
      openProject: (p) => openProject(p),
      exportMedia,
      saveCaptionsFile,
      autoFrame,
      showSpeakerMenu,
      startCrop,
    }),
  });

  loadSettings().catch(showError);
  showHome();
  refresh();
  requestAnimationFrame(tick);
})();
