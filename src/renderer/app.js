/* global CutlineEdits, CutlineCaptions, CutlineTimeline, CutlinePanels, CutlineFrame, CutlineProperties, CutlineTracks, cutline */
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
  // Modules get the current list through this; renderTranscript() replaces the array.
  const getSpans = () => spans;
  const getCanvasEditor = () => canvasEditor;
  // The caption preview redraws only when its key changes; this forces the next redraw.
  const resetCaptionCache = () => mod.preview?.resetCaptionCache();
  // Split-out modules, filled in as each is created. Functions that refresh() calls go through
  // here, because refresh() can run before a module exists.
  const mod = {};
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
  const cancelAutosave = () => clearTimeout(autosaveTimer);
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
  // Resolves to false when the save failed. `force` saves even while a long job is running
  // (closing the window must not wait for one).
  async function autosave(force = false) {
    if (!state.projectPath || !hasProject()) return true;
    if (state.busy && !force) { autosaveTimer = setTimeout(() => autosave(), 1500); return true; }
    if (saving) await saving;
    setSaveStatus('Saving…');
    saving = cutline.saveProject(buildProject(), state.projectPath, false, true)
      .then(() => { if (!autosaveTimer || state.dirty) setDirty(false); return true; })
      .catch((err) => { setSaveStatus('Not saved', true); showError(err); return false; })
      .finally(() => { saving = null; });
    return saving;
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
        resetCaptionCache();
        applyAudio();
        updatePlayhead();
      }
      applyAudio();
    },
  });

  const panels = new CutlinePanels.Panels({
    onCaptionsChange: (settings) => {
      if (hasProject()) commit({ captions: settings });
      else { state.captions = settings; refresh(); }
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
    resetCaptionCache();
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
  mod.preview = CutlinePreview.create({ $, els, state, E, C, F, T, timeline, mod, hasProject, getSpans, getCanvasEditor, toast, showError, fmtTenths });
  const { frameLayout, contentRect, applyPreviewLayout, applyAudio, updatePlayhead, keepVisible, layerEls } = mod.preview;

  // ---------- edits ----------

  function snapshot() {
    return { words: state.words, deleted: new Set(state.deleted), cutGaps: new Set(state.cutGaps), tracks: state.tracks, clip: state.clip, splits: state.splits, rangeCuts: state.rangeCuts, captions: state.captions, speakers: state.speakers };
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
    if (snap.speakers) state.speakers = snap.speakers;
    if (snap.captions && snap.captions !== state.captions) { state.captions = snap.captions; panels.setCaptions(state.captions); }
    if (state.itemSel && !T.find(state.tracks, state.itemSel)) state.itemSel = null;
    state.textVersion++;
  }

  function commit({ words = state.words, deleted = state.deleted, cutGaps = state.cutGaps, tracks = state.tracks, clip = state.clip, splits = state.splits, rangeCuts = state.rangeCuts, captions = state.captions, speakers = state.speakers }) {
    state.undo.push(snapshot());
    if (state.undo.length > 500) state.undo.shift();
    state.redo = [];
    restore({ words, deleted, cutGaps, tracks, clip, splits, rangeCuts, captions, speakers });
    setDirty(true);
    refresh();
  }


  // Created in this order: each module uses functions from the ones above it.
  mod.inspector = CutlineItemInspector.create({ $, els, state, E, T, panels, frameLayout, itemAspect, commit, refresh, setDirty, snapshot, updatePlayhead, editedLength, fmtTenths, showError, getCanvasEditor, resetCaptionCache });
  const { openRailPanel, brollPlacement, mediaAspect } = mod.inspector;
  function renderItemInspector() { mod.inspector?.renderItemInspector(); }
  const { cutSelection, cutAtCaret, restoreRun, beginEdit, removeFillers, removeRetakes, shortenPauses, insertMedia } = CutlineEditCommands.create({ $, els, state, E, T, getSpans, hasProject, duration, editedLength, selectionRange, visibleFrom, visibleBefore, commit, refresh, brollPlacement, mediaAspect, openRailPanel, fmtTenths, toast });
  // Speakers first: the find module uses showSpeakerMenu.
  const { showSpeakerMenu, labelRange } = CutlineSpeakersUI.create({ $, els, state, selectionRange, commit, renderTranscript, refresh });
  const { wordList, openFind } = CutlineFindReplace.create({ $, els, state, E, getSpans, hasProject, selectionRange, setSelection, visibleFrom, wordIndexFrom, beginEdit, cutSelection, showSpeakerMenu, seek, commit, renderTranscript, toast });


  mod.textEditor = CutlineTextEditor.create({ $, els, state, E, T, hasProject, editedLength, commit, snapshot, setDirty, refresh, updatePlayhead, toast });
  const { insertText } = mod.textEditor;
  function renderTextEditor() { mod.textEditor?.renderTextEditor(); }

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
    resetCaptionCache();
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

  const { loadMedia, openMedia, openProject, save, showHome, duplicateProject, buildProject, confirmDiscard, home } = CutlineProjectFlows.create({ $, els, state, E, C, F, T, timeline, properties, panels, IS_MOBILE, languageNames, baseName, fileUrl, hasProject, duration, projectName, setDirty, autosave, cancelAutosave, wordList, refresh, renderTranscript, applyAudio, layerEls, toast, showError, showOverlay, hideOverlay });

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

  const { openExport, saveCaptionsFile, exportMedia } = CutlineExportDialog.create({ $, els, state, F, C, E, T, frameLayout, hasProject, refresh, toast, showError, showOverlay, hideOverlay, baseName });

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

  const { openKeys } = CutlineKeysDialog.create({ $, els, toast, showError, panels });

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
    // In a text field (API key, names, find), Undo, Redo and Select All act on the field's text.
    const field = document.activeElement?.closest?.('input, textarea, [contenteditable="true"], [contenteditable="plaintext-only"], .editing');
    const fieldCommands = { undo: 'undo', redo: 'redo', 'select-all': 'selectAll' };
    if (field && fieldCommands[name]) {
      document.execCommand(fieldCommands[name]);
      return;
    }
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
    // Close only once the project is safely on disk; otherwise stay open (the error is shown).
    if (await autosave(true)) cutline.closeNow();
    else cutline.cancelClose?.();
  });

  // ---------- canvas editing ----------

  // Natural shape of an overlay item (width / height), from its preview element.
  function itemAspect(id) {
    const el = layerEls.get(id);
    const w = el?.naturalWidth || el?.videoWidth;
    const h = el?.naturalHeight || el?.videoHeight;
    return w && h ? w / h : null;
  }

  mod.canvas = CutlineCanvasController.create({ $, els, state, E, F, C, T, panels, properties, hasProject, contentRect, frameLayout, applyPreviewLayout, itemAspect, openRailPanel, snapshot, restore, commit, setDirty, refresh, updatePlayhead, editedLength, toast, resetCaptionCache });
  const { startCrop } = mod.canvas;
  canvasEditor = mod.canvas.canvasEditor;

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
  new ResizeObserver(() => { resetCaptionCache(); updatePlayhead(); }).observe(els.player);

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
