// Scenes in the script: the rail of scene thumbnails to the left of the script, scene headings
// (rename, remove), starting a scene with "/" or the selection bar, and reordering by dragging.
// Split out of app.js; app.js passes in what it shares (see the create() call there).
(function (root) {
  function create({ $, els, state, E, S, timeline, duration, commit, seek, visibleFrom, fmt, toast }) {
    const rail = $('scene-rail');
    let drawnKey = null;

    function startScene(i) {
      const at = visibleFrom(i);
      if (at < 0) return;
      const scenes = S.add(state.words, state.scenes, at);
      if (scenes === state.scenes) { toast('A scene already starts here.'); return; }
      commit({ scenes });
      toast('New scene. Double-click its heading to name it; drag scenes in the rail on the left to reorder them.', { ms: 6000 });
    }

    function thumbAt(t) {
      const frames = timeline.frames ?? [];
      if (!frames.length) return null;
      return frames[timeline.nearestFrame(t)]?.src ?? null;
    }

    // Redrawn when the scenes, the words or the cuts change, or the thumbnails arrive.
    function render() {
      const list = S.ranges(state.words, state.scenes);
      const key = JSON.stringify([list.map((s) => [s.id, s.title, s.from, s.to]), state.textVersion, (timeline.frames ?? []).length]);
      rail.hidden = !list.length;
      document.body.classList.toggle('has-scenes', list.length > 0);
      if (key === drawnKey) { paintTimes(list); return; }
      drawnKey = key;
      rail.replaceChildren();
      list.forEach((s, k) => {
        const item = document.createElement('div');
        item.className = 'scene-item';
        item.draggable = true;
        item.dataset.k = k;
        const src = thumbAt(state.words[s.from].start);
        const img = document.createElement(src ? 'img' : 'div');
        img.className = 'scene-thumb';
        if (src) img.src = src;
        const title = document.createElement('div');
        title.className = 'scene-name';
        title.textContent = s.id == null ? 'Opening' : s.title || 'Untitled scene';
        const time = document.createElement('div');
        time.className = 'scene-time';
        item.append(img, title, time);
        item.addEventListener('click', () => {
          const at = visibleFrom(s.from);
          if (at < 0) return;
          seek(state.words[at].start);
          const head = els.transcript.querySelector(`.scene-head[data-scene="${s.id}"]`) ?? els.transcript.querySelector(`.w[data-i="${at}"]`);
          head?.scrollIntoView({ block: 'start', behavior: 'smooth' });
        });
        item.addEventListener('dragstart', (e) => { e.dataTransfer.setData('text/x-scene', String(k)); e.dataTransfer.effectAllowed = 'move'; });
        item.addEventListener('dragover', (e) => {
          if (!e.dataTransfer.types.includes('text/x-scene')) return;
          e.preventDefault();
          const r = item.getBoundingClientRect();
          item.classList.toggle('drop-above', e.clientY < r.top + r.height / 2);
          item.classList.toggle('drop-below', e.clientY >= r.top + r.height / 2);
        });
        item.addEventListener('dragleave', () => item.classList.remove('drop-above', 'drop-below'));
        item.addEventListener('drop', (e) => {
          e.preventDefault();
          const below = item.classList.contains('drop-below');
          item.classList.remove('drop-above', 'drop-below');
          moveScene(Number(e.dataTransfer.getData('text/x-scene')), below ? k + 1 : k);
        });
        rail.appendChild(item);
      });
      paintTimes(list);
    }

    function paintTimes(list) {
      rail.querySelectorAll('.scene-time').forEach((el, k) => {
        const s = list[k];
        if (!s) return;
        const at = visibleFrom(s.from);
        el.textContent = at >= 0 && at <= s.to ? fmt(E.toEdited(state.kept, state.words[at].start)) : 'cut';
      });
    }

    // Move scene k so it comes before scene j (j = the number of scenes: to the end).
    function moveScene(k, j) {
      const r = S.move(state.words, state.deleted, state.cutGaps, state.order, duration(), state.scenes, k, j);
      if (!r) return;
      commit({ words: r.words, deleted: r.deleted, cutGaps: r.cutGaps, order: E.isIdentity(r.order, duration()) ? null : r.order, scenes: r.scenes });
      toast('Scene moved. Press ⌘Z to undo.');
    }

    // Headings in the script: double-click the title to rename, × removes the break.
    els.transcript.addEventListener('mousedown', (e) => {
      const head = e.target.closest('.scene-head');
      if (!head) return;
      e.stopPropagation();
      if (e.target.closest('.scene-remove')) {
        e.preventDefault();
        commit({ scenes: S.remove(state.scenes, Number(head.dataset.scene)) });
      }
    }, true);
    els.transcript.addEventListener('dblclick', (e) => {
      const title = e.target.closest('.scene-title');
      if (!title) return;
      e.stopPropagation();
      const id = Number(title.parentElement.dataset.scene);
      title.contentEditable = 'plaintext-only';
      title.focus();
      document.getSelection().selectAllChildren(title);
      let done = false;
      const finish = (keep) => {
        if (done) return;
        done = true;
        title.contentEditable = 'false';
        const text = title.textContent.trim();
        if (keep && text) commit({ scenes: S.rename(state.scenes, id, text) });
        else { state.textVersion++; render(); }
      };
      title.addEventListener('keydown', (ev) => {
        ev.stopPropagation();
        if (ev.key === 'Enter') { ev.preventDefault(); finish(true); }
        if (ev.key === 'Escape') { ev.preventDefault(); finish(false); }
      });
      title.addEventListener('blur', () => finish(true), { once: true });
    }, true);

    return { render, startScene, moveScene };
  }

  root.CutlineSceneRail = { create };
})(window);
