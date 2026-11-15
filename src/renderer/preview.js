// The preview: frame layout, blurred background, Studio Sound and track audio in step with the video, overlays, captions and the playhead.
// Split out of app.js; app.js passes in what it shares (see the create() call there).
(function (root) {
  function create({ $, els, state, E, C, F, T, timeline, mod, hasProject, getSpans, getCanvasEditor, toast, showError, fmtTenths }) {
    function frameLayout() {
      const srcW = els.video.videoWidth || state.media?.width || 16;
      const srcH = els.video.videoHeight || state.media?.height || 9;
      // While cropping, show the whole picture (turned and flipped) so the box can grow too.
      if (state.cropping) return F.layout(srcW, srcH, { ...state.clip, crop: null, scale: 1, x: 0, y: 0, canvas: 'original', bgMode: 'color' });
      return F.layout(srcW, srcH, state.clip);
    }

    function contentRect() {
      const box = els.player.getBoundingClientRect();
      const { frame } = frameLayout();
      const k = Math.min(box.width / frame.w, box.height / frame.h);
      const w = frame.w * k;
      const h = frame.h * k;
      return { left: (box.width - w) / 2, top: (box.height - h) / 2, width: w, height: h };
    }

    // Lay the preview out exactly as the export will: the frame (with its background), and the
    // cropped, rotated, scaled picture placed inside it.
    function applyPreviewLayout() {
      const stage = $('stage');
      const L = frameLayout();
      const r = contentRect();
      const k = r.width / L.frame.w;
      place(stage, r);
      stage.style.background = L.props.background;
      const pic = $('pic');
      pic.style.left = `${L.draw.x * k}px`;
      pic.style.top = `${L.draw.y * k}px`;
      pic.style.width = `${L.draw.w * k}px`;
      pic.style.height = `${L.draw.h * k}px`;
      const turned = L.rotate % 180 === 90;
      const k2 = (L.draw.w * k) / (turned ? L.crop.h : L.crop.w);
      const inner = $('pic-inner');
      inner.style.width = `${L.crop.w * k2}px`;
      inner.style.height = `${L.crop.h * k2}px`;
      inner.style.transform = `translate(-50%, -50%) scale(${L.props.flipH ? -1 : 1}, ${L.props.flipV ? -1 : 1}) rotate(${L.rotate}deg)`;
      syncBackgroundVideo(L);
      if (state.cropping) mod.canvas?.syncCropArea(r);
      const srcW = els.video.videoWidth || state.media?.width || 16;
      const srcH = els.video.videoHeight || state.media?.height || 9;
      els.video.style.width = `${srcW * k2}px`;
      els.video.style.height = `${srcH * k2}px`;
      els.video.style.left = `${-L.crop.x * k2}px`;
      els.video.style.top = `${-L.crop.y * k2}px`;
      return r;
    }

    // Blurred background: a muted copy of the video, zoomed to cover the frame and blurred.
    let bgVideo = null;
    function syncBackgroundVideo(L = frameLayout()) {
      const want = L.props.bgMode === 'blur' && state.media?.hasVideo;
      if (!want) { if (bgVideo) { bgVideo.pause(); bgVideo.hidden = true; } return; }
      if (!bgVideo) {
        bgVideo = document.createElement('video');
        bgVideo.className = 'bg-video';
        bgVideo.muted = true;
        bgVideo.playsInline = true;
        bgVideo.preload = 'auto';
        $('stage').prepend(bgVideo);
      }
      bgVideo.hidden = false;
      const url = els.video.activeUrl ?? state.media.url;
      if (bgVideo.getAttribute('src') !== url) bgVideo.src = url;
      bgVideo.style.transform = `scale(${L.props.flipH ? -1 : 1}, ${L.props.flipV ? -1 : 1}) rotate(${L.rotate}deg)`;
      if (Math.abs(bgVideo.currentTime - els.video.localTime) > 0.25) bgVideo.currentTime = els.video.localTime;
      bgVideo.playbackRate = els.video.playbackRate;
      if (els.video.paused) bgVideo.pause();
      else if (bgVideo.paused) bgVideo.play().catch(() => {});
    }

    // Studio Sound preview: a cleaned copy of the voice plays in step with the (muted) video.
    const enhancedEl = new Audio();
    enhancedEl.preload = 'auto';
    const enhancedUrls = new Map(); // media path and strength -> url, or a pending promise
    const enhancedKey = () => `${state.media?.path}|${state.clip.enhanceStrength}`;
    function enhancedReady() {
      const url = state.media && enhancedUrls.get(enhancedKey());
      // With a second recording added, the cleaned preview (made from the first file only) is
      // off; the export still cleans the whole edit.
      return state.clip.enhance && typeof url === 'string' && !state.media.sources ? url : null;
    }
    // Made once per file and strength. While the strength slider moves, wait until it rests.
    let prepareTimer = null;
    function prepareEnhanced() {
      clearTimeout(prepareTimer);
      prepareTimer = setTimeout(prepareNow, 500);
    }
    function prepareNow() {
      const media = state.media;
      const key = enhancedKey();
      if (!media || !state.clip.enhance || enhancedUrls.has(key)) return;
      toast('Preparing Studio Sound preview…', { ms: 2500 });
      const pending = cutline.enhancedAudio(media.path, state.clip.enhanceStrength).then((url) => {
        enhancedUrls.set(key, url);
        if (enhancedKey() === key) { applyAudio(); toast('Studio Sound is on. The export uses it too.'); }
      }).catch((err) => { enhancedUrls.delete(key); showError(err); });
      enhancedUrls.set(key, pending);
    }
    function syncEnhanced() {
      const url = enhancedReady();
      if (!url) { if (!enhancedEl.paused) enhancedEl.pause(); return; }
      if (enhancedEl.getAttribute('src') !== url) enhancedEl.src = url;
      if (Math.abs(enhancedEl.currentTime - els.video.currentTime) > 0.15) enhancedEl.currentTime = els.video.currentTime;
      enhancedEl.playbackRate = els.video.playbackRate;
      if (els.video.paused) enhancedEl.pause();
      else if (enhancedEl.paused) enhancedEl.play().catch(() => {});
    }

    // Volume up to 200%: the media element stops at 100%, so louder goes through Web Audio.
    let audioGain = null;
    function applyAudio() {
      const { volume, muted, speed } = state.clip;
      if (state.clip.enhance) prepareEnhanced();
      const enhanced = Boolean(enhancedReady());
      enhancedEl.muted = muted;
      enhancedEl.volume = Math.min(1, volume);
      els.video.muted = muted || enhanced;
      if (volume > 1 && !audioGain) {
        try {
          const ctx = new AudioContext();
          audioGain = ctx.createGain();
          ctx.createMediaElementSource(els.video.element).connect(audioGain).connect(ctx.destination);
        } catch (err) { console.error(err); }
      }
      if (audioGain) {
        els.video.volume = 1;
        audioGain.gain.value = volume;
        if (audioGain.context.state === 'suspended') audioGain.context.resume().catch(() => {});
      } else {
        els.video.volume = Math.min(1, volume);
      }
      els.video.playbackRate = speed * (Number(els.speed.value) || 1);
    }

    function place(el, r) {
      el.style.left = `${r.left}px`;
      el.style.top = `${r.top}px`;
      el.style.width = `${r.width}px`;
      el.style.height = `${r.height}px`;
    }

    // Track preview: overlays drawn in their boxes (later tracks on top) and audio-track items
    // played in step with the edit. Elements are kept per item and reused.
    const layerEls = new Map(); // item id -> element
    function syncMedia(el, item, e, volume) {
      const want = (item.offset || 0) + (e - item.startE);
      if (Math.abs(el.currentTime - want) > 0.3) el.currentTime = want;
      el.playbackRate = els.video.playbackRate;
      el.volume = Math.min(1, Math.max(0, volume));
      el.muted = volume <= 0;
      if (els.video.paused) el.pause();
      else if (el.paused) el.play().catch(() => {});
    }

    function updateTrackPreview(e, r) {
      const active = hasProject() ? T.activeAt(state.tracks, state.kept, e) : [];
      const seen = new Set();
      // While a word is being spoken, ducked music plays quieter (the export does this precisely).
      const t = els.video.currentTime;
      const wi = E.wordAt(state.words, t);
      const speaking = wi >= 0 && t <= state.words[wi].end + 0.15 && !state.deleted.has(wi);
      active.forEach(({ track, item }, z) => {
        if (track.type === 'overlay' && (track.hidden || !state.media?.hasVideo)) return;
        seen.add(item.id);
        let el = layerEls.get(item.id);
        const tag = track.type === 'audio' ? 'AUDIO' : item.kind === 'image' ? 'IMG' : item.kind === 'text' ? 'DIV' : 'VIDEO';
        if (!el || el.tagName !== tag) {
          el?.remove();
          el = document.createElement(tag.toLowerCase());
          el.className = track.type === 'audio' ? 'track-audio' : 'overlay-layer';
          el.dataset.item = item.id;
          if (tag === 'VIDEO' || tag === 'AUDIO') { el.preload = 'auto'; el.playsInline = true; }
          els.layers.appendChild(el);
          layerEls.set(item.id, el);
        }
        if (tag === 'AUDIO') {
          if (el.getAttribute('src') !== item.url) el.src = item.url;
          const gain = track.muted ? 0 : item.volume * state.clip.volume * (item.duck && speaking ? 0.3 : 1);
          syncMedia(el, item, e, state.clip.muted ? 0 : gain);
          return;
        }
        const box = item.box;
        el.style.left = `${box.x * r.width}px`;
        el.style.top = `${box.y * r.height}px`;
        el.style.width = `${box.w * r.width}px`;
        el.style.height = `${box.h * r.height}px`;
        el.style.opacity = String(T.fadeAt(item, e - item.startE));
        el.style.objectFit = item.fit === 'contain' ? 'contain' : 'cover';
        el.style.zIndex = String(10 + z);
        el.classList.toggle('selected', item.id === state.itemSel);
        if (tag === 'IMG' && el.getAttribute('src') !== item.url) el.src = item.url;
        if (tag === 'VIDEO') {
          if (el.getAttribute('src') !== item.url) el.src = item.url;
          syncMedia(el, item, e, track.muted ? 0 : item.volume ?? 0);
        }
        if (tag === 'DIV') renderTextLayer(el, item, r);
      });
      for (const [id, el] of layerEls) {
        if (!seen.has(id)) {
          if (el.pause) el.pause();
          el.remove();
          layerEls.delete(id);
        }
      }
    }

    function renderTextLayer(el, item) {
      CutlineText.renderDom(el, item, state.language);
    }

    // Caption preview, drawn with the same styles the export burns in.
    let lastCaptionKey = null;
    function updateCaptionPreview(t, r) {
      const layer = els.captionLayer;
      const on = state.captions.enabled && hasProject() && state.media.hasVideo;
      const active = on ? C.activeAt(state.captionSpans, state.words, t) : null;
      if (!active) {
        layer.hidden = true;
        lastCaptionKey = null;
        return;
      }
      const s = state.captions;
      const style = C.styleOf(s);
      // Animated styles change every frame; the edited time drives them, as in the export.
      const moving = style.animation !== 'none';
      const e = moving ? E.toEdited(state.kept, t) : 0;
      const spanStart = moving ? E.toEdited(state.kept, active.span.start) : 0;
      const spanEnd = moving ? E.toEdited(state.kept, active.span.end, true) : 0;
      const scale = C.lineScale(style, e - spanStart, spanEnd - spanStart);
      const key = `${active.span.start}:${active.current}:${JSON.stringify(s.style ?? null)}:${s.preset}:${s.size}:${s.position}:${s.x}:${s.y}:${s.scale}:${Math.round(r.width)}x${Math.round(r.height)}:${moving ? Math.round(e * 50) : ''}`;
      if (key === lastCaptionKey) return;
      lastCaptionKey = key;
      place(layer, r);
      const fontPx = C.fontPx(s, r.width, r.height);
      const custom = s.position === 'custom';
      layer.style.alignItems = s.position === 'top' ? 'flex-start' : s.position === 'middle' ? 'center' : 'flex-end';
      layer.style.paddingTop = s.position === 'top' ? `${r.height * 0.12}px` : '0';
      layer.style.paddingBottom = s.position === 'bottom' ? `${r.height * 0.16}px` : '0';
      let line = layer.firstElementChild;
      if (!line) {
        line = document.createElement('span');
        line.className = 'caption-line';
        layer.appendChild(line);
      }
      // Dragged captions sit with their centre on (x, y).
      // Pop and grow scale the line around the point libass anchors it at (\\an).
      const zoom = scale !== 1 ? ` scale(${scale.toFixed(4)})` : '';
      Object.assign(line.style, custom
        ? { position: 'absolute', left: `${s.x * r.width}px`, top: `${s.y * r.height}px`, transform: `translate(-50%, -50%)${zoom}`, width: 'max-content', transformOrigin: 'center center' }
        : { position: '', left: '', top: '', transform: zoom.trim(), width: '', transformOrigin: s.position === 'top' ? 'center top' : s.position === 'middle' ? 'center center' : 'center bottom' });
      CutlinePanels.styleLine(line, s, fontPx, state.language);
      // Karaoke: how far each word is filled, from the edited time (as the export's \\kf timing).
      const words = active.span.words;
      const fill = style.animation === 'karaoke' ? (i) => {
        const k = words.indexOf(i);
        const from = k === 0 ? spanStart : E.toEdited(state.kept, state.words[i].start);
        const until = k === words.length - 1 ? E.toEdited(state.kept, Math.max(state.words[i].end, state.words[i].start), true) : E.toEdited(state.kept, state.words[words[k + 1]].start);
        return until > from ? (e - from) / (until - from) : (e >= from ? 1 : 0);
      } : null;
      CutlinePanels.fillLine(line, words.map((i) => ({ text: state.words[i].text, i })), s, active.current, fill);
      layer.hidden = false;
    }

    function updatePlayhead() {
      syncEnhanced();
      if (bgVideo && !bgVideo.hidden) syncBackgroundVideo();
      let t = els.video.currentTime;
      // A jump lands on a frame boundary, which can be a moment before the piece being played;
      // that moment belongs to another part of the edit, so hold the playhead at the piece's start.
      const playing = state.kept[state.playK];
      if (playing && t < playing[0] && t > playing[0] - 0.1) t = playing[0];
      const e = E.toEdited(state.kept, t);
      els.timeCurrent.textContent = fmtTenths(e);
      if (hasProject()) timeline.setTime(t, !els.video.paused);
      if (state.media?.hasVideo) {
        // B-roll and captions live inside the frame, so they cover it from its own corner.
        const frame = applyPreviewLayout();
        const r = { left: 0, top: 0, width: frame.width, height: frame.height };
        updateTrackPreview(e, r);
        getCanvasEditor()?.update();
        updateCaptionPreview(t, r);
      }

      const i = E.wordAt(state.words, t);
      const now = i >= 0 && t <= state.words[i].end + 0.25 ? i : -1;
      if (now !== state.nowIndex) {
        getSpans()[state.nowIndex]?.classList.remove('now');
        state.nowIndex = now;
        const span = getSpans()[now];
        if (span) {
          span.classList.add('now');
          if (!els.video.paused) keepVisible(span);
        }
      }
    }

    function keepVisible(span) {
      if (!span) return;
      const box = els.transcriptWrap.getBoundingClientRect();
      const r = span.getBoundingClientRect();
      if (r.top < box.top + 40 || r.bottom > box.bottom - 60) {
        span.scrollIntoView({ block: 'center', behavior: 'smooth' });
      }
    }

    window.addEventListener('resize', () => {
      lastCaptionKey = null;
      updatePlayhead();
    });

    function resetCaptionCache() { lastCaptionKey = null; }

    return { frameLayout, contentRect, applyPreviewLayout, applyAudio, updatePlayhead, keepVisible, layerEls, resetCaptionCache };
  }

  root.CutlinePreview = { create };
})(window);
