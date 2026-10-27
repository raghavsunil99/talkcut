/* global cutline */
// Home screen: recent projects with New project / Open…, and per-project rename, duplicate,
// show in Finder and move to Trash.
(function (root) {
  const $ = (id) => document.getElementById(id);

  function ago(ms) {
    const s = Math.max(0, (Date.now() - ms) / 1000);
    if (s < 60) return 'just now';
    if (s < 3600) return `${Math.floor(s / 60)} min ago`;
    if (s < 86400) return `${Math.floor(s / 3600)} h ago`;
    if (s < 86400 * 7) return `${Math.floor(s / 86400)} d ago`;
    return new Date(ms).toLocaleDateString(undefined, { day: 'numeric', month: 'short', year: 'numeric' });
  }

  function len(seconds) {
    if (!Number.isFinite(seconds)) return '';
    return `${Math.floor(seconds / 60)}:${String(Math.floor(seconds % 60)).padStart(2, '0')}`;
  }

  class Home {
    constructor({ onNew, onOpen, onOpenDialog, onBack, onError, onToast, currentPath }) {
      Object.assign(this, { onNew, onOpen, onOpenDialog, onBack, onError, onToast, currentPath });
      this.el = $('home');
      $('home-new').addEventListener('click', () => this.onNew());
      $('home-open').addEventListener('click', () => this.onOpenDialog());
      $('home-back').addEventListener('click', () => this.onBack());
      $('home-folder').addEventListener('click', async (e) => {
        e.preventDefault();
        const dir = await cutline.projectsDir();
        cutline.revealProject(dir);
      });
    }

    get visible() {
      return !this.el.hidden;
    }

    async show({ canGoBack }) {
      this.el.hidden = false;
      $('home-back').hidden = !canGoBack;
      await this.render();
    }

    hide() {
      this.el.hidden = true;
    }

    async render() {
      const grid = $('home-grid');
      let list = [];
      try { list = await cutline.recentProjects(); } catch (err) { this.onError(err); }
      grid.replaceChildren();
      $('home-empty').hidden = list.length > 0;
      for (const p of list) grid.appendChild(this.card(p));
    }

    card(p) {
      const card = document.createElement('div');
      card.className = 'project-card';
      card.tabIndex = 0;
      card.title = p.path;
      const thumb = document.createElement('div');
      thumb.className = 'project-thumb';
      if (p.thumb) {
        const img = document.createElement('img');
        img.src = p.thumb;
        img.alt = '';
        thumb.appendChild(img);
      } else {
        thumb.textContent = '♪';
      }
      if (p.duration) {
        const d = document.createElement('span');
        d.className = 'badge';
        d.textContent = len(p.duration);
        thumb.appendChild(d);
      }
      const name = document.createElement('div');
      name.className = 'project-name';
      name.textContent = p.name;
      const meta = document.createElement('div');
      meta.className = 'project-meta';
      meta.textContent = [p.mediaName, `edited ${ago(p.updatedAt)}`].filter(Boolean).join(' · ');
      const actions = document.createElement('div');
      actions.className = 'project-actions';
      const action = (label, title, fn) => {
        const b = document.createElement('button');
        b.type = 'button';
        b.className = 'btn ghost icon';
        b.textContent = label;
        b.title = title;
        b.addEventListener('click', (e) => { e.stopPropagation(); fn(); });
        actions.appendChild(b);
      };
      action('✎', 'Rename', () => this.rename(p, name));
      action('⧉', 'Duplicate', () => this.duplicate(p));
      if (cutline.platform !== 'android') action('⌕', 'Show in Finder', () => cutline.revealProject(p.path));
      action('🗑', 'Move to Trash', () => this.trash(p));
      card.append(thumb, name, meta, actions);
      card.addEventListener('click', () => this.onOpen(p.path));
      card.addEventListener('keydown', (e) => { if (e.key === 'Enter' && e.target === card) this.onOpen(p.path); });
      return card;
    }

    rename(p, nameEl) {
      nameEl.contentEditable = 'plaintext-only';
      nameEl.focus();
      document.getSelection().selectAllChildren(nameEl);
      let done = false;
      const finish = async (save) => {
        if (done) return;
        done = true;
        nameEl.contentEditable = 'false';
        const name = nameEl.textContent.trim();
        if (!save || !name || name === p.name) { nameEl.textContent = p.name; return; }
        try {
          const renamed = await cutline.renameProject(p.path, name);
          root.dispatchEvent(new CustomEvent('cutline:project-renamed', { detail: { from: p.path, to: renamed } }));
          await this.render();
        } catch (err) {
          nameEl.textContent = p.name;
          this.onError(err);
        }
      };
      nameEl.addEventListener('click', (e) => e.stopPropagation());
      nameEl.addEventListener('keydown', (e) => {
        e.stopPropagation();
        if (e.key === 'Enter') { e.preventDefault(); finish(true); }
        if (e.key === 'Escape') { e.preventDefault(); finish(false); }
      });
      nameEl.addEventListener('blur', () => finish(true), { once: true });
    }

    async duplicate(p) {
      try {
        await cutline.duplicateProject(p.path);
        this.onToast(`Duplicated “${p.name}”.`);
        await this.render();
      } catch (err) { this.onError(err); }
    }

    async trash(p) {
      if (p.path === this.currentPath()) { this.onToast('That project is open. Open another one before moving it to the Trash.'); return; }
      if (!window.confirm(`Move “${p.name}” to the Trash?\n\nThe video itself is not touched.`)) return;
      try {
        await cutline.trashProject(p.path);
        this.onToast(`Moved “${p.name}” to the Trash.`);
        await this.render();
      } catch (err) { this.onError(err); }
    }
  }

  root.CutlineHome = Home;
})(window);
