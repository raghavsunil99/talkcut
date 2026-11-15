// API keys dialog: named keys per service, usage, add/rename/note/enable/remove.
// Split out of app.js; app.js passes in what it shares (see the create() call there).
(function (root) {
  function create({ $, els, toast, showError, panels }) {
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
    $('btn-keys')?.addEventListener('click', () => openKeys());

    els.quality.addEventListener('focus', () => { if (els.quality.value !== 'cloud') qualityBeforeCloud = els.quality.value; });
    els.quality.addEventListener('change', async () => {
      if (els.quality.value !== 'cloud') return;
      const { hasElevenLabsKey } = await cutline.settings();
      if (hasElevenLabsKey) toast('Cloud quality: the audio of files you open is sent to ElevenLabs for transcription.', { ms: 6000 });
      else openKeys('elevenlabs', true);
    });

    return { openKeys };
  }

  root.CutlineKeysDialog = { create };
})(window);
