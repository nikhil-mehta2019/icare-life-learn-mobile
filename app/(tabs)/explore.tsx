/**
 * explore.tsx
 *
 * Hosts the Base44 web app in a full-screen WebView and bridges chapter
 * navigation events to the native player screen.
 *
 * ─── Architecture ─────────────────────────────────────────────────────────────
 *
 *  SPA navigation (primary trigger):
 *   Base44 uses client-side routing (pushState / replaceState).  The injected
 *   JS wraps those history methods and fires checkUrl() after each navigation.
 *   When a chapter URL is detected:
 *     1. Injected JS fetches Chapter entity (api_key sufficient).
 *     2. Base44's SPA renders its own chapter player and calls getMuxToken
 *        with its full auth headers (session token from localStorage).
 *     3. A monkey-patched fetch interceptor captures that getMuxToken response.
 *     4. Injected JS posts OPEN_CHAPTER_WITH_TOKENS (tokens + chapter) →
 *        native caches data, then pushes the player screen.
 *   Note: we do NOT call getMuxToken ourselves in this path — our direct call
 *   returns 401 because we cannot read Base44's localStorage session token.
 *
 *  Token re-request (download / delete-download):
 *   The native player posts REQUEST_TOKENS to the WebView when it needs fresh
 *   tokens after an offline copy is deleted or when initiating a download.
 *   The WebView bridge handles this the same way as the auto-fetch path.
 *
 *  What was removed vs the previous implementation:
 *   • history.back() after chapter detection — was the primary cause of
 *     Unauthorized errors (navigated away mid-fetch, disrupting session context)
 *   • _lastFiredId reset timer — caused double OPEN_CHAPTER after 1.5 s
 *   • onShouldStartLoadWithRequest chapter interception — caused duplicate
 *     router.push() when both the JS bridge and the URL interceptor fired
 *   • Hardcoded API key inside the injected JS string — key is now passed from
 *     native via injectJavaScript() when the bridge is initialized, keeping it
 *     out of the static JS bundle text
 *
 * ─── Message types ────────────────────────────────────────────────────────────
 *
 *  WebView → Native:
 *   { type: 'BRIDGE_READY' }                        bridge installed and ready
 *   { type: 'OPEN_CHAPTER',  chapterId: string }    player should open
 *   { type: 'CHAPTER_TOKENS', chapterId, chapter, tokens }
 *   { type: 'CHAPTER_ERROR',  chapterId, error }
 *
 *  Native → WebView  (via injectJavaScript):
 *   window.__icareFetchTokens(chapterId, apiKey, baseApi)
 */

import { useRouter, type Href } from 'expo-router';
import { useCallback, useEffect, useRef } from 'react';
import { Alert, Platform, StyleSheet } from 'react-native';
import { WebView, type WebViewMessageEvent } from 'react-native-webview';
import type { ShouldStartLoadRequest } from 'react-native-webview/lib/WebViewTypes';
import { deliverPlayerData, deliverPlayerError } from '../../api/playerCache';
import { API_KEY, BASE_URL } from '../../api/base44Client';
import IcareOfflineDrm from '../../modules/icare-offline-drm';

const BASE44_URL = 'https://icare-life-learn.base44.app';

// ─── Chapter URL patterns ────────────────────────────────────────────────────
//
// These are the single source-of-truth patterns.  The injected JS receives
// them serialised as a JSON array — no regex drift between TS and the WebView.
//
// Each pattern:  capturing group 1 = chapterId

/**
 * Regex source strings (no flags) shared with the injected JS.
 * Keep capture group 1 = chapterId in every pattern.
 */
export const CHAPTER_REGEX_SOURCES: string[] = [
  // /chapter/{courseId}/{chapterId}  — primary Base44 pattern
  '\\/chapter\\/[A-Za-z0-9_-]{8,}\\/([A-Za-z0-9_-]{8,})(?:\\/|\\?|#|$)',
  // /student/chapter/{courseId}/{chapterId}
  '\\/student\\/chapter\\/[A-Za-z0-9_-]{8,}\\/([A-Za-z0-9_-]{8,})(?:\\/|\\?|#|$)',
  // #chapter-player?id=  or  /chapter-player?id=
  '[\\/#]chapter-player[\\/?](?:.*[?&])?id=([A-Za-z0-9_-]{8,})',
  // #ChapterPlayer?id=  or  /ChapterPlayer?id=
  '[\\/#]ChapterPlayer[\\/?](?:.*[?&])?id=([A-Za-z0-9_-]{8,})',
  // /ChapterPlayer?id=
  '\\/ChapterPlayer\\?(?:.*&)?id=([A-Za-z0-9_-]{8,})',
  // /chapter-player?id=
  '\\/chapter-player\\?(?:.*&)?id=([A-Za-z0-9_-]{8,})',
];

/** Compiled TypeScript regexes (case-insensitive for the hash/query variants). */
const CHAPTER_REGEXES: RegExp[] = CHAPTER_REGEX_SOURCES.map(
  (src, i) => new RegExp(src, i >= 2 ? 'i' : '')
);

export function extractChapterId(url: string): string | null {
  for (const re of CHAPTER_REGEXES) {
    const m = url.match(re);
    if (m?.[1]) return m[1];
  }
  return null;
}

