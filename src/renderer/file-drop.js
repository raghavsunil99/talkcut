// Opening files: dropping media or a project on the window, and files sent from the menu or the Dock.
// Split out of app.js; app.js passes in what it shares (see the create() call there).
(function (root) {
  function create({ $, els, state, hasProject, loadMedia, openProject, confirmDiscard, insertMedia, panels, toast, showError }) {
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


  }

  root.CutlineFileDrop = { create };
})(window);
