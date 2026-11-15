// The workspace: the timeline's add-track menu, themes and layouts, and the resizable timeline.
// Split out of app.js; app.js passes in what it shares (see the create() call there).
(function (root) {
  function create({ $, els, state, T, timeline, hasProject, commit, toast, updatePlayhead, resetCaptionCache, openRailPanel }) {
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

    return { appearance };
  }

  root.CutlineWorkspace = { create };
})(window);