// ─── Injected JavaScript ─────────────────────────────────────────────────────
//
// Injected before page content so it survives SPA navigations.
//
// API key is embedded here at build time. It is present in the compiled JS
// bundle regardless (imported via base44Client.ts), so embedding it here costs
// nothing extra in security terms and avoids a fatal timing race: if the key
// were delivered only after BRIDGE_READY, a chapter tap during the first 800ms
// of page load would call _doFetchTokens() before the key arrived, post
// CHAPTER_ERROR immediately, and show "Could not load chapter" on the first tap.
//
// Regex sources are serialised as JSON from the TS constant above so they
// stay in sync with the native detection logic — one source of truth.

const REGEX_SOURCES_JSON = JSON.stringify(CHAPTER_REGEX_SOURCES);
// Flags array: indices 0-1 use '', indices 2+ use 'i'
const REGEX_FLAGS_JSON = JSON.stringify(
  CHAPTER_REGEX_SOURCES.map((_, i) => (i >= 2 ? 'i' : ''))
);

const INJECTED_JS = `
(function() {
  if (window.__icareNativeBridgeInstalled) return;
  window.__icareNativeBridgeInstalled = true;

  // ── Logging helper ────────────────────────────────────────────────────────
  function log(level, msg, data) {
    var prefix = '[icare-bridge] ';
    if (data !== undefined) {
      console[level](prefix + msg, data);
    } else {
      console[level](prefix + msg);
    }
  }

  // ── Compiled regexes (sourced from TS — no drift) ─────────────────────────
  var _sources = ${REGEX_SOURCES_JSON};
  var _flags   = ${REGEX_FLAGS_JSON};
  var _regexes = _sources.map(function(src, i) {
    return new RegExp(src, _flags[i]);
  });

  function getChapterIdFromUrl(url) {
    for (var i = 0; i < _regexes.length; i++) {
      var m = url.match(_regexes[i]);
      if (m && m[1]) return m[1];
    }
    return null;
  }

  // ── API credentials — embedded at build time ──────────────────────────────
  // These are present in the compiled JS bundle via base44Client.ts regardless.
  // Embedding them here ensures token fetches work immediately on the first tap
  // without waiting for a BRIDGE_READY → injectJavaScript round-trip.
  var _apiKey  = ${JSON.stringify(API_KEY)};
  var _baseApi = ${JSON.stringify(BASE_URL)};

  // ── Fetch helper with AbortController timeout ─────────────────────────────
  var FETCH_TIMEOUT_MS = 8000;

  function fetchJsonWithTimeout(label, url, options, timeoutMs) {
    return new Promise(function(resolve, reject) {
      var controller = (typeof AbortController !== 'undefined') ? new AbortController() : null;
      var timer = setTimeout(function() {
        if (controller) controller.abort();
        reject(new Error(label + ' timed out after ' + timeoutMs + 'ms'));
      }, timeoutMs);
      var opts = controller
        ? Object.assign({}, options, { signal: controller.signal })
        : options;
      fetch(url, opts).then(function(r) {
        clearTimeout(timer);
        resolve(r);
      }).catch(function(e) {
        clearTimeout(timer);
        reject(e);
      });
    });
  }

  // ── getMuxToken interceptor (fetch + XHR) + direct-call fallback ─────────
  //
  // Root cause of "Unauthorized": getMuxToken requires the user's session
  // token, which Base44 stores in localStorage and sends as a custom header.
  // credentials:'include' only sends cookies — not localStorage — so our
  // direct getMuxToken call gets 401.
  //
  // Strategy (navigation flow): run TWO paths in PARALLEL (_firstSuccess):
  //   A) Intercept Base44's getMuxToken call via fetch or XHR — succeeds
  //      because Base44's code sends the localStorage token automatically.
  //   B) Direct getMuxToken call using captured headers + localStorage JWT.
  // Whichever resolves first wins.  Both paths converge: if B succeeds, the
  // monkey-patched fetch also fires the interceptor, resolving A too.
  //
  // _capturedAuthHeaders : headers saved from any successful getMuxToken call.
  // _tokenWaiters        : FIFO queue for _waitForInterceptedTokens.
  // _bufferedTokens      : last intercepted result (captured before any waiter).

  var _capturedAuthHeaders = {};
  var _tokenWaiters = [];
  var _bufferedTokens = null;

  // Deliver intercepted tokens to the next waiter, or buffer them.
  function _deliverTokens(tokens) {
    if (_tokenWaiters.length) {
      var w = _tokenWaiters.shift();
      clearTimeout(w.timer);
      w.resolve(tokens);
      log('info', 'Delivered intercepted tokens to waiter');
    } else {
      _bufferedTokens = tokens;
      log('info', 'Buffered intercepted tokens (no waiter yet)');
    }
  }

  // Wait for any intercepted getMuxToken response (not filtered by playbackId).
  function _waitForInterceptedTokens() {
    if (_bufferedTokens) {
      var t = _bufferedTokens;
      _bufferedTokens = null;
      log('info', 'Using buffered intercepted tokens');
      return Promise.resolve(t);
    }
    return new Promise(function(resolve, reject) {
      var timer = setTimeout(function() {
        for (var i = 0; i < _tokenWaiters.length; i++) {
          if (_tokenWaiters[i].timer === timer) { _tokenWaiters.splice(i, 1); break; }
        }
        reject(new Error('Timed out waiting for getMuxToken intercept'));
      }, FETCH_TIMEOUT_MS);
      _tokenWaiters.push({ resolve: resolve, reject: reject, timer: timer });
      log('info', 'Waiting to intercept getMuxToken (' + _tokenWaiters.length + ' waiter(s))');
    });
  }

  // Resolve with the first promise to fulfil; reject only if ALL reject.
  function _firstSuccess(promises) {
    return new Promise(function(resolve, reject) {
      var rejCount = 0;
      var settled = false;
      promises.forEach(function(p) {
        p.then(function(v) {
          if (!settled) { settled = true; resolve(v); }
        }).catch(function(e) {
          rejCount++;
          if (rejCount === promises.length && !settled) reject(e);
        });
      });
    });
  }

  // Scan localStorage for a JWT (base64url strings start with 'ey').
  function _getLocalStorageJwt() {
    try {
      for (var i = 0; i < localStorage.length; i++) {
        var v = localStorage.getItem(localStorage.key(i));
        if (!v) continue;
        if (v.indexOf('ey') === 0 && v.length > 100) return v;
        if (v.charAt(0) === '{') {
          try {
            var o = JSON.parse(v);
            var t = o.access_token || o.token || o.jwt || o.authToken || o.id_token;
            if (t && t.indexOf('ey') === 0) return t;
          } catch (e) {}
        }
      }
    } catch (e) {}
    return null;
  }

  // ── Install fetch interceptor ─────────────────────────────────────────────
  (function _installFetchInterceptor() {
    var _orig = window.fetch;
    window.fetch = function(url, opts) {
      var result = _orig.apply(this, arguments);
      if (typeof url === 'string' && url.indexOf('/functions/getMuxToken') !== -1) {
        // Capture auth headers for future direct calls.
        if (opts && opts.headers && !_capturedAuthHeaders._ready) {
          try {
            var h = opts.headers;
            if (typeof h.forEach === 'function') {
              var tmp = {}; h.forEach(function(v, k) { tmp[k] = v; }); h = tmp;
            }
            Object.keys(h).forEach(function(k) {
              if (k.toLowerCase() !== 'content-type') _capturedAuthHeaders[k] = h[k];
            });
            _capturedAuthHeaders._ready = true;
            log('info', 'Captured auth headers from fetch getMuxToken');
            // Re-send JWT now that we have confirmed auth headers.
            var freshJwt = _getLocalStorageJwt();
            if (freshJwt) _postMessage({ type: 'AUTH_JWT', jwt: freshJwt });
          } catch (e) {}
        }
        // Intercept successful responses.
        result.then(function(res) {
          if (!res.ok) return;
          res.clone().json().then(function(tokens) {
            if (tokens && tokens.secureStreamUrl) _deliverTokens(tokens);
          }).catch(function() {});
        }).catch(function() {});
      }
      return result;
    };
    log('info', 'Fetch interceptor installed');
  })();

  // ── Install XHR interceptor (Base44 may use XHR instead of fetch) ─────────
  (function _installXhrInterceptor() {
    var _origOpen = XMLHttpRequest.prototype.open;
    var _origSend = XMLHttpRequest.prototype.send;
    XMLHttpRequest.prototype.open = function(method, url) {
      this._icareUrl = (typeof url === 'string') ? url : '';
      return _origOpen.apply(this, arguments);
    };
    XMLHttpRequest.prototype.send = function() {
      if (this._icareUrl && this._icareUrl.indexOf('/functions/getMuxToken') !== -1) {
        var xhr = this;
        xhr.addEventListener('readystatechange', function() {
          if (xhr.readyState === 4 && xhr.status >= 200 && xhr.status < 300 && !xhr._icareDone) {
            xhr._icareDone = true;
            try {
              var tokens = JSON.parse(xhr.responseText);
              if (tokens && tokens.secureStreamUrl) {
                _deliverTokens(tokens);
                log('info', 'XHR getMuxToken intercepted');
              }
            } catch (e) {}
          }
        });
      }
      return _origSend.apply(this, arguments);
    };
    log('info', 'XHR interceptor installed');
  })();

  // __icareFetchTokens: called by native for download / delete-download.
  window.__icareFetchTokens = function(chapterId) {
    _doFetchTokens(chapterId, false);
  };

  function _doFetchTokens(chapterId, navigateAfter) {
    var key = _apiKey;
    var api = _baseApi;
    log('info', 'Fetching tokens for chapter ' + chapterId);
    var hdrs = { 'Content-Type': 'application/json', 'api_key': key };

    // Step 1: Chapter entity — api_key is sufficient, no user session needed.
    fetchJsonWithTimeout('Chapter fetch', api + '/entities/Chapter/' + chapterId,
          { headers: hdrs, credentials: 'include' }, FETCH_TIMEOUT_MS)
      .then(function(r) {
        if (!r.ok) throw new Error('Chapter fetch failed (' + r.status + ')');
        return r.json();
      })
      .then(function(chapter) {
        var playbackId =
          (chapter.muxDrmProtected && chapter.muxDrmPlaybackId)
            ? chapter.muxDrmPlaybackId
          : (chapter.muxSignedPlaybackRequired && chapter.muxSignedPlaybackId)
            ? chapter.muxSignedPlaybackId
          : (chapter.muxPlaybackId || null);

        if (!playbackId) throw new Error('Chapter has no Mux playback ID');

        // Build the best direct-call headers we can assemble.
        var muxHdrs = Object.assign({}, hdrs);
        if (_capturedAuthHeaders._ready) {
          Object.keys(_capturedAuthHeaders).forEach(function(k) {
            if (k !== '_ready') muxHdrs[k] = _capturedAuthHeaders[k];
          });
        } else {
          var jwt = _getLocalStorageJwt();
          if (jwt) {
            muxHdrs['Authorization'] = 'Bearer ' + jwt;
            log('info', 'Using localStorage JWT for getMuxToken');
          }
        }

        // Step 2: Get tokens.
        //
        // Direct call: goes through monkey-patched fetch, so if it succeeds
        // the interceptor also fires _deliverTokens — both paths converge.
        var directPromise = fetchJsonWithTimeout('getMuxToken', api + '/functions/getMuxToken', {
          method: 'POST',
          headers: muxHdrs,
          credentials: 'include',
          body: JSON.stringify({ playbackId: playbackId }),
        }, FETCH_TIMEOUT_MS).then(function(r) {
          if (!r.ok) return r.json().catch(function(){return{};}).then(function(eb){
            throw new Error(eb.error || ('getMuxToken failed (' + r.status + ')'));
          });
          return r.json();
        });

        // Navigation flow: race intercept (fetch+XHR) against direct call.
        // Download/refresh flow: direct call only (no Base44 nav in progress).
        var tokenPromise = navigateAfter
          ? _firstSuccess([_waitForInterceptedTokens(), directPromise])
          : directPromise;

        return tokenPromise.then(function(tokens) {
          log('info', 'Tokens ready for chapter ' + chapterId);
          if (navigateAfter) {
            _postMessage({ type: 'OPEN_CHAPTER_WITH_TOKENS', chapterId: chapterId,
                           chapter: chapter, tokens: tokens });
          } else {
            _postMessage({ type: 'CHAPTER_TOKENS', chapterId: chapterId,
                           chapter: chapter, tokens: tokens });
          }
        });
      })
      .catch(function(err) {
        log('error', 'Token fetch failed for chapter ' + chapterId + ': ' + String(err));
        if (navigateAfter) {
          _postMessage({ type: 'OPEN_CHAPTER_WITH_ERROR', chapterId: chapterId,
                         error: String(err) });
        } else {
          _postMessage({ type: 'CHAPTER_ERROR', chapterId: chapterId,
                         error: String(err) });
        }
      });
  }

  // ── Outbound message helper ───────────────────────────────────────────────
  function _postMessage(obj) {
    if (window.ReactNativeWebView) {
      window.ReactNativeWebView.postMessage(JSON.stringify(obj));
    } else {
      log('warn', 'ReactNativeWebView not available — cannot post ' + obj.type);
    }
  }

  // ── Floating download button ──────────────────────────────────────────────
  //
  // Rendered as a native-feeling overlay inside the WebView so the user can
  // download a chapter for offline viewing without the native player opening.
  // Appears only when a chapter URL is active; hides when the user navigates away.

  var _dlBtn = null;
  var _dlChapterId = null;
  var _dlInProgress = false;
  var _dlState = null;

  // Called by the native side (via injectJavaScript) to reflect the chapter's
  // actual download state in the floating button without any user interaction.
  window.__icare_updateDlBtnState = function(chapterId, state, pct) {
    if (!_dlBtn || _dlBtn.dataset.cid !== chapterId) return;
    _dlState = state;
    if (state === 'completed') {
      _dlBtn.textContent = '✓ Downloaded';
      _dlBtn.style.background = '#2e7d32';
      _dlBtn.style.opacity = '1';
      _dlInProgress = false;
    } else if (state === 'downloading' || state === 'queued') {
      var p = (typeof pct === 'number' && pct >= 0) ? Math.round(pct) + '%' : '…';
      _dlBtn.textContent = '⏳ ' + p;
      _dlBtn.style.background = '#1D3D47';
      _dlBtn.style.opacity = '0.85';
    } else if (state === 'failed') {
      _dlBtn.textContent = '↺ Retry';
      _dlBtn.style.background = '#b71c1c';
      _dlBtn.style.opacity = '1';
      _dlInProgress = false;
    } else {
      _dlBtn.textContent = '⬇ Download';
      _dlBtn.style.background = '#1D3D47';
      _dlBtn.style.opacity = '1';
      _dlInProgress = false;
    }
  };

  function _showDownloadBtn(chapterId) {
    if (_dlBtn) {
      // Navigated to a different chapter — reset the button and re-check state.
      _dlBtn.dataset.cid = chapterId;
      _dlChapterId = chapterId;
      _dlState = null;
      _dlInProgress = false;
      _dlBtn.textContent = '⬇ Download';
      _dlBtn.style.background = '#1D3D47';
      _dlBtn.style.opacity = '1';
      _postMessage({ type: 'CHECK_DOWNLOAD_STATUS', chapterId: chapterId });
      return;
    }
    var btn = document.createElement('button');
    btn.id = '__icare_dl_btn';
    btn.dataset.cid = chapterId;
    btn.textContent = '⬇ Download';
    btn.style.cssText = [
      'position:fixed',
      'bottom:72px',
      'right:16px',
      'z-index:2147483647',
      'background:#1D3D47',
      'color:#fff',
      'border:none',
      'border-radius:22px',
      'padding:10px 18px',
      'font-size:14px',
      'font-weight:600',
      'box-shadow:0 2px 8px rgba(0,0,0,0.35)',
      'cursor:pointer',
      'display:flex',
      'align-items:center',
      'gap:6px',
      'font-family:system-ui,sans-serif',
      'letter-spacing:0.2px',
    ].join(';');
    btn.addEventListener('click', function() {
      // Chapter already downloaded or queued — open Downloads tab instead.
      if (_dlState === 'completed' || _dlState === 'downloading' || _dlState === 'queued') {
        _postMessage({ type: 'GO_TO_DOWNLOADS' });
        return;
      }
      if (_dlInProgress) return;
      var cid = btn.dataset.cid;
      if (!cid) return;
      _dlInProgress = true;
      btn.textContent = '⏳ Preparing…';
      btn.style.opacity = '0.75';
      _doDownloadFetch(cid, btn);
    });
    document.body.appendChild(btn);
    _dlBtn = btn;
    _dlChapterId = chapterId;
    // Ask native side for current download state so the button is correct immediately.
    _postMessage({ type: 'CHECK_DOWNLOAD_STATUS', chapterId: chapterId });
  }

  function _hideDownloadBtn() {
    if (_dlBtn) { _dlBtn.remove(); _dlBtn = null; }
    _dlChapterId = null;
    _dlInProgress = false;
    _dlState = null;
  }

  function _resetDownloadBtn() {
    _dlInProgress = false;
    _dlState = null;
    if (_dlBtn) { _dlBtn.textContent = '⬇ Download'; _dlBtn.style.background = '#1D3D47'; _dlBtn.style.opacity = '1'; }
  }

  // Separate fetch path for download — posts DOWNLOAD_CHAPTER (not OPEN_CHAPTER).
  // Uses /functions/getMuxDownloadToken → iCare /download endpoint so that
  // DRM chapters receive a manifest URL with Widevine PSSH and a persistent
  // offline license token (drm_offline=true), not the signed streaming manifest.
  function _doDownloadFetch(chapterId, btn) {
    var key = _apiKey;
    var api = _baseApi;
    var hdrs = { 'Content-Type': 'application/json', 'api_key': key };

    fetchJsonWithTimeout('Chapter fetch', api + '/entities/Chapter/' + chapterId,
          { headers: hdrs, credentials: 'include' }, FETCH_TIMEOUT_MS)
      .then(function(r) {
        if (!r.ok) throw new Error('Chapter fetch failed (' + r.status + ')');
        return r.json();
      })
      .then(function(chapter) {
        var playbackId =
          (chapter.muxDrmProtected && chapter.muxDrmPlaybackId)
            ? chapter.muxDrmPlaybackId
          : (chapter.muxSignedPlaybackRequired && chapter.muxSignedPlaybackId)
            ? chapter.muxSignedPlaybackId
          : (chapter.muxPlaybackId || null);
        if (!playbackId) throw new Error('Chapter has no Mux playback ID');

        var muxHdrs = Object.assign({}, hdrs);
        if (_capturedAuthHeaders._ready) {
          Object.keys(_capturedAuthHeaders).forEach(function(k) {
            if (k !== '_ready') muxHdrs[k] = _capturedAuthHeaders[k];
          });
        } else {
          var jwt = _getLocalStorageJwt();
          if (jwt) { muxHdrs['Authorization'] = 'Bearer ' + jwt; }
        }

        return fetchJsonWithTimeout('getMuxDownloadToken', api + '/functions/getMuxDownloadToken', {
          method: 'POST',
          headers: muxHdrs,
          credentials: 'include',
          body: JSON.stringify({ playbackId: playbackId }),
        }, FETCH_TIMEOUT_MS).then(function(r) {
          if (!r.ok) return r.json().catch(function(){return{};}).then(function(eb){
            throw new Error(eb.error || ('getMuxDownloadToken failed (' + r.status + ')'));
          });
          return r.json();
        }).then(function(dlTokens) {
          log('info', '[OFFLINE-DRM] playbackId=' + playbackId
            + ' drmEnabled=' + dlTokens.drmEnabled
            + ' manifestUrl=' + (dlTokens.manifestUrl || 'null')
            + ' widevineLicenseUrl=' + (dlTokens.widevineLicenseUrl || 'null'));
          _postMessage({ type: 'DOWNLOAD_CHAPTER', chapterId: chapterId,
                         chapter: chapter, dlTokens: dlTokens });
          if (btn) { btn.textContent = '✓ Queued'; btn.style.background = '#2e7d32'; }
          setTimeout(function() { _resetDownloadBtn(); }, 3000);
        });
      })
      .catch(function(err) {
        log('error', 'Download fetch failed: ' + String(err));
        _postMessage({ type: 'DOWNLOAD_ERROR', chapterId: chapterId, error: String(err) });
        if (btn) { btn.textContent = '✗ Failed'; btn.style.background = '#b71c1c'; }
        setTimeout(function() { _resetDownloadBtn(); }, 3000);
      });
  }

  // ── SPA navigation monitor ────────────────────────────────────────────────
  //
  // De-duplication: _lastFiredId is cleared ONLY when the URL actually changes
  // away from a chapter URL — not on a fixed timer.  This prevents the
  // double-fire that the old 1500 ms reset timer caused.
  var _lastFiredId = null;

  function checkUrl() {
    var href = window.location.href;
    var chapterId = getChapterIdFromUrl(href);

    if (!chapterId) {
      // URL is no longer a chapter URL — reset so the next chapter tap fires.
      if (_lastFiredId !== null) {
        log('info', 'Left chapter URL — resetting dedup guard');
        _lastFiredId = null;
      }
      _hideDownloadBtn();
      return;
    }

    _showDownloadBtn(chapterId);

    if (chapterId === _lastFiredId) {
      // Same chapter URL — already handled this navigation.
      return;
    }

    _lastFiredId = chapterId;
    log('info', 'Chapter URL detected: ' + chapterId + ' — fetching tokens before opening player');

    // Fetch tokens FIRST while the WebView is still in the foreground, then
    // post OPEN_CHAPTER.  This ensures window.ReactNativeWebView.postMessage
    // is available when CHAPTER_TOKENS fires — posting OPEN_CHAPTER first
    // caused the Explore screen to be detached before the async fetch resolved,
    // silently dropping the postMessage call.
    _doFetchTokens(chapterId, true);
  }

  // ── Patch history methods ─────────────────────────────────────────────────
  var _origPush    = history.pushState;
  var _origReplace = history.replaceState;

  history.pushState = function() {
    _origPush.apply(this, arguments);
    setTimeout(checkUrl, 150);
  };
  history.replaceState = function() {
    _origReplace.apply(this, arguments);
    setTimeout(checkUrl, 150);
  };
  window.addEventListener('popstate',   function() { setTimeout(checkUrl, 150); });
  window.addEventListener('hashchange', function() { setTimeout(checkUrl, 150); });

  // ── Signal native that bridge is installed ────────────────────────────────
  log('info', 'Bridge installed');
  _postMessage({ type: 'BRIDGE_READY' });

  // Send auth JWT to native immediately so the player can call getMuxToken
  // directly when the WebView is backgrounded (avoids backgrounded HTTP fetch).
  (function _sendJwtToNative() {
    var jwt = _getLocalStorageJwt();
    if (jwt) {
      _postMessage({ type: 'AUTH_JWT', jwt: jwt });
      log('info', 'AUTH_JWT sent to native (' + jwt.length + ' chars)');
    } else {
      // Retry after localStorage may have been populated by the app.
      setTimeout(function() {
        var j = _getLocalStorageJwt();
        if (j) {
          _postMessage({ type: 'AUTH_JWT', jwt: j });
          log('info', 'AUTH_JWT sent to native (delayed, ' + j.length + ' chars)');
        }
      }, 2000);
    }
  })();

  // Check current URL in case the WebView was restored on a chapter URL.
  setTimeout(checkUrl, 800);
  true;
})();
`.trim();

