/**
 * iOS only, injected into the Base44 web app before it loads.
 *
 * The web player's full screen button runs `container.requestFullscreen?.()` and exits with
 * `document.exitFullscreen()`. iPhone WebKit only implements element full screen for a bare
 * <video>, so on iPhone the button silently does nothing. This supplies the missing calls:
 * "full screen" makes the player container fill the viewport (keeping the web player's own
 * controls and language menu) and reports the change so the app can rotate to landscape.
 * If the browser does support container full screen, that is used and this stays out of the way.
 */
export const IOS_WEB_FULLSCREEN_POLYFILL = `
(function() {
  if (window.__icareFsPoly) return;
  window.__icareFsPoly = true;

  function post(o) {
    try { window.ReactNativeWebView && window.ReactNativeWebView.postMessage(JSON.stringify(o)); } catch (e) {}
  }

  var nativeReq = Element.prototype.requestFullscreen || Element.prototype.webkitRequestFullscreen;
  var nativeExit = document.exitFullscreen || document.webkitExitFullscreen;
  var nativeOk = typeof nativeReq === 'function'
    && document.fullscreenEnabled !== false && document.webkitFullscreenEnabled !== false;
  var elDesc = Object.getOwnPropertyDescriptor(Document.prototype, 'fullscreenElement')
    || Object.getOwnPropertyDescriptor(Document.prototype, 'webkitFullscreenElement');
  function nativeElement() { try { return elDesc && elDesc.get ? elDesc.get.call(document) : null; } catch (e) { return null; } }

  post({ type: 'FS_DIAG', event: 'env', tag: 'requestFullscreen=' + typeof nativeReq + ' enabled=' + document.fullscreenEnabled + ' ua=' + (navigator.userAgent.match(/OS [0-9_]+/) || [''])[0] });

  var style = document.createElement('style');
  style.textContent =
    '.__icare-fs{position:fixed!important;top:0!important;left:0!important;right:0!important;bottom:0!important;' +
    'width:100vw!important;height:100vh!important;height:100dvh!important;max-width:none!important;max-height:none!important;' +
    'margin:0!important;padding:0!important;border-radius:0!important;z-index:2147483647!important;background:#000!important;' +
    'aspect-ratio:auto!important;transform:none!important}' +
    '.__icare-fs video{width:100%!important;height:100%!important;max-height:none!important;object-fit:contain!important}' +
    '.__icare-fs-anc{transform:none!important;filter:none!important;perspective:none!important;contain:none!important;' +
    'overflow:visible!important;will-change:auto!important;backdrop-filter:none!important;clip-path:none!important}';
  (document.head || document.documentElement).appendChild(style);

  var active = null;
  var ancestors = [];
  function fire() {
    ['fullscreenchange', 'webkitfullscreenchange'].forEach(function(n) { document.dispatchEvent(new Event(n)); });
  }
  function enter(el) {
    if (active) return Promise.resolve();
    active = el;
    el.classList.add('__icare-fs');
    for (var p = el.parentElement; p && p !== document.documentElement; p = p.parentElement) {
      p.classList.add('__icare-fs-anc');
      ancestors.push(p);
    }
    post({ type: 'FS_DIAG', event: 'pseudo-enter', tag: el.tagName });
    fire();
    return Promise.resolve();
  }
  function leave() {
    if (!active) return Promise.resolve();
    active.classList.remove('__icare-fs');
    ancestors.forEach(function(p) { p.classList.remove('__icare-fs-anc'); });
    ancestors = [];
    active = null;
    post({ type: 'FS_DIAG', event: 'pseudo-exit', tag: '' });
    fire();
    return Promise.resolve();
  }

  Element.prototype.requestFullscreen = function() {
    var el = this;
    if (nativeOk) {
      try {
        return Promise.resolve(nativeReq.call(el)).catch(function() { return enter(el); });
      } catch (e) { return enter(el); }
    }
    return enter(el);
  };
  Element.prototype.webkitRequestFullscreen = Element.prototype.requestFullscreen;

  document.exitFullscreen = function() {
    if (active) return leave();
    return nativeExit ? Promise.resolve(nativeExit.call(document)) : Promise.resolve();
  };
  document.webkitExitFullscreen = document.exitFullscreen;

  ['fullscreenElement', 'webkitFullscreenElement'].forEach(function(name) {
    Object.defineProperty(document, name, { configurable: true, get: function() { return active || nativeElement(); } });
  });
  ['fullscreenEnabled', 'webkitFullscreenEnabled'].forEach(function(name) {
    Object.defineProperty(document, name, { configurable: true, get: function() { return true; } });
  });

  // The player may be removed (page navigation) while in full screen: restore and tell native.
  setInterval(function() { if (active && !active.isConnected) leave(); }, 500);
})();
`;
