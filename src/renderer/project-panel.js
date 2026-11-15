// The Project panel: name, transcript language, the recordings in the project, and (moved here
// from Properties) canvas size and export loudness, which belong to the project as a whole.
// Split out of app.js; app.js passes in what it shares (see the create() call there).
(function (root) {
  function create({ $, els, state, languageNames, hasProject, setDirty, refresh, renderTranscript, panels, addRecording, projectName, toast, showError }) {
    const name = $('proj-name');
    const lang = $('proj-language');

    function render() {
      if (document.activeElement !== name) name.value = hasProject() ? projectName() : '';
      name.disabled = !state.projectPath;
      if (!lang.options.length || lang.options.length !== Object.keys(languageNames).length) {
        lang.replaceChildren(...Object.entries(languageNames).filter(([code]) => code !== 'auto').map(([code, label]) => new Option(label, code)));
      }
      lang.value = state.language ?? '';
      lang.disabled = !hasProject();
      const files = state.media?.sources ?? (state.media ? [{ name: state.media.name, duration: state.media.duration }] : []);
      $('proj-sources').replaceChildren(...files.map((f) => {
        const li = document.createElement('li');
        li.textContent = f.name;
        const d = document.createElement('span');
        d.className = 'muted';
        const s = Math.round(f.duration || 0);
        d.textContent = ` ${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`;
        li.appendChild(d);
        return li;
      }));
      $('proj-add-recording').disabled = !hasProject() || state.busy;
    }

    name.addEventListener('keydown', async (e) => {
      e.stopPropagation();
      if (e.key === 'Escape') { name.value = projectName(); name.blur(); return; }
      if (e.key !== 'Enter' || !state.projectPath) return;
      const want = name.value.trim();
      if (!want || want === projectName()) return;
      try {
        state.projectPath = await cutline.renameProject(state.projectPath, want);
        els.docTitle.textContent = projectName();
        setDirty(state.dirty);
        toast(`Renamed to “${projectName()}”.`);
        name.blur();
      } catch (err) { showError(err); name.value = projectName(); }
    });
    lang.addEventListener('change', () => {
      state.language = lang.value;
      panels.setLanguage(state.language);
      setDirty(true);
      renderTranscript();
      refresh();
    });
    $('proj-add-recording').addEventListener('click', () => addRecording());

    return { render };
  }

  root.CutlineProjectPanel = { create };
})(window);
