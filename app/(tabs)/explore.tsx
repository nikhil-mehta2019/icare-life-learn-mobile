import { useRouter, type Href } from 'expo-router';
import { useCallback, useEffect, useRef, useState } from 'react';
import { Platform, Pressable, StyleSheet, Text, View } from 'react-native';
import { Ionicons } from '@expo/vector-icons';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { WebView, type WebViewMessageEvent } from 'react-native-webview';
import type { ShouldStartLoadRequest } from 'react-native-webview/lib/WebViewTypes';
import { deliverPlayerData } from '../../api/playerCache';
import IcareOfflineDrm, { onDownloadProgress } from '../../modules/icare-offline-drm';

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
  // iOS only: Base44 keeps the session as a bearer token in localStorage (not a cookie).
  ...(Platform.OS === 'ios'
    ? [
        "      try {",
        "        var _tk = window.localStorage.getItem('base44_access_token') || window.localStorage.getItem('token');",
        "        if (_tk) hdrs['Authorization'] = 'Bearer ' + _tk;",
        "      } catch (_e) {}",
      ]
    : []),
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
  // iOS only: getMuxToken also requires courseId and chapterId.
  Platform.OS === 'ios'
    ? '        body: JSON.stringify({ playbackId: playbackId, courseId: chapter.courseId, chapterId: chapter.id || chapterId }) });'
    : '        body: JSON.stringify({ playbackId: playbackId }) });',
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

/**
 * iOS only: floating entry to the native Downloads list (the web UI has no
 * Downloads page). Shows a badge with the number of downloads in progress and
 * stays usable even when the WebView cannot load (offline).
 */
function IosDownloadsButton({ onPress }: { onPress: () => void }) {
  const insets = useSafeAreaInsets();
  const [active, setActive] = useState(0);

  useEffect(() => {
    let alive = true;
    const states = new Map<string, string>();
    const recount = () => {
      let n = 0;
      states.forEach((s) => { if (s === 'queued' || s === 'downloading') n += 1; });
      if (alive) setActive(n);
    };
    IcareOfflineDrm.listDownloads()
      .then((list) => { list.forEach((d) => states.set(d.id, d.state)); recount(); })
      .catch(() => {});
    const sub = onDownloadProgress((e) => {
      if (e.state === 'removing') states.delete(e.id); else states.set(e.id, e.state);
      recount();
    });
    return () => { alive = false; sub.remove(); };
  }, []);

  return (
    <Pressable
      accessibilityRole="button"
      accessibilityLabel="Downloads"
      onPress={onPress}
      style={[styles.fab, { bottom: insets.bottom + 96 }]}>
      <Ionicons name="download-outline" size={22} color="#fff" />
      {active > 0 && (
        <View style={styles.fabBadge}>
          <Text style={styles.fabBadgeText}>{active}</Text>
        </View>
      )}
    </Pressable>
  );
}

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
          deliverPlayerData(
            msg.chapterId,
            null,
            Platform.OS === 'ios' && typeof msg.error === 'string' ? msg.error : undefined
          );
        }
      } catch {
        // Non-JSON WebView messages are silently ignored
      }
    },
    [router]
  );

  const web = (
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

  if (Platform.OS !== 'ios') return web;

  return (
    <View style={styles.webview}>
      {web}
      <IosDownloadsButton
        onPress={() => router.navigate('/(tabs)/downloads' as unknown as Href)}
      />
    </View>
  );
}

const styles = StyleSheet.create({
  webview: { flex: 1 },
  fab: {
    position: 'absolute',
    right: 14,
    width: 46,
    height: 46,
    borderRadius: 23,
    backgroundColor: '#7a45a8',
    alignItems: 'center',
    justifyContent: 'center',
    shadowColor: '#000',
    shadowOffset: { width: 0, height: 2 },
    shadowOpacity: 0.35,
    shadowRadius: 4,
  },
  fabBadge: {
    position: 'absolute',
    top: -4,
    right: -4,
    minWidth: 18,
    height: 18,
    borderRadius: 9,
    paddingHorizontal: 4,
    backgroundColor: '#e5484d',
    alignItems: 'center',
    justifyContent: 'center',
  },
  fabBadgeText: { color: '#fff', fontSize: 11, fontWeight: '700' },
});
