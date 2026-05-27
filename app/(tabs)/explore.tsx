import { useRouter, type Href } from 'expo-router';
import { useCallback, useRef } from 'react';
import { StyleSheet } from 'react-native';
import { WebView, type WebViewMessageEvent } from 'react-native-webview';
import type { ShouldStartLoadRequest } from 'react-native-webview/lib/WebViewTypes';

const BASE44_URL = 'https://icare-life-learn.base44.app';

/**
 * URL patterns that identify a chapter player page.
 *
 * Used in two places:
 *  1. onShouldStartLoadWithRequest  — for hard navigations (page reloads, links)
 *  2. Injected JS                   — for SPA client-side routing (pushState etc.)
 *
 * Base44 chapter player URL shapes we handle:
 *   /chapter/:id
 *   /student/chapter/:id
 *   /chapter-player?id=:id   (Base44 default page-name → URL)
 *   /ChapterPlayer?id=:id
 *   #/chapter/:id            (hash-router variant)
 *   #/ChapterPlayer?id=:id
 */
const CHAPTER_PATH_PATTERNS: RegExp[] = [
  /\/chapter\/([A-Za-z0-9_-]{8,})\b/,
  /\/student\/chapter\/([A-Za-z0-9_-]{8,})\b/,
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
 * Two responsibilities:
 *
 *  1. window.icareNative.openChapter(id)
 *     Explicit bridge: the Base44 web app can call this to hand off to the
 *     native player directly (no URL matching required).
 *
 *  2. SPA navigation monitoring
 *     Patches history.pushState / replaceState and listens for popstate /
 *     hashchange so we are notified of every client-side URL change.
 *     When the new URL matches a chapter-player pattern we post
 *     { type: 'OPEN_CHAPTER', chapterId } to the native layer, which then
 *     opens the full native player (pinch-zoom, DRM, offline download, etc.)
 *     and simultaneously navigates the WebView back one step so the user
 *     returns to the chapter list when they press Back in the native player.
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
      var patterns = [
        /\\/chapter\\/([A-Za-z0-9_-]{8,})/,
        /\\/student\\/chapter\\/([A-Za-z0-9_-]{8,})/,
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

      // Post to native layer — native will open the player screen
      window.ReactNativeWebView && window.ReactNativeWebView.postMessage(
        JSON.stringify({ type: 'OPEN_CHAPTER', chapterId: chapterId })
      );

      // Navigate the WebView back so that when the user returns from the
      // native player they land on the chapter list, not the web player page.
      // Small delay lets the SPA finish its render cycle first.
      setTimeout(function() {
        if (typeof history.back === 'function') history.back();
        // Reset so the same chapter can be re-opened later
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

    // Check once after initial page paint
    setTimeout(checkUrl, 800);
    true;
  })();
`;

export default function ExploreScreen() {
  const router = useRouter();
  const webRef = useRef<WebView>(null);

  /**
   * Hard navigations only (initial load, external links, redirects).
   * SPA routing is handled via the injected JS + onMessage.
   */
  const onShouldStartLoadWithRequest = useCallback(
    (req: ShouldStartLoadRequest) => {
      const id = extractChapterId(req.url);
      if (id) {
        router.push({
          pathname: '/player/[chapterId]',
          params: { chapterId: id },
        } as unknown as Href);
        return false; // cancel WebView navigation
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
