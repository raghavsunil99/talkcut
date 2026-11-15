// The preview player. A project is usually one recording in one <video>; when a second
// recording has been added to the end, each file gets its own <video> and this object makes
// them look like one: `currentTime` runs through the first file and on into the next
// (source seconds, the same axis words and cuts use), and playback carries on across the join.
// It has the parts of the media element interface the editor uses, so the rest of the code
// treats it as the video element.
(function (root) {
  function create(first) {
    // One entry per file: { el, offset, duration }. Entry 0 is always the element in the page.
    let sources = [{ el: first, offset: 0, duration: 0 }];
    let active = 0;
    let switching = false; // true while playback moves between files: their events are not the user's
    let rate = 1;
    let volume = 1;
    let muted = false;
    const listeners = []; // [type, fn]
    const cur = () => sources[active];
    const multi = () => sources.length > 1;

    function forward(type, fn, index) {
      return (event) => {
        if (index() !== active || switching) return;
        // A file that reaches its end pauses itself; when another follows, playback is not over.
        if ((type === 'pause' || type === 'ended') && multi() && active < sources.length - 1 && cur().el.ended) return;
        fn(event);
      };
    }

    function attach(source) {
      const index = () => sources.indexOf(source);
      source.handlers = listeners.map(([type, fn]) => {
        const h = forward(type, fn, index);
        source.el.addEventListener(type, h);
        return [type, h];
      });
      // Carry on into the next file.
      source.onEnded = () => {
        const i = index();
        if (i !== active || i >= sources.length - 1) return;
        switchTo(i + 1, 0, true);
      };
      source.el.addEventListener('ended', source.onEnded);
    }

    function detach(source) {
      for (const [type, h] of source.handlers ?? []) source.el.removeEventListener(type, h);
      source.el.removeEventListener('ended', source.onEnded);
    }

    function show() {
      sources.forEach((s, i) => { if (i > 0 || multi()) s.el.style.visibility = i === active ? '' : 'hidden'; });
    }

    function switchTo(index, local, play) {
      switching = true;
      const from = cur();
      const wasPlaying = play ?? !from.el.paused;
      from.el.pause();
      active = index;
      const to = cur();
      to.el.playbackRate = rate;
      to.el.currentTime = Math.max(0, local);
      show();
      if (wasPlaying) to.el.play().catch(() => {});
      // Events from the hand-over have fired by the next task.
      setTimeout(() => { switching = false; }, 0);
    }

    const player = {
      // The files behind the player: [{ url, duration }] in play order of the recording. One
      // entry (or setting `src`) is a plain single video.
      setSources(list) {
        for (const s of sources.slice(1)) { detach(s); s.el.pause(); s.el.remove(); }
        detach(sources[0]);
        active = 0;
        let offset = 0;
        sources = list.map((item, i) => {
          let el = first;
          if (i > 0) {
            el = document.createElement('video');
            el.preload = 'auto';
            el.playsInline = true;
            el.className = 'joined-video';
            el.style.cssText = first.style.cssText;
            first.after(el);
          }
          if (el.getAttribute('src') !== item.url) el.src = item.url;
          el.playbackRate = rate;
          el.volume = volume;
          el.muted = muted;
          const source = { el, offset, duration: item.duration || 0 };
          offset += source.duration;
          return source;
        });
        sources.forEach(attach);
        first.style.visibility = '';
        show();
      },
      get sourceCount() { return sources.length; },
      // The element and the time inside it for what is on screen now (for the blurred background).
      get activeUrl() { return cur().el.getAttribute('src'); },
      get localTime() { return cur().el.currentTime; },
      get element() { return first; },

      get src() { return first.getAttribute('src'); },
      set src(url) { player.setSources([{ url, duration: 0 }]); },
      removeAttribute(name) { if (name === 'src') { player.setSources([{ url: '', duration: 0 }]); first.removeAttribute('src'); } else first.removeAttribute(name); },
      load() { first.load(); },

      get currentTime() {
        const s = cur();
        return s.offset + (multi() ? Math.min(s.el.currentTime, s.duration) : s.el.currentTime);
      },
      set currentTime(t) {
        if (!multi()) { first.currentTime = t; return; }
        let index = sources.length - 1;
        for (let i = 0; i < sources.length; i++) if (t < sources[i].offset + sources[i].duration) { index = i; break; }
        const local = Math.min(Math.max(0, t - sources[index].offset), sources[index].duration);
        if (index === active) cur().el.currentTime = local;
        else switchTo(index, local);
      },
      get duration() { return multi() ? sources.reduce((sum, s) => sum + s.duration, 0) : first.duration; },
      get paused() { return cur().el.paused; },
      get ended() { return active === sources.length - 1 && cur().el.ended; },
      get seeking() { return cur().el.seeking; },
      play() { return cur().el.play(); },
      pause() { cur().el.pause(); },

      get playbackRate() { return rate; },
      set playbackRate(v) { rate = v; for (const s of sources) s.el.playbackRate = v; },
      get volume() { return volume; },
      set volume(v) { volume = v; for (const s of sources) s.el.volume = v; },
      get muted() { return muted; },
      set muted(v) { muted = v; for (const s of sources) s.el.muted = v; },

      // The size of the first recording: the frame is laid out for it, and added recordings
      // are fitted into the same box.
      get videoWidth() { return first.videoWidth; },
      get videoHeight() { return first.videoHeight; },
      get hidden() { return first.hidden; },
      set hidden(v) { for (const s of sources) s.el.hidden = v; },
      // Layout styles apply to every file's element.
      style: new Proxy({}, {
        get: (_t, prop) => first.style[prop],
        set: (_t, prop, value) => { for (const s of sources) s.el.style[prop] = value; return true; },
      }),

      addEventListener(type, fn) {
        listeners.push([type, fn]);
        sources.forEach((s) => { detach(s); });
        sources.forEach(attach);
      },
    };
    attach(sources[0]);
    return player;
  }

  root.CutlinePlayer = { create };
})(window);
