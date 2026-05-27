import { useRouter, type Href } from 'expo-router';
import { useCallback, useRef } from 'react';
import { StyleSheet } from 'react-native';
import { WebView, type WebViewMessageEvent } from 'react-native-webview';
import type { ShouldStartLoadRequest } from 'react-native-webview/lib/WebViewTypes';
import { deliverPlayerData } from '../../api/playerCache';

const BASE44_URL = 'https://icare-life-learn.base44.app';

const CHAPTER_PATH_PATTERNS: RegExp[] = [
  /\/chapter\/[A-Za-z0-9_-]{8,}\/([A-Za-z0-9_-]{8,})\b/,
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

const INJECTED_JS = [
  '(function() {',
  '  if (window.__icareNativeBridgeInstalled) return;',
  '  window.__icareNativeBridgeInstalled = true;',
  "  var _API_KEY  = '6af260f41e2140b9950788621360c5cf';",
  "  var _BASE_API = 'https://icare-life-learn.base44.app/api';",
  '  window.icareNative = { openChapter: function(id) {',
  '    window.ReactNativeWebView && window.ReactNativeWebView.postMessage(',
  "      JSON.stringify({ type: 'OPEN_CHAPTER', chapterId: id }));",
  '  } };',
  '  async function fetchAndPostTokens(chapterId) {',
  '    try {',
  "      var hdrs = { 'Content-Type': 'application/json', 'api_key': _API_KEY };",
  "      var chRes = await fetch(_BASE_API + '/entities/Chapter/' + chapterId,",
  "        { headers: hdrs, credentials: 'include' });",
  "      if (!chRes.ok) throw new Error('Chapter fetch failed (' + chRes.status + ')');",
  '      var chapter = await chRes.json();',
  '      var playbackId = (chapter.muxDrmProtected && chapter.muxDrmPlaybackId)',
  '        ? chapter.muxDrmPlaybackId',
  '        : (chapter.muxSignedPlaybackRequired && chapter.muxSignedPlaybackId)',
  '        ? chapter.muxSignedPlaybackId : (chapter.muxPlaybackId || null);',
  "      if (!playbackId) throw new Error('Chapter has no Mux playback ID');",
  "      var tkRes = await fetch(_BASE_API + '/functions/getMuxToken', {",
  "        method: 'POST', headers: hdrs, credentials: 'include',",
  '        body: JSON.stringify({ playbackId: playbackId }) });',
  '      if (!tkRes.ok) {',
  '        var eb = {}; try { eb = await tkRes.json(); } catch(x) {}',
  "        throw new Error(eb.error || ('getMuxToken failed (' + tkRes.status + ')'));",
  '      }',
  '      var tokens = await tkRes.json();',
  '      window.ReactNativeWebView && window.ReactNativeWebView.postMessage(',
  "        JSON.stringify({ type: 'CHAPTER_TOKENS', chapterId: chapterId,",
  '          chapter: chapter, tokens: tokens }));',
  '    } catch(err) {',
  '      window.ReactNativeWebView && window.ReactNativeWebView.postMessage(',
  "        JSON.stringify({ type: 'CHAPTER_ERROR', chapterId: chapterId,",
  '          error: String(err) }));',
  '    }',
  '  }',
  '  function getChapterIdFromUrl(url) {',
  '    var p = url.match(/\\/chapter\\/[A-Za-z0-9_-]{8,}\\/([A-Za-z0-9_-]{8,})(?:\\/|\\?|$)/);',
  '    if (p) return p[1];',
  '    var pats = [',
  '      /\\/student\\/chapter\\/[A-Za-z0-9_-]{8,}\\/([A-Za-z0-9_-]{8,})/',
  '      ,/[\\/#]chapter-player[\\/?](?:.*[?&])?id=([A-Za-z0-9_-]{8,})/i',
  '      ,/[\\/#]ChapterPlayer[\\/?](?:.*[?&])?id=([A-Za-z0-9_-]{8,})/i',
  '      ,/\\/ChapterPlayer\\?(?:.*&)?id=([A-Za-z0-9_-]{8,})/',
  '      ,/\\/chapter-player\\?(?:.*&)?id=([A-Za-z0-9_-]{8,})/',
  '    ];',
  '    for (var i = 0; i < pats.length; i++) {',
  '      var m = url.match(pats[i]); if (m) return m[1];',
  '    }',
  '    return null;',
  '  }',
  '  var _lastFiredId = null;',
  '  function checkUrl() {',
  '    var chapterId = getChapterIdFromUrl(window.location.href);',
  '    if (!chapterId || chapterId === _lastFiredId) return;',
  '    _lastFiredId = chapterId;',
  '    window.ReactNativeWebView && window.ReactNativeWebView.postMessage(',
  "      JSON.stringify({ type: 'OPEN_CHAPTER', chapterId: chapterId }));",
  '    fetchAndPostTokens(chapterId);',
  '    setTimeout(function() {',
  "      if (typeof history.back === 'function') history.back();",
  '      setTimeout(function() { _lastFiredId = null; }, 1500);',
  '    }, 250);',
  '  }',
  '  var _ps = history.pushState;',
  '  history.pushState = function() { _ps.apply(this,arguments); setTimeout(checkUrl,150); };',
  '  var _rs = history.replaceState;',
  '  history.replaceState = function() { _rs.apply(this,arguments); setTimeout(checkUrl,150); };',
  "  window.addEventListener('popstate',   function() { setTimeout(checkUrl,150); });",
  "  window.addEventListener('hashchange', function() { setTimeout(checkUrl,150); });",
  '  setTimeout(checkUrl, 800);',
  '  true;',
  '})();',
].join('\n');

export default function ExploreScreen() {
  const router = useRouter();
  const webRef = useRef<WebView>(null);

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
        } else if (msg?.type === 'CHAPTER_TOKENS' && typeof msg.chapterId === 'string') {
          deliverPlayerData(msg.chapterId, { chapter: msg.chapter, tokens: msg.tokens });
        } else if (msg?.type === 'CHAPTER_ERROR' && typeof msg.chapterId === 'string') {
          deliverPlayerData(msg.chapterId, null);
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
