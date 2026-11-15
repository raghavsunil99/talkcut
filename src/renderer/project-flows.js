// Project flows: opening media, the transcription prompt, the home screen, and opening, saving and renaming projects.
// Split out of app.js; app.js passes in what it shares (see the create() call there).
(function (root) {
  function create({ $, els, state, E, C, F, T, timeline, properties, panels, IS_MOBILE, languageNames, baseName, fileUrl, hasProject, duration, projectName, setDirty, autosave, cancelAutosave, wordList, refresh, renderTranscript, applyAudio, layerEls, toast, showError, showOverlay, hideOverlay }) {
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
        cancelAutosave();
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
      let choice = await askTranscription(media);
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
        let failure = null;
        if (choice === 'skip') {
          message = 'Opened without a transcript. Use Transcribe… in the transcript pane whenever you want one.';
        } else {
          try {
            const { count, langName } = await transcribeInto(choice);
            message = `Transcribed ${count} words (${langName})`;
          } catch (err) {
            // Keep the video open; it can be edited without a transcript and transcribed later.
            failure = String(err?.message ?? err).replace(/^Error invoking remote method '[^']+': (Error: )?/, '');
            choice = 'skip';
            message = `Transcription failed: ${failure.replace(/[.\s]*$/, '')}. The video is open without a transcript. Use Transcribe… in the transcript pane to try again.`;
          }
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
        toast(choice === 'skip' ? message : `${message} and saved as “${projectName()}”.`, failure ? { error: true, ms: 12000 } : { ms: 6000 });
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
        cancelAutosave();
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

    return { loadMedia, openMedia, openProject, save, showHome, duplicateProject, buildProject, confirmDiscard, home };
  }

  root.CutlineProjectFlows = { create };
})(window);
