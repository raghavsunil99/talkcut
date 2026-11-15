// The command palette (⌘K): every menu command, found by typing part of its name.
// Split out of app.js; app.js passes in what it shares (see the create() call there).
(function (root) {
  // Commands as the menus name them, with their shortcuts. `run` is the menu command name.
  const COMMANDS = [
    ['Export…', '⌘E', 'export'],
    ['New project from a file…', '⌘N', 'new-project'],
    ['Open project…', '⇧⌘O', 'open-project'],
    ['Projects home', '⇧⌘H', 'home'],
    ['Save project', '⌘S', 'save'],
    ['Save project as…', '⇧⌘S', 'save-as'],
    ['Duplicate project', '', 'duplicate-project'],
    ['Add recording to end…', '', 'add-recording'],
    ['Undo', '⌘Z', 'undo'],
    ['Redo', '⇧⌘Z', 'redo'],
    ['Cut selection', '⌫', 'delete'],
    ['Restore selection', '⌘⌫', 'restore'],
    ['Find and replace…', '⌘F', 'find'],
    ['Remove filler words…', '⇧⌘F', 'remove-fillers'],
    ['Remove retakes…', '⇧⌘R', 'remove-retakes'],
    ['Shorten pauses…', '⇧⌘P', 'shorten-pauses'],
    ['Studio Sound on or off', '', 'studio-sound'],
    ['Auto-frame for 9:16', '', 'auto-frame'],
    ['Captions on or off', '', 'captions-toggle'],
    ['Select all words', '⌘A', 'select-all'],
    ['Play or pause', 'Space', 'toggle-play'],
    ['Back 5 seconds', '←', 'seek-back'],
    ['Forward 5 seconds', '→', 'seek-forward'],
    ['Show cut words', '', 'toggle-show-cut'],
    ['Show or hide transcript', '', 'toggle-transcript'],
    ['Show or hide timeline', '', 'toggle-timeline'],
    ['Collapse or open timeline', '⌥⌘T', 'collapse-timeline'],
    ['Studio workspace', '⌘1', 'workspace-studio'],
    ['Video first workspace', '⌘2', 'workspace-video'],
    ['Script first workspace', '⌘3', 'workspace-script'],
    ['Reels workspace', '⌘4', 'workspace-reels'],
    ['Settings…', '⌘,', 'settings'],
    ['API keys…', '⇧⌘K', 'api-keys'],
  ];

  // Matches when every typed word starts a word of the name, or appears in it.
  function matches(label, query) {
    const name = label.toLowerCase();
    return query.toLowerCase().split(/\s+/).filter(Boolean).every((q) => name.includes(q));
  }

  function create({ $, runCommand }) {
    const box = $('palette');
    const input = $('palette-input');
    const list = $('palette-list');
    let shown = [];
    let at = 0;

    function render() {
      shown = COMMANDS.filter(([label]) => matches(label, input.value));
      at = Math.min(at, Math.max(0, shown.length - 1));
      list.replaceChildren(...shown.map(([label, keys, name], k) => {
        const li = document.createElement('li');
        li.className = k === at ? 'on' : '';
        li.dataset.command = name;
        li.textContent = label;
        if (keys) { const kbd = document.createElement('kbd'); kbd.textContent = keys; li.appendChild(kbd); }
        li.addEventListener('mousedown', (e) => { e.preventDefault(); run(k); });
        return li;
      }));
      if (!shown.length) { const li = document.createElement('li'); li.className = 'empty'; li.textContent = 'No command matches'; list.appendChild(li); }
    }

    function open() {
      input.value = '';
      at = 0;
      render();
      box.hidden = false;
      input.focus();
    }

    function close() { box.hidden = true; }

    function run(k) {
      const cmd = shown[k];
      if (!cmd) return;
      close();
      runCommand(cmd[2]);
    }

    input.addEventListener('input', () => { at = 0; render(); });
    input.addEventListener('keydown', (e) => {
      e.stopPropagation();
      if (e.key === 'ArrowDown') { e.preventDefault(); at = Math.min(shown.length - 1, at + 1); render(); list.children[at]?.scrollIntoView({ block: 'nearest' }); }
      else if (e.key === 'ArrowUp') { e.preventDefault(); at = Math.max(0, at - 1); render(); list.children[at]?.scrollIntoView({ block: 'nearest' }); }
      else if (e.key === 'Enter') { e.preventDefault(); run(at); }
      else if (e.key === 'Escape') { e.preventDefault(); close(); }
    });
    box.addEventListener('mousedown', (e) => { if (e.target === box) close(); });
    $('btn-palette')?.addEventListener('click', open);

    return { open, close, COMMANDS };
  }

  root.CutlinePalette = { create, COMMANDS, matches };
})(window);
