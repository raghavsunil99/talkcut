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
          if (s.sidebar && !active) openRailPanel(CutlinePanels.Panels.lastPanel());
        }
        lastSidebarPref = s.sidebar;
        $('btn-toggle-transcript').classList.toggle('on', s.transcript);
        $('btn-toggle-timeline').classList.toggle('on', s.timeline);
        $('btn-toggle-sidebar').classList.toggle('on', Boolean(document.querySelector('.rail-btn.on')));
        requestAnimationFrame(() => window.dispatchEvent(new Event('resize')));
      },
      onTimelineHeight: (h) => setTimelineHeight(h),
    });
    $('btn-settings')?.addEventListener('click', () => appearance.open());
    $('btn-toggle-transcript').addEventListener('click', () => appearance.toggle('transcript'));
    $('btn-toggle-timeline').addEventListener('click', () => appearance.toggle('timeline'));
    $('btn-toggle-sidebar').addEventListener('click', () => {
      const active = document.querySelector('.rail-btn.on');
      if (active) active.click(); else openRailPanel(CutlinePanels.Panels.lastPanel());
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
    const defaultHeight = appearance.s.timelineH ?? 240;
    if (CutlineAppearance.migrated) setTimelineHeight(defaultHeight);
    else try { setTimelineHeight(Number(localStorage.getItem('cutline.timelineHeight')) || defaultHeight, false); } catch { setTimelineHeight(defaultHeight, false); }
    // Collapsed, the timeline is just its bar (time, transport, zoom). Click the handle on its
    // top edge, or press ⌥⌘T, to open or close it; drag the handle to resize.
    function setCollapsed(on) {
      document.body.classList.toggle('tl-collapsed', on);
      $('tl-resize').title = on ? 'Click or drag up to open the timeline (⌥⌘T)' : 'Drag to resize the timeline; click to collapse it (⌥⌘T)';
      try { localStorage.setItem('cutline.timelineCollapsed', on ? '1' : ''); } catch {}
      window.dispatchEvent(new Event('resize'));
    }
    try { setCollapsed(localStorage.getItem('cutline.timelineCollapsed') === '1'); } catch {}
    $('tl-resize').addEventListener('mousedown', (e) => {
      e.preventDefault();
      const y0 = e.clientY;
      const collapsed = document.body.classList.contains('tl-collapsed');
      const h0 = collapsed ? TL_MIN : $('timeline').getBoundingClientRect().height;
      let moved = false;
      $('tl-resize').classList.add('dragging');
      const move = (ev) => {
        if (!moved && Math.abs(ev.clientY - y0) < 4) return;
        moved = true;
        if (document.body.classList.contains('tl-collapsed')) setCollapsed(false);
        setTimelineHeight(h0 + (y0 - ev.clientY));
      };
      const up = () => {
        $('tl-resize').classList.remove('dragging');
        if (!moved) setCollapsed(!collapsed);
        window.removeEventListener('mousemove', move);
        window.removeEventListener('mouseup', up);
      };
      window.addEventListener('mousemove', move);
      window.addEventListener('mouseup', up);
    });
    // ⌥⌘T opens or collapses the timeline.
    window.addEventListener('keydown', (e) => {
      if (e.code === 'KeyT' && e.altKey && (e.metaKey || e.ctrlKey)) {
        e.preventDefault();
        setCollapsed(!document.body.classList.contains('tl-collapsed'));
      }
    });
    new ResizeObserver(() => { resetCaptionCache(); updatePlayhead(); }).observe(els.player);

    return { appearance, setCollapsed };
  }

  root.CutlineWorkspace = { create };
})(window);