// ─── Component ───────────────────────────────────────────────────────────────

export default function ExploreScreen() {
  const router = useRouter();
  const webRef = useRef<WebView>(null);

  /**
   * Triggers a fresh token fetch inside the WebView for a specific chapter.
   * Used by the download and delete-download flows in the player screen.
   * The API key is already embedded in the injected JS — we only need to
   * call __icareFetchTokens with the chapterId.
   */
  const injectApiCredentials = useCallback((chapterId?: string) => {
    if (!chapterId) return;
    const hasRef = webRef.current !== null;
    console.log(`[explore] injectApiCredentials ENTER — chapterId=${chapterId} webRef=${hasRef ? 'SET' : 'NULL'}`);
    if (!hasRef) {
      console.warn(`[explore] injectApiCredentials: webRef is NULL — WebView not mounted or not yet loaded. Script will NOT be injected.`);
      return;
    }
    const script = `
      console.log('[icare-bridge] __icareFetchTokens called from native for ${chapterId}');
      if (typeof window.__icareFetchTokens === 'function') {
        window.__icareFetchTokens(${JSON.stringify(chapterId)});
        true;
      } else {
        console.error('[icare-bridge] __icareFetchTokens NOT DEFINED — bridge not installed');
        window.ReactNativeWebView && window.ReactNativeWebView.postMessage(JSON.stringify({
          type: 'CHAPTER_ERROR',
          chapterId: ${JSON.stringify(chapterId)},
          error: '__icareFetchTokens not defined — bridge may not have loaded yet'
        }));
        true;
      }
    `;
    webRef.current!.injectJavaScript(script);
    console.log(`[explore] injectJavaScript dispatched for chapterId=${chapterId}`);
  }, []);

  /**
   * onMessage — single entry point for all WebView → native messages.
   *
   * BRIDGE_READY              — diagnostic signal, credentials already embedded
   * OPEN_CHAPTER_WITH_TOKENS  — cache tokens FIRST, then push player screen
   * OPEN_CHAPTER_WITH_ERROR   — log only, stay on WebView (V1 fallback)
   * OPEN_CHAPTER              — legacy fallback: navigate without pre-cached data
   * CHAPTER_TOKENS            — deliver tokens for download / delete-download flows
   * CHAPTER_ERROR             — unblock player for download / delete-download flows
   */
  const onMessage = useCallback(
    (e: WebViewMessageEvent) => {
      let msg: Record<string, unknown>;
      try {
        msg = JSON.parse(e.nativeEvent.data);
      } catch {
        // Non-JSON messages (e.g. from third-party scripts) are ignored.
        return;
      }

      const type = msg?.type;
      const chapterId = typeof msg?.chapterId === 'string' ? msg.chapterId : undefined;

      switch (type) {
        case 'BRIDGE_READY':
          // API key is already embedded in injectedJavaScriptBeforeContentLoaded.
          // BRIDGE_READY is kept as a diagnostic signal — log it and move on.
          console.log('[explore] WebView bridge ready — credentials already embedded, no injection needed');
          break;

        case 'OPEN_CHAPTER_WITH_TOKENS':
          if (!chapterId) {
            console.warn('[explore] OPEN_CHAPTER_WITH_TOKENS received without chapterId — ignored');
            break;
          }
          // Always cache tokens so offline-download flows can reuse them.
          deliverPlayerData(chapterId, {
            chapter: msg.chapter as any,
            tokens: msg.tokens as any,
          });
          if (Platform.OS === 'android') {
            // On Android, react-native-video is disabled for online playback.
            // Base44 WebView handles streaming natively — do NOT navigate to
            // the native player screen, which would interrupt playback by
            // showing the webview-fallback download drawer instead of the video.
            // Downloads remain available via the floating ⬇ button in the WebView.
            console.log(`[explore] OPEN_CHAPTER_WITH_TOKENS on Android — tokens cached, staying in WebView for chapter ${chapterId}`);
            break;
          }
          console.log(`[explore] OPEN_CHAPTER_WITH_TOKENS → caching then navigating for chapter ${chapterId}`);
          router.push({
            pathname: '/player/[chapterId]',
            params: { chapterId },
          } as unknown as Href);
          break;

        case 'OPEN_CHAPTER_WITH_ERROR':
          if (!chapterId) {
            console.warn('[explore] OPEN_CHAPTER_WITH_ERROR received without chapterId — ignored');
            break;
          }
          // V1 stability: token bridge failed (Unauthorized / timeout / network).
          // Do NOT navigate to the native player error screen.
          // Do NOT call deliverPlayerError — no native player is waiting.
          // Base44 WebView playback is the confirmed working fallback: leave
          // the user on the chapter page so the video continues playing there.
          console.warn(
            `[explore] Native token bridge failed for chapter ${chapterId}; ` +
            `staying on WebView playback fallback: ${msg.error}`
          );
          break;

        case 'OPEN_CHAPTER':
          if (!chapterId) {
            console.warn('[explore] OPEN_CHAPTER received without chapterId — ignored');
            break;
          }
          console.log(`[explore] OPEN_CHAPTER → navigating to player for chapter ${chapterId}`);
          router.push({
            pathname: '/player/[chapterId]',
            params: { chapterId },
          } as unknown as Href);
          break;

        case 'CHAPTER_TOKENS':
          if (!chapterId) {
            console.warn('[explore] CHAPTER_TOKENS received without chapterId — ignored');
            break;
          }
          console.log(`[explore] CHAPTER_TOKENS received for chapter ${chapterId}`);
          deliverPlayerData(chapterId, {
            chapter: msg.chapter as any,
            tokens: msg.tokens as any,
          });
          break;

        case 'CHAPTER_ERROR':
          if (!chapterId) {
            console.warn('[explore] CHAPTER_ERROR received without chapterId — ignored');
            break;
          }
          console.warn(`[explore] CHAPTER_ERROR for chapter ${chapterId}: ${msg.error}`);
          deliverPlayerError(chapterId, String(msg.error ?? 'Unknown error from WebView bridge'));
          break;

        case 'DOWNLOAD_CHAPTER': {
          if (!chapterId) {
            console.warn('[explore] DOWNLOAD_CHAPTER received without chapterId — ignored');
            break;
          }
          const dlChapter = msg.chapter as any;
          const dlTokens  = msg.dlTokens  as any;
          console.log(`[explore] DOWNLOAD_CHAPTER — starting offline download for chapter ${chapterId} drmEnabled=${dlTokens?.drmEnabled}`);
          // Base44 Chapter entity uses 'title'; fall back through 'name' / 'label'
          // before using the raw ID. Log the chapter object to diagnose field names.
          console.log(`[explore] DOWNLOAD_CHAPTER chapter fields: ${JSON.stringify(Object.keys(dlChapter ?? {}))}`);
          console.log(`[explore] DOWNLOAD_CHAPTER chapter.title=${dlChapter?.title} chapter.name=${dlChapter?.name}`);
          const chapterTitle: string =
            dlChapter?.title || dlChapter?.name || dlChapter?.label || chapterId;
          const thumbnailUrl: string | undefined =
            dlChapter?.videoPosterUrl || dlChapter?.thumbnailUrl || dlChapter?.posterUrl || undefined;
          const durationSeconds: number | undefined =
            dlChapter?.estimatedMinutes
              ? Math.round(dlChapter.estimatedMinutes * 60)
              : undefined;
          IcareOfflineDrm.startDownload({
            id:            chapterId,
            manifestUrl:   dlTokens.manifestUrl,
            drmLicenseUrl: dlTokens.widevineLicenseUrl ?? '',
            drmToken:      dlTokens.drmToken ?? '',
            title:         chapterTitle,
            thumbnailUrl,
            durationSeconds,
          }).catch((err: any) => {
            console.error(`[explore] Download failed for chapter ${chapterId}:`, err);
            Alert.alert('Download failed', err?.message ?? String(err));
          });
          break;
        }

        case 'DOWNLOAD_ERROR':
          if (!chapterId) break;
          console.warn(`[explore] DOWNLOAD_ERROR for chapter ${chapterId}: ${msg.error}`);
          Alert.alert('Download failed', String(msg.error ?? 'Could not fetch tokens for download'));
          break;

        case 'CHECK_DOWNLOAD_STATUS':
          // WebView is asking whether this chapter is already downloaded.
          // Respond by injecting __icare_updateDlBtnState() so the floating
          // button immediately reflects the real state (Downloaded / Downloading / etc.)
          if (!chapterId) break;
          IcareOfflineDrm.getDownload(chapterId).then((dl: any) => {
            const dlState = dl?.state ?? null;
            const dlPct   = typeof dl?.percentDownloaded === 'number' ? dl.percentDownloaded : -1;
            webRef.current?.injectJavaScript(
              `window.__icare_updateDlBtnState(${JSON.stringify(chapterId)},${JSON.stringify(dlState)},${dlPct}); true;`
            );
          }).catch(() => {});
          break;

        case 'GO_TO_DOWNLOADS':
          // User tapped the floating button while chapter was already downloaded.
          router.push('/(tabs)/downloads' as any);
          break;

        case 'AUTH_JWT':
          if (typeof msg.jwt === 'string' && msg.jwt.length > 50) {
            _storeAuthJwt(msg.jwt);
            console.log(`[explore] AUTH_JWT stored (${(msg.jwt as string).length} chars)`);
          }
          break;

        default:
          // Unknown message types are silently discarded.
          break;
      }
    },
    [router, injectApiCredentials]
  );

  /**
   * onShouldStartLoadWithRequest — only used to open genuinely external URLs
   * in the system browser.  Chapter URL interception has been REMOVED because
   * the injected JS bridge already handles chapter detection via the SPA
   * navigation hooks — intercepting here caused duplicate router.push() calls.
   */
  const onShouldStartLoadWithRequest = useCallback(
    (req: ShouldStartLoadRequest) => {
      // Allow all same-origin and relative navigation inside the WebView.
      if (req.url.startsWith(BASE44_URL) || req.url.startsWith('about:')) {
        return true;
      }
      // For external links, you could open the system browser here.
      // For now, block unexpected external navigations silently.
      console.warn(`[explore] Blocking external navigation to: ${req.url}`);
      return false;
    },
    []
  );

  /**
   * When the player screen needs fresh tokens (download / delete-download),
   * it calls this function which calls window.__icareFetchTokens(chapterId)
   * inside the authenticated WebView.  The API key is already embedded in the
   * injected JS — only the chapterId needs to be passed at call time.
   * The player calls waitForPlayerData() to receive the result.
   */
  const requestTokensFromWebView = useCallback((chapterId: string) => {
    console.log(`[explore] requestTokensFromWebView called for chapter ${chapterId}`);
    injectApiCredentials(chapterId);
  }, [injectApiCredentials]);

  // Register the token requester in an effect so it is set after mount and
  // cleared on unmount. Calling _setTokenRequester in the render body was a
  // React rules violation (side effect during render) and could leave a stale
  // closure if the screen unmounts while the player is waiting for tokens.
  useEffect(() => {
    _setTokenRequester(requestTokensFromWebView);
    return () => { _setTokenRequester(null); };
  }, [requestTokensFromWebView]);

  return (
    <WebView
      ref={webRef}
      source={{ uri: BASE44_URL }}
      style={styles.webview}
      javaScriptEnabled
      domStorageEnabled
      sharedCookiesEnabled
      thirdPartyCookiesEnabled
      allowsInlineMediaPlayback
      allowsFullscreenVideo
      mediaPlaybackRequiresUserAction={false}
      androidLayerType="hardware"
      injectedJavaScriptBeforeContentLoaded={INJECTED_JS}
      onShouldStartLoadWithRequest={onShouldStartLoadWithRequest}
      onMessage={onMessage}
    />
  );
}

