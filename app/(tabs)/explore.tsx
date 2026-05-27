import { useRouter, type Href } from 'expo-router';
import { useCallback, useEffect, useRef, useState } from 'react';
import {
  ActivityIndicator,
  Alert,
  Pressable,
  StyleSheet,
  Text,
  View,
} from 'react-native';
import { WebView, type WebViewMessageEvent } from 'react-native-webview';
import type { ShouldStartLoadRequest } from 'react-native-webview/lib/WebViewTypes';
import {
  fetchChapter,
  getMuxToken,
  selectMuxPlaybackId,
} from '../../api/base44Client';
import IcareOfflineDrm, {
  onDownloadProgress,
  type DownloadInfo,
} from '../../modules/icare-offline-drm';

const BASE44_URL = 'https://icare-life-learn.base44.app';

/**
 * URL patterns that mean "a chapter player is open".
 * Used both in onShouldStartLoadWithRequest (hard nav) and in the injected JS
 * (SPA client-side routing via pushState / replaceState).
 *
 * Base44 chapter player URL shapes we handle:
 *   /chapter/:id
 *   /student/chapter/:id
 *   /chapter-player?id=:id  (or &id=)
 *   /ChapterPlayer?id=:id
 *   #/chapter/:id  (hash router variant)
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
 * Does two things:
 *  1. Installs window.icareNative.openChapter(id) so the Base44 web app can
 *     explicitly request native playback by calling that function.
 *  2. Monitors SPA client-side navigation (pushState / replaceState / popstate /
 *     hashchange) and posts CHAPTER_PLAYER_OPENED / CHAPTER_PLAYER_CLOSED
 *     messages so the native layer can show or hide the download overlay.
 */
const INJECTED_JS = `
  (function() {
    if (window.__icareNativeBridgeInstalled) return;
    window.__icareNativeBridgeInstalled = true;

    // ── Explicit bridge: web app calls this to hand off to native player ──────
    window.icareNative = {
      openChapter: function(id) {
        window.ReactNativeWebView && window.ReactNativeWebView.postMessage(
          JSON.stringify({ type: 'OPEN_CHAPTER', chapterId: id })
        );
      }
    };

    // ── SPA navigation monitoring ─────────────────────────────────────────────
    function getChapterIdFromUrl(url) {
      var patterns = [
        /\\/chapter\\/([A-Za-z0-9_-]{8,})/,
        /\\/student\\/chapter\\/([A-Za-z0-9_-]{8,})/,
        /[\\/#]chapter-player[\\/?](?:.*[?&])?id=([A-Za-z0-9_-]{8,})/i,
        /[\\/#]ChapterPlayer[\\/?](?:.*[?&])?id=([A-Za-z0-9_-]{8,})/i,
        /\\/ChapterPlayer\\?(?:.*&)?id=([A-Za-z0-9_-]{8,})/,
        /\\/chapter-player\\?(?:.*&)?id=([A-Za-z0-9_-]{8,})/,
      ];
      for (var i = 0; i < patterns.length; i++) {
        var m = url.match(patterns[i]);
        if (m) return m[1];
      }
      return null;
    }

    var _lastChapterId = null;

    function checkUrl() {
      var fullUrl = window.location.href;
      var chapterId = getChapterIdFromUrl(fullUrl);
      if (chapterId === _lastChapterId) return; // no change
      _lastChapterId = chapterId;
      window.ReactNativeWebView && window.ReactNativeWebView.postMessage(
        JSON.stringify(
          chapterId
            ? { type: 'CHAPTER_PLAYER_OPENED', chapterId: chapterId }
            : { type: 'CHAPTER_PLAYER_CLOSED' }
        )
      );
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
    window.addEventListener('popstate', function() { setTimeout(checkUrl, 150); });
    window.addEventListener('hashchange', function() { setTimeout(checkUrl, 150); });

    // Initial check after page is interactive
    setTimeout(checkUrl, 800);
    true;
  })();
`;

