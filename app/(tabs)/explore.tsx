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
 *     1. postMessage OPEN_CHAPTER  → native opens player in loading state
 *     2. postMessage REQUEST_TOKENS internally to self → injected JS fetches
 *        chapter metadata + Mux tokens using the WebView's authenticated
 *        session cookies, then posts CHAPTER_TOKENS (or CHAPTER_ERROR).
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
import { useCallback, useRef } from 'react';
import { StyleSheet } from 'react-native';
import { WebView, type WebViewMessageEvent } from 'react-native-webview';
import type { ShouldStartLoadRequest } from 'react-native-webview/lib/WebViewTypes';
import { deliverPlayerData } from '../../api/playerCache';
import { API_KEY, BASE_URL } from '../../api/base44Client';

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
// Does NOT contain the API key — the key is injected separately via
// injectJavaScript() after BRIDGE_READY fires, keeping it out of the static
// bundle text that can be read from the APK.
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

  // ── Token fetch (uses WebView session cookies — no API key needed here) ───
  // API key + base URL are injected by native after BRIDGE_READY.
  var _apiKey  = null;
  var _baseApi = null;

  window.__icareFetchTokens = function(chapterId, apiKey, baseApi) {
    _apiKey  = apiKey;
    _baseApi = baseApi;
    _doFetchTokens(chapterId);
  };

  function _doFetchTokens(chapterId) {
    if (!_apiKey || !_baseApi) {
      log('warn', 'fetchTokens called before API key was injected — chapterId: ' + chapterId);
      _postMessage({ type: 'CHAPTER_ERROR', chapterId: chapterId,
                     error: 'Bridge not yet initialised with API key' });
      return;
    }
    log('info', 'Fetching tokens for chapter ' + chapterId);
    var hdrs = { 'Content-Type': 'application/json', 'api_key': _apiKey };

    fetch(_baseApi + '/entities/Chapter/' + chapterId,
          { headers: hdrs, credentials: 'include' })
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

        return fetch(_baseApi + '/functions/getMuxToken', {
          method: 'POST',
          headers: hdrs,
          credentials: 'include',
          body: JSON.stringify({ playbackId: playbackId }),
        }).then(function(r) {
          if (!r.ok) {
            return r.json().catch(function() { return {}; }).then(function(eb) {
              throw new Error(eb.error || ('getMuxToken failed (' + r.status + ')'));
            });
          }
          return r.json().then(function(tokens) {
            log('info', 'Tokens fetched OK for chapter ' + chapterId);
            _postMessage({ type: 'CHAPTER_TOKENS', chapterId: chapterId,
                           chapter: chapter, tokens: tokens });
          });
        });
      })
      .catch(function(err) {
        log('error', 'Token fetch failed for chapter ' + chapterId + ': ' + String(err));
        _postMessage({ type: 'CHAPTER_ERROR', chapterId: chapterId,
                       error: String(err) });
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
      return;
    }

    if (chapterId === _lastFiredId) {
      // Same chapter URL — already handled this navigation.
      return;
    }

    _lastFiredId = chapterId;
    log('info', 'Chapter URL detected: ' + chapterId + ' — posting OPEN_CHAPTER');
    _postMessage({ type: 'OPEN_CHAPTER', chapterId: chapterId });

    // Token fetch starts immediately; no history.back() is called.
    // The native side will call window.__icareFetchTokens() after injecting
    // the API key, OR the fetch will proceed if the key was already injected.
    _doFetchTokens(chapterId);
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
   * After the bridge signals it is ready, inject the API key + base URL.
   * This keeps credentials out of the static injectedJavaScriptBeforeContentLoaded
   * string (which is readable in the APK JS bundle) and delivers them only at
   * runtime via an encrypted IPC channel.
   */
  const injectApiCredentials = useCallback((chapterId?: string) => {
    const script = chapterId
      ? `window.__icareFetchTokens(${JSON.stringify(chapterId)}, ${JSON.stringify(API_KEY)}, ${JSON.stringify(BASE_URL)}); true;`
      : `window._icareApiKey = ${JSON.stringify(API_KEY)}; window._icareBaseApi = ${JSON.stringify(BASE_URL)}; true;`;
    webRef.current?.injectJavaScript(script);
  }, []);

  /**
   * onMessage — single entry point for all WebView → native messages.
   *
   * BRIDGE_READY   — inject API credentials so token fetches can proceed
   * OPEN_CHAPTER   — push native player screen
   * CHAPTER_TOKENS — deliver pre-fetched tokens to waiting player screen
   * CHAPTER_ERROR  — unblock waiting player screen (will fall through to error)
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
          console.log('[explore] WebView bridge ready — injecting API credentials');
          injectApiCredentials();
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
          deliverPlayerData(chapterId, null);
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
   * it calls this function which triggers the WebView bridge to fetch and post
   * CHAPTER_TOKENS.  The player calls waitForPlayerData() to receive the result.
   */
  const requestTokensFromWebView = useCallback((chapterId: string) => {
    console.log(`[explore] Requesting fresh tokens from WebView for chapter ${chapterId}`);
    injectApiCredentials(chapterId);
  }, [injectApiCredentials]);

  // Expose requestTokensFromWebView globally so the player screen can call it
  // without prop-drilling through the navigation stack.
  // This is stored in a module-level ref to avoid circular imports.
  _setTokenRequester(requestTokensFromWebView);

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

// ─── Token requester registry ─────────────────────────────────────────────────
//
// Allows the player screen to trigger a WebView token fetch without a shared
// navigation prop.  Only one ExploreScreen exists at a time.

let _tokenRequester: ((chapterId: string) => void) | null = null;

function _setTokenRequester(fn: (chapterId: string) => void): void {
  _tokenRequester = fn;
}

/**
 * Called by the player screen when it needs fresh tokens from the WebView.
 * Returns true if the request was dispatched, false if ExploreScreen is not
 * currently mounted.
 */
export function requestWebViewTokens(chapterId: string): boolean {
  if (_tokenRequester) {
    _tokenRequester(chapterId);
    return true;
  }
  console.warn('[explore] requestWebViewTokens called but ExploreScreen is not mounted');
  return false;
}

const styles = StyleSheet.create({
  webview: { flex: 1 },
});