// ─── Styles ──────────────────────────────────────────────────────────────────

const styles = StyleSheet.create({
  webview: { flex: 1 },
});

// ─── Token requester registry ─────────────────────────────────────────────────
//
// Allows the player screen to trigger a WebView token fetch without a shared
// navigation prop.  Only one ExploreScreen exists at a time.

let _tokenRequester: ((chapterId: string) => void) | null = null;

function _setTokenRequester(fn: ((chapterId: string) => void) | null): void {
  _tokenRequester = fn;
}

// ─── Auth JWT store ───────────────────────────────────────────────────────────
//
// The injected JS sends the user's auth JWT via AUTH_JWT message while the
// WebView is in the foreground.  Native stores it here so the player can call
// getMuxToken directly (with Authorization header) when the WebView is
// backgrounded and postMessage is suppressed by Android.

let _authJwt: string | null = null;

function _storeAuthJwt(jwt: string): void {
  _authJwt = jwt;
}

export function getAuthJwt(): string | null {
  return _authJwt;
}

/**
 * Called by the player screen when it needs fresh tokens from the WebView.
 * Returns true if the request was dispatched, false if ExploreScreen is not
 * currently mounted.
 */
export function requestWebViewTokens(chapterId: string): boolean {
  console.log(`[explore] requestWebViewTokens: _tokenRequester=${_tokenRequester !== null ? 'SET' : 'NULL'}`);
  if (_tokenRequester) {
    _tokenRequester(chapterId);
    return true;
  }
  console.warn('[explore] requestWebViewTokens: ExploreScreen not mounted — returning false');
  return false;
}
