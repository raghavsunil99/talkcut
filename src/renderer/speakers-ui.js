// Speaker labels in the transcript: the who-said-this menu, assigning, renaming and clearing.
// Split out of app.js; app.js passes in what it shares (see the create() call there).
(function (root) {
  function create({ $, els, state, selectionRange, commit, renderTranscript, refresh }) {
    // ---------- speakers ----------

    const SP = CutlineSpeakers;
    const speakerMenu = $('speaker-menu');

    // Words a speaker action applies to: the selection, or the paragraph a label heads.
    function showSpeakerMenu(x, y, range, currentId) {
      const items = [];
      const head = (text) => { const li = document.createElement('li'); li.className = 'menu-head'; li.textContent = text; return li; };
      const item = (text, fn, on = false) => {
        const li = document.createElement('li');
        li.textContent = text;
        li.classList.toggle('on', on);
        li.addEventListener('click', () => { speakerMenu.hidden = true; fn(); });
        return li;
      };
      if (range) {
        items.push(head(`${range[1] - range[0] + 1} word${range[1] === range[0] ? '' : 's'} said by`));
        for (const [id, name] of Object.entries(state.speakers)) items.push(item(name, () => assignSpeaker(range, id), id === currentId));
        items.push(item('+ New speaker…', () => {
          const id = SP.newId(state.speakers);
          assignSpeaker(range, id, { ...state.speakers, [id]: `Speaker ${Object.keys(state.speakers).length + 1}` });
          requestAnimationFrame(() => renameSpeaker(id));
        }));
      } else {
        items.push(head('Select words in the transcript first, then choose who said them.'));
      }
      if (currentId != null && state.speakers[currentId]) items.push(item(`Rename “${state.speakers[currentId]}”…`, () => renameSpeaker(currentId)));
      if (Object.keys(state.speakers).length) items.push(item('Remove all speaker labels', clearSpeakers));
      speakerMenu.replaceChildren(...items);
      speakerMenu.hidden = false;
      const w = 220;
      speakerMenu.style.left = `${Math.min(window.innerWidth - w - 8, x)}px`;
      speakerMenu.style.top = `${Math.min(window.innerHeight - speakerMenu.offsetHeight - 8, y)}px`;
    }

    // `names` lets a new speaker be added in the same undo step as the words they are given.
    function assignSpeaker([from, to], id, names = state.speakers) {
      const words = SP.assign(state.words, from, to, id);
      commit({ words, speakers: SP.prune(words, names) });
      renderTranscript();
      refresh();
    }

    function clearSpeakers() {
      commit({ words: state.words.map(({ speaker, ...rest }) => rest), speakers: {} });
      renderTranscript();
      refresh();
    }

    // Rename in place: the label turns into a text field.
    function renameSpeaker(id) {
      const el = els.transcript.querySelector(`.speaker-label[data-speaker="${CSS.escape(id)}"]`);
      if (!el) return;
      const input = document.createElement('input');
      input.className = 'text-input';
      input.value = state.speakers[id];
      input.maxLength = 40;
      el.replaceChildren(input);
      input.focus();
      input.select();
      let done = false;
      const finish = (keep) => {
        if (done) return;
        done = true;
        const name = input.value.trim();
        if (keep && name && name !== state.speakers[id]) commit({ speakers: { ...state.speakers, [id]: name } });
        renderTranscript();
        refresh();
      };
      input.addEventListener('keydown', (e) => {
        e.stopPropagation();
        if (e.key === 'Enter') finish(true);
        if (e.key === 'Escape') finish(false);
      });
      input.addEventListener('blur', () => finish(true));
      input.addEventListener('mousedown', (e) => e.stopPropagation());
    }

    // The paragraph a label heads: from its first word to the word before the next label.
    function labelRange(labelEl) {
      const first = labelEl.parentElement.querySelector('.w, .del');
      if (!first) return null;
      const from = Number(first.dataset.i ?? first.dataset.from);
      let to = from;
      for (let p = labelEl.parentElement; p; p = p.nextElementSibling) {
        if (p !== labelEl.parentElement && p.querySelector('.speaker-label')) break;
        for (const el of p.querySelectorAll('.w, .del')) to = Math.max(to, Number(el.dataset.i ?? el.dataset.to));
      }
      return [from, to];
    }

    $('btn-speakers').addEventListener('click', (e) => {
      const r = e.currentTarget.getBoundingClientRect();
      const sel = selectionRange();
      showSpeakerMenu(r.left, r.bottom + 4, sel, sel ? state.words[sel[0]].speaker : null);
    });
    window.addEventListener('mousedown', (e) => {
      if (!e.target.closest('#speaker-menu') && !e.target.closest('#btn-speakers') && !e.target.closest('.speaker-label')) speakerMenu.hidden = true;
    });

    return { showSpeakerMenu, labelRange };
  }

  root.CutlineSpeakersUI = { create };
})(window);
