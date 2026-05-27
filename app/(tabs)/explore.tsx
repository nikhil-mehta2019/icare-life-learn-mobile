import { useRouter, type Href } from 'expo-router';
import { useCallback, useRef } from 'react';
import { StyleSheet } from 'react-native';
import { WebView, type WebViewMessageEvent } from 'react-native-webview';
import type { ShouldStartLoadRequest } from 'react-native-webview/lib/WebViewTypes';

const BASE44_URL = 'https://icare-life-learn.base44.app';

/**
 * Actual Base44 chapter player URL (confirmed from live app inspection):
 *
 *   /chapter/{courseId}/{chapterId}
 *
 * The chapterId is the SECOND path segment — that is what we must capture
 * and pass to the native player.  Previous patterns matched the first segment
 * (courseId) by mistake.
 *
 * Additional fallback patterns are kept in case the web app ever uses
 * alternative routes for deep-links or direct entry.
 */
const CHAPTER_PATH_PATTERNS: RegExp[] = [
  // PRIMARY: /chapter/{courseId}/{chapterId}  — capture second segment
  /\/chapter\/[A-Za-z0-9_-]{8,}\/([A-Za-z0-9_-]{8,})\b/,
  // Fallbacks
  /\/student\/chapter\/[A-Za-z0-9_-]{8,}\/([A-Za-z0-9_-]{8,})\b/,
  /[/#]chapter-player[/?](?:.*[?&])?id=([A-Za-z0-9_-]{8,})/i,
  /[/#]ChapterPlayer[/?](?:.*[?&])?id=([A-Za-z0-9_-]{8,})/i,
  /\/ChapterPlayer\?(?:.*&)?id=([A-Za-z0-9_-]{8,})/,
  /\/chapter-player\?(?:.*&)?id=([A-Za-z0-9_-]{8,})/,
];

function extractChapterId(url: string): string | null {
  for (const re of CHAPTER_PATH_PATTERNS) {
    const m = url.match(re);
    if (m) return m[1];
  }
  return null;
}

/**
 * Injected into the WebView before content loads.
 *
 * 1. Installs window.icareNative.openChapter(id) so the Base44 web app can
 *    explicitly request native playback.
 *
 * 2. Monitors SPA client-side navigation (pushState / replaceState /
 *    popstate / hashchange).  When the URL matches the chapter player pattern
 *    the chapterId is extracted and posted to the native layer, which opens
 *    the full native player (DRM, pinch-zoom, offline download, etc.).
 *    The WebView also steps back via history.back() so the user returns to
 *    the chapter list when they press Back in the native player.
 */
const INJECTED_JS = `
  (function() {
    if (window.__icareNativeBridgeInstalled) return;
    window.__icareNativeBridgeInstalled = true;

    // ── 1. Explicit bridge ────────────────────────────────────────────────────
    window.icareNative = {
      openChapter: function(id) {
        window.ReactNativeWebView && window.ReactNativeWebView.postMessage(
          JSON.stringify({ type: 'OPEN_CHAPTER', chapterId: id })
        );
      }
    };

    // ── 2. SPA navigation monitoring ─────────────────────────────────────────
    function getChapterIdFromUrl(url) {
      // PRIMARY: /chapter/{courseId}/{chapterId} — capture SECOND segment
      var primary = url.match(/\\/chapter\\/[A-Za-z0-9_-]{8,}\\/([A-Za-z0-9_-]{8,})(?:\\/|\\?|$)/);
      if (primary) return primary[1];
      // Fallbacks
      var patterns = [
        /\\/student\\/chapter\\/[A-Za-z0-9_-]{8,}\\/([A-Za-z0-9_-]{8,})/,
        /[\\/#]chapter-player[\\/?](?:.*[?&])?id=([A-Za-z0-9_-]{8,})/i,
        /[\\/#]ChapterPlayer[\\/?](?:.*[?&])?id=([A-Za-z0-9_-]{8,})/i,
        /\\/ChapterPlayer\\?(?:.*&)?id=([A-Za-z0-9_-]{8,})/,
        /\\/chapter-player\\?(?:.*&)?id=([A-Za-z0-9_-]{8,})/
      ];
      for (var i = 0; i < patterns.length; i++) {
        var m = url.match(patterns[i]);
        if (m) return m[1];
      }
      return null;
    }

    var _lastFiredId = null;

    function checkUrl() {
      var chapterId = getChapterIdFromUrl(window.location.href);
      if (!chapterId || chapterId === _lastFiredId) return;
      _lastFiredId = chapterId;

      // Tell native layer to open the player
      window.ReactNativeWebView && window.ReactNativeWebView.postMessage(
        JSON.stringify({ type: 'OPEN_CHAPTER', chapterId: chapterId })
      );

      // Step the WebView back so the user returns to the chapter list
      // (not the web player page) when pressing Back in the native player.
      setTimeout(function() {
        if (typeof history.back === 'function') history.back();
        setTimeout(function() { _lastFiredId = null; }, 1500);
      }, 250);
    }

    // Patch history API
    var _pushState = history.pushState;
    history.pushState = function() {
      _pushState.apply(this, arguments);
      setTimeout(checkUrl, 150);
    };
    var _replaceState = history.replaceState;
    history.replaceState = function() {
      _replaceState.apply(this, arguments);
      setTimeout(checkUrl, 150);
    };
    window.addEventListener('popstate',   function() { setTimeout(checkUrl, 150); });
    window.addEventListener('hashchange', function() { setTimeout(checkUrl, 150); });

    // Initial check after page paint
    setTimeout(checkUrl, 800);
    true;
  })();
`;

export default function ExploreScreen() {
  const router = useRouter();
  const webRef = useRef<WebView>(null);

  /** Hard navigations (initial load, external links). */
  const onShouldStartLoadWithRequest = useCallback(
    (req: ShouldStartLoadRequest) => {
      const id = extractChapterId(req.url);
      if (id) {
        router.push({
          pathname: '/player/[chapterId]',
          params: { chapterId: id },
        } as unknown as Href);
        return false;
      }
      return true;
    },
    [router]
  );

  const onMessage = useCallback(
    (e: WebViewMessageEvent) => {
      try {
        const msg = JSON.parse(e.nativeEvent.data);
        if (msg?.type === 'OPEN_CHAPTER' && typeof msg.chapterId === 'string') {
          router.push({
            pathname: '/player/[chapterId]',
            params: { chapterId: msg.chapterId },
          } as unknown as Href);
        }
      } catch {
        // Non-JSON WebView messages are silently ignored
      }
    },
    [router]
  );

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

const styles = StyleSheet.create({
  webview: { flex: 1 },
});