export default function ExploreScreen() {
  const router = useRouter();
  const webRef = useRef<WebView>(null);

  // Chapter currently open in the web player (null = not on a chapter player page)
  const [currentChapterId, setCurrentChapterId] = useState<string | null>(null);
  const [download, setDownload] = useState<DownloadInfo | null>(null);

  // Subscribe to download progress events for the visible chapter
  useEffect(() => {
    if (!currentChapterId) {
      setDownload(null);
      return;
    }
    // Check for an existing download record
    IcareOfflineDrm.getDownload(currentChapterId).then((d) => {
      setDownload(d ?? null);
    });
    // Listen for live progress updates
    const sub = onDownloadProgress((evt) => {
      if (evt.id === currentChapterId) setDownload(evt);
    });
    return () => sub.remove();
  }, [currentChapterId]);

  // ── Download action ─────────────────────────────────────────────────────────
  const handleDownload = useCallback(async () => {
    if (!currentChapterId) return;
    try {
      const ch = await fetchChapter(currentChapterId);
      if (ch.status !== 200) throw new Error(`Chapter fetch failed (${ch.status})`);
      const playbackId = selectMuxPlaybackId(ch.data);
      if (!playbackId) {
        Alert.alert('Download unavailable', 'This chapter has no video to download.');
        return;
      }
      const tk = await getMuxToken(playbackId);
      await IcareOfflineDrm.startDownload({
        id: currentChapterId,
        manifestUrl: tk.secureStreamUrl,
        drmLicenseUrl: tk.drmLicenseUrl,
        drmToken: tk.drmToken,
        title: ch.data.title,
      });
    } catch (err: any) {
      Alert.alert('Download failed', err?.message ?? String(err));
    }
  }, [currentChapterId]);

  const handleDeleteDownload = useCallback(async () => {
    if (!currentChapterId) return;
    await IcareOfflineDrm.removeDownload(currentChapterId);
    setDownload(null);
  }, [currentChapterId]);

  // ── WebView callbacks ───────────────────────────────────────────────────────

  /**
   * Hard navigations only (page reloads, external links).
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
        switch (msg?.type) {
          case 'OPEN_CHAPTER':
            // Explicit bridge call → open native player
            if (typeof msg.chapterId === 'string') {
              router.push({
                pathname: '/player/[chapterId]',
                params: { chapterId: msg.chapterId },
              } as unknown as Href);
            }
            break;
          case 'CHAPTER_PLAYER_OPENED':
            if (typeof msg.chapterId === 'string') {
              setCurrentChapterId(msg.chapterId);
            }
            break;
          case 'CHAPTER_PLAYER_CLOSED':
            setCurrentChapterId(null);
            break;
        }
      } catch {
        // Non-JSON WebView messages are ignored
      }
    },
    [router]
  );

  return (
    <View style={styles.container}>
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

      {/* Floating download overlay — only visible when a chapter player is open */}
      {currentChapterId ? (
        <DownloadOverlay
          download={download}
          onDownload={handleDownload}
          onDelete={handleDeleteDownload}
        />
      ) : null}
    </View>
  );
}

// ── Download overlay ──────────────────────────────────────────────────────────

function DownloadOverlay({
  download,
  onDownload,
  onDelete,
}: {
  download: DownloadInfo | null;
  onDownload: () => void;
  onDelete: () => void;
}) {
  if (download?.state === 'completed') {
    return (
      <View style={styles.overlay}>
        <Text style={styles.overlayText}>✓ Downloaded</Text>
        <Pressable
          style={[styles.overlayBtn, styles.overlayBtnDanger]}
          onPress={onDelete}
        >
          <Text style={styles.overlayBtnText}>Remove</Text>
        </Pressable>
      </View>
    );
  }

  if (download?.state === 'downloading' || download?.state === 'queued') {
    const pct =
      download.percentDownloaded >= 0
        ? `${Math.round(download.percentDownloaded)}%`
        : '';
    return (
      <View style={styles.overlay}>
        <ActivityIndicator size="small" color="#fff" />
        <Text style={styles.overlayText}>Downloading {pct}</Text>
      </View>
    );
  }

  if (download?.state === 'failed') {
    return (
      <View style={styles.overlay}>
        <Pressable style={styles.overlayBtn} onPress={onDownload}>
          <Text style={styles.overlayBtnText}>↻ Retry download</Text>
        </Pressable>
      </View>
    );
  }

  // Default: not yet downloaded
  return (
    <View style={styles.overlay}>
      <Pressable style={styles.overlayBtn} onPress={onDownload}>
        <Text style={styles.overlayBtnText}>↓ Download for offline</Text>
      </Pressable>
    </View>
  );
}

const styles = StyleSheet.create({
  container: { flex: 1 },
  webview: { flex: 1 },

  // Floating pill anchored above the bottom tab bar
  overlay: {
    position: 'absolute',
    bottom: 88,
    right: 16,
    flexDirection: 'row',
    alignItems: 'center',
    gap: 8,
    backgroundColor: 'rgba(0,0,0,0.80)',
    borderRadius: 24,
    paddingHorizontal: 14,
    paddingVertical: 10,
    elevation: 8,
    shadowColor: '#000',
    shadowOffset: { width: 0, height: 2 },
    shadowOpacity: 0.35,
    shadowRadius: 6,
  },
  overlayText: {
    color: '#fff',
    fontSize: 13,
    fontWeight: '600',
  },
  overlayBtn: {
    backgroundColor: '#1D3D47',
    paddingHorizontal: 12,
    paddingVertical: 8,
    borderRadius: 16,
  },
  overlayBtnDanger: {
    backgroundColor: '#a33b3b',
  },
  overlayBtnText: {
    color: '#fff',
    fontSize: 13,
    fontWeight: '600',
  },
});
