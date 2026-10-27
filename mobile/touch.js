// Finger dragging on Android: the editor's video, crop and timeline handles listen for mouse
// events, so one-finger touches on them are passed on as mouse events. Everywhere else touches
// scroll as usual.
(function () {
  const DRAGGABLE = '.canvas-ui, .crop-ui, .tl-item, .tl-scrub, .tl-cap';
  let active = null;
  const fire = (target, type, t) => target.dispatchEvent(new MouseEvent(type, {
    bubbles: true, cancelable: true, view: window, clientX: t.clientX, clientY: t.clientY, button: 0, buttons: type === 'mouseup' ? 0 : 1,
  }));
  document.addEventListener('touchstart', (e) => {
    if (e.touches.length !== 1) return;
    const target = e.target.closest?.(DRAGGABLE) ? e.target : null;
    if (!target || e.target.closest('button, input, select, textarea')) return;
    e.preventDefault();
    active = target;
    fire(target, 'mousedown', e.touches[0]);
  }, { passive: false, capture: true });
  document.addEventListener('touchmove', (e) => {
    if (!active) return;
    e.preventDefault();
    fire(active, 'mousemove', e.touches[0]);
  }, { passive: false, capture: true });
  const end = (e) => {
    if (!active) return;
    const t = e.changedTouches[0];
    fire(active, 'mouseup', t);
    active = null;
  };
  document.addEventListener('touchend', end, { capture: true });
  document.addEventListener('touchcancel', end, { capture: true });

  // Android's WebView draws a grey "play" placeholder over a paused video until it plays; a
  // blank poster plus a tiny seek shows the real first frame instead.
  window.addEventListener('DOMContentLoaded', () => {
    const video = document.getElementById('video');
    if (!video) return;
    video.poster = 'data:image/gif;base64,R0lGODlhAQABAIAAAAAAAP///yH5BAEAAAAALAAAAAABAAEAAAIBRAA7';
    video.addEventListener('loadeddata', () => { if (video.paused && video.currentTime === 0) video.currentTime = 0.001; });
  });

  // On a phone the panel sheet starts closed (tap a button in the bottom bar to open it).
  window.addEventListener('DOMContentLoaded', () => {
    if (window.matchMedia('(max-width: 900px)').matches) setTimeout(() => document.querySelector('.rail-btn.on')?.click(), 0);
  });

  // First run on a phone: timeline hidden (it slides up from the top-bar button), compact look.
  try {
    if (!localStorage.getItem('cutline.appearance')) localStorage.setItem('cutline.appearance', JSON.stringify({ timeline: false, density: 'compact' }));
  } catch {}
})();
