import { useRouter, type Href } from 'expo-router';
import { useCallback, useRef } from 'react';
import { StyleSheet } from 'react-native';
import { WebView, type WebViewMessageEvent } from 'react-native-webview';
import type { ShouldStartLoadRequest } from 'react-native-webview/lib/WebViewTypes';

const BASE44_URL = 'https://icare-life-learn.base44.app';

/**
 * URL patterns that mean "open this chapter in the native player".
 * Adjust these to match the routes the Base44 web app actually uses for the
 * student chapter player. We intentionally accept several common shapes.
 *
 *  - /chapter/:id
 *  - /student/chapter/:id
 *  - /chapter-player?id=:id   (Base44 default page-name → URL)
 *  - /ChapterPlayer?id=:id
 */
const CHAPTER_PATH_PATTERNS: RegExp[] = [
  /\/chapter\/([A-Za-z0-9_-]{8,})\b/,
  /\/student\/chapter\/([A-Za-z0-9_-]{8,})\b/,
  /\/chapter-player\?(?:.*&)?id=([A-Za-z0-9_-]{8,})/,
  /\/ChapterPlayer\?(?:.*&)?id=([A-Za-z0-9_-]{8,})/,
];

function extractChapterId(url: string): string | null {
  for (const re of CHAPTER_PATH_PATTERNS) {
    const m = url.match(re);
    if (m) return m[1];
  }
  return null;
}

/**
 * Optional JS bridge: injected into the WebView so the Base44 web app can
 * explicitly request native playback. Web side calls
 *   window.ReactNativeWebView.postMessage(JSON.stringify({type:'OPEN_CHAPTER', chapterId}))
 */
const INJECTED_JS = `
  (function() {
    if (window.__icareNativeBridgeInstalled) return;
    window.__icareNativeBridgeInstalled = true;
    window.icareNative = {
      openChapter: function(id) {
        window.ReactNativeWebView && window.ReactNativeWebView.postMessage(
          JSON.stringify({ type: 'OPEN_CHAPTER', chapterId: id })
        );
      }
    };
    true;
  })();
`;

export default function ExploreScreen() {
  const router = useRouter();
  const webRef = useRef<WebView>(null);

  const onShouldStartLoadWithRequest = useCallback(
    (req: ShouldStartLoadRequest) => {
      const id = extractChapterId(req.url);
      if (id) {
        router.push({ pathname: '/player/[chapterId]', params: { chapterId: id } } as unknown as Href);
        return false; // cancel WebView nav
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
          router.push({ pathname: '/player/[chapterId]', params: { chapterId: msg.chapterId } } as unknown as Href);
        }
      } catch {
        // Non-JSON messages are ignored — WebView posts other things too.
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
