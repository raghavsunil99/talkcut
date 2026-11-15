// Timeline tools: Select, Hand, Blade, Range and Slip, with their keys and the tool menu.
// Split out of app.js; app.js passes in what it shares (see the create() call there).
(function (root) {
  function create({ $, els, state, timeline, hasProject, toast }) {
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

    return { setTool };
  }

  root.CutlineTimelineTools = { create };
})(window);
