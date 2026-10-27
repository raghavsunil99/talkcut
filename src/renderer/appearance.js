// Look and layout: theme, accent colour, density, transcript text, panel sizes, which panels
// show, preview guides, and workspaces (saved arrangements). Stored per Mac in localStorage.
(function (root) {
  const $ = (id) => document.getElementById(id);
  const KEY = 'cutline.appearance';

  const ACCENTS = {
    violet: '#7c8cff', blue: '#4c9bff', green: '#3ecf8e', orange: '#ff9f43', pink: '#ff6fb1', yellow: '#ffd84d',
  };
  const FONTS = {
    system: { label: 'System', css: '-apple-system, "SF Pro Text", "Kohinoor Telugu", sans-serif' },
    kohinoor: { label: 'Kohinoor Telugu', css: '"Kohinoor Telugu", -apple-system, sans-serif' },
    sangam: { label: 'Telugu Sangam MN', css: '"Telugu Sangam MN", -apple-system, sans-serif' },
    telugumn: { label: 'Telugu MN', css: '"Telugu MN", -apple-system, sans-serif' },
  };

  // Workspaces set panel sizes and visibility; your own changes are kept on top until you
  // pick a workspace again.
  const WORKSPACES = {
    studio: { label: 'Studio', key: '1', layout: { transcript: true, sidebar: true, timeline: true, transcriptW: 0.38, sidebarW: 300, timelineH: 300, guides: false } },
    video: { label: 'Video first', key: '2', layout: { transcript: true, sidebar: true, timeline: true, transcriptW: 0.26, sidebarW: 320, timelineH: 380, guides: false } },
    script: { label: 'Script first', key: '3', layout: { transcript: true, sidebar: false, timeline: true, transcriptW: 0.62, sidebarW: 300, timelineH: 170, guides: false } },
    reels: { label: 'Reels', key: '4', layout: { transcript: true, sidebar: true, timeline: true, transcriptW: 0.36, sidebarW: 320, timelineH: 220, guides: true } },
  };

  const DEFAULTS = {
    theme: 'dark', accent: 'violet', density: 'comfortable', textSize: 18, font: 'system', thumbs: 'medium',
    workspace: 'studio', ...WORKSPACES.studio.layout, grid: false,
  };

  function load() {
    try { return { ...DEFAULTS, ...JSON.parse(localStorage.getItem(KEY) || '{}') }; } catch { return { ...DEFAULTS }; }
  }

  // Readable text on an accent fill.
  function onColor(hex) {
    const n = parseInt(hex.slice(1), 16);
    const l = (0.299 * (n >> 16) + 0.587 * ((n >> 8) & 255) + 0.114 * (n & 255)) / 255;
    return l > 0.6 ? '#141418' : '#0d1020';
  }

  class Appearance {
    // onLayout(settings) is called after anything that changes the size of the panels.
    constructor({ onLayout, onTimelineHeight }) {
      this.onLayout = onLayout;
      this.onTimelineHeight = onTimelineHeight;
      this.s = load();
      this.media = window.matchMedia('(prefers-color-scheme: light)');
      this.media.addEventListener('change', () => this.apply());
      this.buildSplitters();
      this.buildDialog();
      this.apply();
    }

    save() {
      try { localStorage.setItem(KEY, JSON.stringify(this.s)); } catch {}
    }

    set(change) {
      this.s = { ...this.s, ...change };
      this.save();
      this.apply();
    }

    apply() {
      const s = this.s;
      const html = document.documentElement;
      const theme = s.theme === 'system' ? (this.media.matches ? 'light' : 'dark') : s.theme;
      html.dataset.theme = theme;
      html.dataset.density = s.density;
      html.dataset.thumbs = s.thumbs;
      const accent = ACCENTS[s.accent] ?? ACCENTS.violet;
      html.style.setProperty('--accent', accent);
      html.style.setProperty('--accent-soft', `${accent}3d`);
      html.style.setProperty('--on-accent', onColor(accent));
      html.style.setProperty('--transcript-size', `${s.textSize}px`);
      html.style.setProperty('--transcript-font', FONTS[s.font]?.css ?? FONTS.system.css);
      html.style.setProperty('--transcript-w', `${Math.round(s.transcriptW * 1000) / 10}%`);
      html.style.setProperty('--sidebar-w', `${s.sidebarW}px`);
      document.body.classList.toggle('hide-transcript', !s.transcript);
      document.body.classList.toggle('hide-sidebar-pref', !s.sidebar);
      document.body.classList.toggle('hide-timeline', !s.timeline);
      document.body.classList.toggle('show-guides', Boolean(s.guides));
      document.body.classList.toggle('show-grid', Boolean(s.grid));
      this.render();
      this.onLayout?.(s);
    }

    useWorkspace(name) {
      const w = WORKSPACES[name];
      if (!w) return;
      this.set({ workspace: name, ...w.layout });
      this.onTimelineHeight?.(w.layout.timelineH);
    }

    toggle(panel) {
      this.set({ [panel]: !this.s[panel] });
    }

    // ---------- dragging panel edges ----------

    buildSplitters() {
      const drag = (handle, onMove) => {
        handle.addEventListener('mousedown', (e) => {
          e.preventDefault();
          handle.classList.add('dragging');
          document.body.classList.add('resizing');
          const move = (ev) => onMove(ev);
          const up = () => {
            handle.classList.remove('dragging');
            document.body.classList.remove('resizing');
            window.removeEventListener('mousemove', move);
            window.removeEventListener('mouseup', up);
            this.save();
          };
          window.addEventListener('mousemove', move);
          window.addEventListener('mouseup', up);
        });
        handle.addEventListener('dblclick', () => this.useWorkspace(this.s.workspace));
      };
      drag($('split-transcript'), (ev) => {
        const ws = document.querySelector('.workspace').getBoundingClientRect();
        this.s.transcriptW = Math.min(0.75, Math.max(0.18, (ev.clientX - ws.left) / ws.width));
        this.apply();
      });
      drag($('split-sidebar'), (ev) => {
        const rail = document.querySelector('.rail').getBoundingClientRect();
        this.s.sidebarW = Math.round(Math.min(520, Math.max(240, rail.left - ev.clientX)));
        this.apply();
      });
    }

    // ---------- settings dialog ----------

    buildDialog() {
      const seg = (id, options, key, after) => {
        const el = $(id);
        for (const [value, label] of options) {
          const b = document.createElement('button');
          b.type = 'button';
          b.dataset.value = value;
          b.textContent = label;
          b.addEventListener('click', () => { this.set({ [key]: value }); after?.(value); });
          el.appendChild(b);
        }
      };
      seg('set-theme', [['dark', 'Dark'], ['midnight', 'Midnight'], ['light', 'Light'], ['system', 'Match Mac']], 'theme');
      seg('set-density', [['comfortable', 'Comfortable'], ['compact', 'Compact']], 'density');
      seg('set-thumbs', [['small', 'Small'], ['medium', 'Medium'], ['large', 'Large']], 'thumbs', () => window.dispatchEvent(new Event('resize')));
      const accents = $('set-accent');
      for (const [name, hex] of Object.entries(ACCENTS)) {
        const b = document.createElement('button');
        b.type = 'button';
        b.className = 'swatch';
        b.dataset.value = name;
        b.title = name[0].toUpperCase() + name.slice(1);
        b.style.background = hex;
        b.addEventListener('click', () => this.set({ accent: name }));
        accents.appendChild(b);
      }
      const font = $('set-font');
      for (const [k, f] of Object.entries(FONTS)) font.add(new Option(f.label, k));
      font.addEventListener('change', () => this.set({ font: font.value }));
      $('set-size').addEventListener('input', () => this.set({ textSize: Number($('set-size').value) }));
      const ws = $('set-workspace');
      for (const [name, w] of Object.entries(WORKSPACES)) {
        const b = document.createElement('button');
        b.type = 'button';
        b.dataset.value = name;
        b.innerHTML = '';
        const t = document.createElement('b');
        t.textContent = w.label;
        const k = document.createElement('span');
        k.textContent = `⌘${w.key}`;
        b.append(t, k);
        b.addEventListener('click', () => this.useWorkspace(name));
        ws.appendChild(b);
      }
      for (const [id, key] of [['set-show-transcript', 'transcript'], ['set-show-sidebar', 'sidebar'], ['set-show-timeline', 'timeline'], ['set-guides', 'guides'], ['set-grid', 'grid']]) {
        $(id).addEventListener('change', () => this.set({ [key]: $(id).checked }));
      }
      $('set-ask-engine').addEventListener('change', () => {
        try { localStorage.setItem('cutline.askEngine', $('set-ask-engine').checked ? 'yes' : 'no'); } catch {}
      });
      $('set-reset').addEventListener('click', () => {
        this.s = { ...DEFAULTS };
        this.save();
        this.apply();
        this.onTimelineHeight?.(DEFAULTS.timelineH);
      });
      const close = () => { $('settings-dialog').hidden = true; };
      $('settings-close').addEventListener('click', close);
      $('settings-done').addEventListener('click', close);
      $('settings-dialog').addEventListener('keydown', (e) => { e.stopPropagation(); if (e.key === 'Escape') close(); });
      $('settings-dialog').addEventListener('mousedown', (e) => { if (e.target.id === 'settings-dialog') close(); });
    }

    open() {
      let ask = true;
      try { ask = localStorage.getItem('cutline.askEngine') !== 'no'; } catch {}
      $('set-ask-engine').checked = ask;
      this.render();
      $('settings-dialog').hidden = false;
    }

    render() {
      const s = this.s;
      const mark = (id, value) => $(id)?.querySelectorAll('button').forEach((b) => b.classList.toggle('on', b.dataset.value === value));
      mark('set-theme', s.theme);
      mark('set-density', s.density);
      mark('set-thumbs', s.thumbs);
      mark('set-accent', s.accent);
      mark('set-workspace', s.workspace);
      $('set-font').value = s.font;
      $('set-size').value = s.textSize;
      $('set-size-out').textContent = `${s.textSize}px`;
      $('set-show-transcript').checked = s.transcript;
      $('set-show-sidebar').checked = s.sidebar;
      $('set-show-timeline').checked = s.timeline;
      $('set-guides').checked = s.guides;
      $('set-grid').checked = s.grid;
    }
  }

  root.CutlineAppearance = { Appearance, WORKSPACES, ACCENTS };
})(window);
