/**
 * player/[chapterId].tsx — hook-order-v2
 *
 * Architecture: shell + child pattern to eliminate all hook-order violations.
 *
 * ─── Component tree ───────────────────────────────────────────────────────────
 *
 *  ChapterPlayerScreen  (shell / parent)
 *    • All React hooks unconditionally at the top of the function.
 *    • No hook is ever called after a return statement.
 *    • Handles: params, mode state, token loading, offline check, keep-awake.
 *    • Renders: <LoadingView />, <ErrorView />, or <VideoPlayer />.
 *
 *  VideoPlayer  (child — only mounts when source is ready)
 *    • Contains all video-specific hooks: refs, gesture, audio-toast state.
 *    • Hooks inside a child component are fine; they execute in a stable order
 *      for the lifetime of that child, independent of the parent's mode state.
 *
 *  DownloadControls  (pure-ish functional child, no hooks)
 *
 * ─── Loading sequence ─────────────────────────────────────────────────────────
 *
 *  1. Check for an existing offline copy + DRM licence → play offline.
 *  2. Wait for tokens pre-fetched by the WebView bridge (max 20 s).
 *     The WebView has the user's session cookies; React Native's fetch() does
 *     not share the cookie jar on Android, so all authenticated API calls are
 *     routed through the WebView.
 *  3. If the bridge times out or returns an error, show an error screen.
 *
 * ─── Token refresh (download / delete-download) ───────────────────────────────
 *
 *  Both actions request fresh tokens via requestWebViewTokens() + waitForPlayerData().
 *  This ensures the authenticated session cookie is always used.
 */

// Build fingerprint — fires when Metro loads this module into the JS bundle.
// Must appear in Logcat after installing the correct APK.
console.log('[build] iCare player hotfix commit active: hook-order-v2');

import { useIsFocused } from '@react-navigation/native';
import { activateKeepAwakeAsync, deactivateKeepAwake } from 'expo-keep-awake';
import { useLocalSearchParams, useRouter } from 'expo-router';
import { getItemAsync, setItemAsync } from 'expo-secure-store';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  ActivityIndicator,
  Alert,
  Animated,
  Platform,
  Pressable,
  StyleSheet,
  Text,
  UIManager,
  useWindowDimensions,
  View,
} from 'react-native';
import { Gesture, GestureDetector, GestureHandlerRootView } from 'react-native-gesture-handler';
import Video, { type DRMType, type ReactVideoSource, type VideoRef } from 'react-native-video';
import {
  fetchChapter,
  selectMuxPlaybackId,
  type Chapter,
  type MuxTokenResponse,
} from '../../api/base44Client';
import { waitForPlayerData, type BridgeResult } from '../../api/playerCache';
import { requestWebViewTokens } from '../(tabs)/explore';
import IcareOfflineDrm, {
  onDownloadProgress,
  type DownloadInfo,
  type OfflinePlaybackSource,
} from '../../modules/icare-offline-drm';

type Mode = 'loading' | 'online' | 'offline' | 'error' | 'webview-fallback';

// ─── Native video availability guard ─────────────────────────────────────────
//
// react-native-video 5.2.1 was built for the Old Architecture. On React Native
// 0.76+ with New Architecture / Bridgeless enabled (IS_NEW_ARCH=true), the old
// ViewManager registry (UIManager) is null, causing:
//   TypeError: Cannot read property 'getViewManagerConfig' of null
// at the moment <Video> is rendered.
//
// We detect this at module load time and cache the result so every render is
// zero-cost. On iOS this always returns true (not affected by the same bridge).
// On Android we guard defensively: if UIManager or its method is unavailable,
// native video is considered unsafe.

function isNativeVideoAvailable(): boolean {
  try {
    if (Platform.OS !== 'android') return true;
    if (!UIManager || typeof UIManager.getViewManagerConfig !== 'function') {
      return false;
    }
    const config =
      UIManager.getViewManagerConfig('RCTVideo') ??
      UIManager.getViewManagerConfig('Video');
    return !!config;
  } catch (e) {
    console.warn('[player] native video availability check failed', e);
    return false;
  }
}

// Evaluated once when the module loads — no per-render cost.
const NATIVE_VIDEO_AVAILABLE = isNativeVideoAvailable();
console.log(`[player] native video available: ${NATIVE_VIDEO_AVAILABLE} (platform: ${Platform.OS})`);

// ─── Keep-awake hook (module-level) ──────────────────────────────────────────
// Defined outside any component so it is always called unconditionally.
// Activates/deactivates the wake lock whenever shouldKeepAwake changes.
// Guarantees deactivation on unmount via the released-guard cleanup.

const CHAPTER_PLAYER_KEEP_AWAKE_TAG = 'icare-chapter-player';

function useChapterKeepAwake(shouldKeepAwake: boolean) {
  useEffect(() => {
    let released = false;
    async function apply() {
      try {
        if (shouldKeepAwake) {
          await activateKeepAwakeAsync(CHAPTER_PLAYER_KEEP_AWAKE_TAG);
        } else {
          await deactivateKeepAwake(CHAPTER_PLAYER_KEEP_AWAKE_TAG);
        }
      } catch (e) {
        console.warn('[player] keep-awake update failed', e);
      }
    }
    apply();
    return () => {
      if (!released) {
        released = true;
        deactivateKeepAwake(CHAPTER_PLAYER_KEEP_AWAKE_TAG).catch((e) => {
          console.warn('[player] keep-awake cleanup failed', e);
        });
      }
    };
  }, [shouldKeepAwake]);
}

// ─── VideoPlayer child component ──────────────────────────────────────────────
// All video-specific hooks live here. This component is only rendered when the
// parent shell has a ready source (mode === 'online' | 'offline'), so its own
// hooks always run in exactly the same order for its entire lifetime.
//
// Conditional rendering of child components is 100% valid — React's hook rules
// only apply within a SINGLE component's render path.

interface VideoPlayerProps {
  source: ReactVideoSource;
  drm: Record<string, any> | undefined;
  chapter: Chapter | null;
  mode: 'online' | 'offline';
  offline: OfflinePlaybackSource | null;
  download: DownloadInfo | null;
  chapterId: string;
  onDownload: () => void;
  onDelete: () => void;
}

function VideoPlayer({
  source,
  drm,
  chapter,
  mode,
  offline,
  download,
  chapterId,
  onDownload,
  onDelete,
}: VideoPlayerProps) {
  // ── hooks ── (all unconditional, no early returns in this component)
  const videoRef = useRef<VideoRef>(null);
  const { width } = useWindowDimensions();
  const [isFullscreen, setIsFullscreen] = useState(false);
  // Peak scale tracked across the pinch gesture — Android MediaController
  // intercepts touches so onEnd scale is often 1.0; track the max instead.
  const peakScale = useRef(1);
  const [audioToastVisible, setAudioToastVisible] = useState(false);
  const audioToastOpacity = useRef(new Animated.Value(0)).current;

  const handleVideoLoad = useCallback(
    async (data: any) => {
      // Re-activate in case the OS dropped the wake lock during initial load.
      activateKeepAwakeAsync(CHAPTER_PLAYER_KEEP_AWAKE_TAG);
      const tracks: any[] = data?.audioTracks ?? [];
      if (tracks.length <= 1) return;
      try {
        const seen = await getItemAsync('audio_lang_hint_shown');
        if (seen) return;
        await setItemAsync('audio_lang_hint_shown', '1');
      } catch {
        // SecureStore unavailable — show toast anyway
      }
      setAudioToastVisible(true);
      Animated.sequence([
        Animated.timing(audioToastOpacity, { toValue: 1, duration: 300, useNativeDriver: true }),
        Animated.delay(4000),
        Animated.timing(audioToastOpacity, { toValue: 0, duration: 400, useNativeDriver: true }),
      ]).start(() => setAudioToastVisible(false));
    },
    [audioToastOpacity],
  );

  // onPlaybackRateChange is the correct v5.2.1 callback for play/pause state.
  const handlePlaybackRateChange = useCallback(
    ({ playbackRate }: { playbackRate: number }) => {
      console.log(`[player] Playback rate: ${playbackRate}`);
    },
    [],
  );

  // ── pinch-to-fullscreen gesture ──
  // Track PEAK scale via onUpdate (not onEnd) because Android's MediaController
  // intercepts touch events and the final scale is often back near 1.0.
  // Gesture overlay sits ABOVE the Video so RNGH receives pinch events first.
  const pinchGesture = Gesture.Pinch()
    .runOnJS(true)
    .onStart(() => { peakScale.current = 1; })
    .onUpdate((e) => { if (e.scale > peakScale.current) peakScale.current = e.scale; })
    .onEnd(() => {
      const peak = peakScale.current;
      peakScale.current = 1;
      if (peak > 1.1 && !isFullscreen) {
        console.log(`[player] Pinch-out (peak ${peak.toFixed(2)}) — entering fullscreen`);
        setIsFullscreen(true);
        videoRef.current?.presentFullscreenPlayer();
      } else if (peak < 0.9 && isFullscreen) {
        console.log(`[player] Pinch-in (peak ${peak.toFixed(2)}) — exiting fullscreen`);
        setIsFullscreen(false);
        videoRef.current?.dismissFullscreenPlayer();
      }
    });

  const playerHeight = (width / 16) * 9;

  return (
    <GestureHandlerRootView style={styles.container}>
      <View style={[styles.playerWrap, { width, height: playerHeight }]}>
        <Video
          ref={videoRef}
          source={source}
          drm={drm as any}
          controls
          resizeMode="contain"
          onLoad={handleVideoLoad}
          onReadyForDisplay={() => {
            activateKeepAwakeAsync(CHAPTER_PLAYER_KEEP_AWAKE_TAG);
          }}
          onFullscreenPlayerWillPresent={() => {
            activateKeepAwakeAsync(CHAPTER_PLAYER_KEEP_AWAKE_TAG);
          }}
          onFullscreenPlayerDidPresent={() => {
            activateKeepAwakeAsync(CHAPTER_PLAYER_KEEP_AWAKE_TAG);
          }}
          onFullscreenPlayerWillDismiss={() => {
            activateKeepAwakeAsync(CHAPTER_PLAYER_KEEP_AWAKE_TAG);
          }}
          onFullscreenPlayerDidDismiss={() => {
            console.log('[player] Fullscreen dismissed');
            setIsFullscreen(false);
            activateKeepAwakeAsync(CHAPTER_PLAYER_KEEP_AWAKE_TAG);
          }}
          onPlaybackRateChange={handlePlaybackRateChange}
          onEnd={() => {
            console.log('[player] Playback ended');
          }}
          style={StyleSheet.absoluteFill}
          onError={(e: any) => {
            const detail = JSON.stringify(e?.error ?? e);
            console.error(`[player] Playback error for chapter ${chapterId}: ${detail}`);
            Alert.alert('Playback error', detail);
          }}
        />

        {/* Transparent overlay above Video so RNGH receives pinch events
            before the native MediaController can swallow them.
            pointerEvents="box-none" lets single taps pass through to controls. */}
        <GestureDetector gesture={pinchGesture}>
          <View
            style={[StyleSheet.absoluteFill, styles.pinchOverlay]}
            pointerEvents="box-none"
          />
        </GestureDetector>

        {audioToastVisible && (
          <Animated.View style={[styles.audioToast, { opacity: audioToastOpacity }]}>
            <Text style={styles.audioToastText}>
              Multiple audio languages available. Select your preferred language from player settings.
            </Text>
            <Pressable
              onPress={() => {
                audioToastOpacity.setValue(0);
                setAudioToastVisible(false);
              }}
            >
              <Text style={styles.audioToastDismiss}>✕</Text>
            </Pressable>
          </Animated.View>
        )}
      </View>

      <View style={styles.metaRow}>
        <Text style={styles.title} numberOfLines={2}>
          {chapter?.title ?? 'Lesson'}
        </Text>
        <Text style={styles.badge}>
          {mode === 'offline' ? 'Offline' : 'Streaming'}
        </Text>
      </View>

      <DownloadControls
        download={download}
        offline={!!offline}
        onDownload={onDownload}
        onDelete={onDelete}
      />
    </GestureHandlerRootView>
  );
}

// ─── ChapterPlayerScreen (shell / parent) ─────────────────────────────────────
//
// INVARIANT: every hook in this function is called on EVERY render.
//            No hook appears after any return statement.
//            All early returns (loading / error) are placed AFTER the last hook.

export default function ChapterPlayerScreen() {
  // ── params ── (hooks #1-3)
  const { chapterId } = useLocalSearchParams<{ chapterId: string }>();
  const router = useRouter();
  const isFocused = useIsFocused();

  // ── state ── (hooks #4-9)
  const [mode, setMode] = useState<Mode>('loading');
  const [errorMsg, setErrorMsg] = useState<string | null>(null);
  const [chapter, setChapter] = useState<Chapter | null>(null);
  const [tokens, setTokens] = useState<MuxTokenResponse | null>(null);
  const [offline, setOffline] = useState<OfflinePlaybackSource | null>(null);
  const [download, setDownload] = useState<DownloadInfo | null>(null);

  // ── initial load effect ── (hook #10)
  useEffect(() => {
    let cancelled = false;
    // cancelWait() clears our resolver from playerCache immediately on unmount,
    // preventing the 20 s timer from firing setState on an unmounted component.
    let cancelWait: (() => void) | null = null;

    (async () => {
      try {
        if (!chapterId) throw new Error('Missing chapterId');
        console.log(`[player] HOTFIX BUILD: hook-order-v2 active`, { chapterId });
        console.log(`[player] Mounting for chapter ${chapterId}`);

        // 1) Check for an existing offline copy + license.
        const off = await IcareOfflineDrm.getOfflineSource({ id: chapterId });
        if (cancelled) return;

        if (off) {
          console.log(`[player] Offline copy found for chapter ${chapterId}`);
          const ch = await fetchChapter(chapterId);
          if (cancelled) return;
          setChapter(ch.data);
          setOffline(off);
          setMode('offline');
          return;
        }

        // 2) Wait for tokens from the WebView bridge (authenticated).
        //    The WebView has the user's session cookie; native fetch() does not.
        console.log(`[player] No offline copy — requesting tokens from WebView bridge`);
        const handle = waitForPlayerData(chapterId);
        cancelWait = handle.cancel;

        const result: BridgeResult = await handle.promise;
        if (cancelled) return;
        cancelWait = null;

        if (result.ok) {
          console.log(
            `[player] Tokens received for chapter ${chapterId} — starting playback`,
          );
          setChapter(result.data.chapter);
          setTokens(result.data.tokens);
          if (!NATIVE_VIDEO_AVAILABLE) {
            // react-native-video 5.x is Old Architecture only; on RN 0.76+
            // with New Architecture / Bridgeless, rendering <Video> crashes.
            // Route to WebView fallback instead — user stays in Base44 player.
            console.log(
              '[player] native video unavailable on Android — using WebView fallback',
            );
            console.log('[player] android playback mode: webview-fallback');
            setMode('webview-fallback');
          } else {
            setMode('online');
          }
          return;
        }

        // 3) Bridge returned an error or timed out.
        //    Common values:
        //      "Timed out after 20s…" → bridge not firing
        //      "getMuxToken failed (401)" → session expired
        console.warn(`[player] Bridge error for chapter ${chapterId}: ${result.error}`);
        throw new Error(result.error);
      } catch (err: any) {
        if (cancelled) return;
        const msg = err?.message ?? String(err);
        console.error(`[player] Load error for chapter ${chapterId}: ${msg}`);
        setErrorMsg(msg);
        setMode('error');
      }
    })();

    return () => {
      cancelled = true;
      if (cancelWait) {
        cancelWait();
        cancelWait = null;
      }
      console.log(`[player] Unmounting — cleanup complete for chapter ${chapterId}`);
    };
  }, [chapterId]);

  // ── download progress subscription ── (hook #11)
  useEffect(() => {
    if (!chapterId) return;
    const sub = onDownloadProgress((evt) => {
      if (evt.id === chapterId) {
        console.log(
          `[player] Download progress for chapter ${chapterId}: ${evt.percentDownloaded}%`,
        );
        setDownload(evt);
      }
    });
    IcareOfflineDrm.getDownload(chapterId).then((d) => {
      if (d) setDownload(d);
    });
    return () => sub.remove();
  }, [chapterId]);

  // ── keep-awake: active while screen is focused and video is loaded ── (hook #12)
  // Uses mode rather than isPlaying so the screen stays awake immediately when
  // tokens arrive — before the first playback frame — and remains awake even
  // when the video is paused (intentional; user is still watching the screen).
  const shouldKeepAwake = isFocused && (mode === 'online' || mode === 'offline');
  useChapterKeepAwake(shouldKeepAwake);

  // ── video source ── (hook #13)
  const source: ReactVideoSource | null = useMemo(() => {
    if (mode === 'offline' && offline) {
      return { uri: offline.uri, type: 'm3u8', cacheKey: offline.cacheKey } as ReactVideoSource;
    }
    if (mode === 'online' && tokens) {
      return { uri: tokens.secureStreamUrl, type: 'm3u8' } as ReactVideoSource;
    }
    return null;
  }, [mode, offline, tokens]);

  // ── DRM config ── (hook #14)
  const drm = useMemo(() => {
    if (mode === 'offline' && offline) {
      return { type: 'widevine' as DRMType, offlineLicense: offline.offlineLicenseKeySetId };
    }
    if (mode === 'online' && tokens) {
      return {
        type: 'widevine' as DRMType,
        licenseServer: tokens.drmLicenseUrl,
        headers: { 'x-mux-license-token': tokens.drmToken },
      };
    }
    return undefined;
  }, [mode, offline, tokens]);

  // ── download handler ── (hook #15)
  /**
   * Request a fresh token via the WebView bridge, then start the download.
   * Avoids calling getMuxToken() natively (which fails with 401 on Android
   * because React Native's fetch() does not share the WebView cookie jar).
   */
  const handleDownload = useCallback(async () => {
    if (!chapter || !chapterId) return;
    const playbackId = selectMuxPlaybackId(chapter);
    if (!playbackId) return;

    console.log(`[player] Requesting download tokens for chapter ${chapterId}`);
    const dispatched = requestWebViewTokens(chapterId);
    if (!dispatched) {
      Alert.alert('Download failed', 'Please return to the course page and try again.');
      return;
    }

    const handle = waitForPlayerData(chapterId);
    const result = await handle.promise;

    if (!result.ok) {
      console.warn(
        `[player] Download token fetch failed for chapter ${chapterId}: ${result.error}`,
      );
      Alert.alert('Download failed', result.error);
      return;
    }

    try {
      const tk = result.data.tokens;
      console.log(`[player] Starting download for chapter ${chapterId}`);
      await IcareOfflineDrm.startDownload({
        id: chapterId,
        manifestUrl: tk.secureStreamUrl,
        drmLicenseUrl: tk.drmLicenseUrl,
        drmToken: tk.drmToken,
        title: chapter.title,
      });
    } catch (err: any) {
      console.error(
        `[player] Download start failed for chapter ${chapterId}: ${err?.message}`,
      );
      Alert.alert('Download failed', err?.message ?? String(err));
    }
  }, [chapter, chapterId]);

  // ── delete-download handler ── (hook #16)
  /**
   * Remove the offline copy, then re-fetch tokens via the WebView bridge to
   * resume online streaming. Avoids the native getMuxToken() 401 issue.
   */
  const handleDeleteDownload = useCallback(async () => {
    if (!chapterId) return;
    console.log(`[player] Deleting download for chapter ${chapterId}`);
    await IcareOfflineDrm.removeDownload(chapterId);
    setDownload(null);
    setOffline(null);

    if (!chapter) {
      setErrorMsg('Cannot resume streaming — chapter metadata not available.');
      setMode('error');
      return;
    }

    setMode('loading');
    console.log(
      `[player] Requesting fresh tokens after download deletion for chapter ${chapterId}`,
    );
    const dispatched = requestWebViewTokens(chapterId);
    if (!dispatched) {
      setErrorMsg(
        'Please return to the course page and tap the chapter again to resume streaming.',
      );
      setMode('error');
      return;
    }

    const handle = waitForPlayerData(chapterId);
    const result = await handle.promise;

    if (!result.ok) {
      console.warn(
        `[player] Token refresh failed after download deletion for chapter ${chapterId}: ${result.error}`,
      );
      setErrorMsg(`Could not resume streaming: ${result.error}`);
      setMode('error');
      return;
    }

    console.log(`[player] Resuming online streaming for chapter ${chapterId}`);
    setTokens(result.data.tokens);
    setMode('online');
  }, [chapter, chapterId]);

  // ── webview-fallback navigation ── (hook #17)
  // When native Video is unavailable on this device (react-native-video 5.x is
  // Old Architecture only; RN 0.76+ forces New Architecture / Bridgeless which
  // nulls the ViewManager registry), navigate back immediately so the Base44
  // WebView player handles playback instead of crashing.
  // Short delay (100 ms) lets React commit the render before navigation fires.
  useEffect(() => {
    if (mode !== 'webview-fallback') return;
    const timer = setTimeout(() => {
      router.back();
    }, 100);
    return () => clearTimeout(timer);
  }, [mode, router]);

  // ── ALL HOOKS ABOVE THIS LINE ─────────────────────────────────────────────
  // Render state log — confirms hook-order-v2 is active and shows current state.
  console.log('[player] render state', {
    chapterId,
    mode,
    hasTokens: !!tokens,
    hasOfflineSource: !!offline,
  });

  // ── loading ──
  if (mode === 'loading') {
    return (
      <View style={styles.center}>
        <ActivityIndicator size="large" />
        <Text style={styles.muted}>Loading chapter…</Text>
      </View>
    );
  }

  // ── webview-fallback ──
  // react-native-video 5.x is not compatible with New Architecture (RN 0.76+).
  // Show a brief spinner while useEffect navigates back to the Base44 WebView
  // player (100 ms). User sees this for only one frame on Android New Arch.
  if (mode === 'webview-fallback') {
    return (
      <View style={styles.center}>
        <ActivityIndicator size="large" />
        <Text style={styles.muted}>Opening in browser…</Text>
      </View>
    );
  }

  // ── error ──
  if (mode === 'error') {
    return (
      <View style={styles.center}>
        <Text style={styles.error}>Could not load chapter.</Text>
        <Text style={styles.muted}>{errorMsg}</Text>
        <Pressable style={styles.btn} onPress={() => router.back()}>
          <Text style={styles.btnText}>Go back</Text>
        </Pressable>
      </View>
    );
  }

  // ── online / offline: delegate entirely to VideoPlayer child ──
  // source is non-null here because mode is 'online'|'offline' and useMemo
  // always produces a source value for those modes.
  return (
    <VideoPlayer
      source={source!}
      drm={drm as Record<string, any> | undefined}
      chapter={chapter}
      mode={mode as 'online' | 'offline'}
      offline={offline}
      download={download}
      chapterId={chapterId ?? ''}
      onDownload={handleDownload}
      onDelete={handleDeleteDownload}
    />
  );
}

// ─── DownloadControls ─────────────────────────────────────────────────────────

function DownloadControls({
  download,
  offline,
  onDownload,
  onDelete,
}: {
  download: DownloadInfo | null;
  offline: boolean;
  onDownload: () => void;
  onDelete: () => void;
}) {
  if (offline || download?.state === 'completed') {
    return (
      <View style={styles.actionRow}>
        <Text style={styles.muted}>Downloaded for offline playback</Text>
        <Pressable style={[styles.btn, styles.btnDanger]} onPress={onDelete}>
          <Text style={styles.btnText}>Remove download</Text>
        </Pressable>
      </View>
    );
  }
  if (download && (download.state === 'downloading' || download.state === 'queued')) {
    const pct =
      download.percentDownloaded >= 0
        ? `${Math.round(download.percentDownloaded)}%`
        : '…';
    return (
      <View style={styles.actionRow}>
        <Text style={styles.muted}>Downloading {pct}</Text>
      </View>
    );
  }
  if (download?.state === 'failed') {
    return (
      <View style={styles.actionRow}>
        <Text style={styles.error}>
          Download failed: {download.failureReason ?? 'unknown'}
        </Text>
        <Pressable style={styles.btn} onPress={onDownload}>
          <Text style={styles.btnText}>Retry</Text>
        </Pressable>
      </View>
    );
  }
  return (
    <View style={styles.actionRow}>
      <Pressable style={styles.btn} onPress={onDownload}>
        <Text style={styles.btnText}>Download for offline</Text>
      </Pressable>
    </View>
  );
}

// ─── Styles ───────────────────────────────────────────────────────────────────

const styles = StyleSheet.create({
  container: { flex: 1, backgroundColor: '#000' },
  playerWrap: { backgroundColor: '#000', position: 'relative' },
  pinchOverlay: { backgroundColor: 'transparent' },
  center: { flex: 1, alignItems: 'center', justifyContent: 'center', padding: 16, gap: 8 },
  metaRow: { flexDirection: 'row', alignItems: 'center', padding: 12, gap: 12 },
  title: { color: '#fff', fontSize: 16, fontWeight: '600', flex: 1 },
  badge: {
    color: '#fff',
    fontSize: 11,
    paddingHorizontal: 8,
    paddingVertical: 4,
    borderRadius: 6,
    backgroundColor: 'rgba(255,255,255,0.15)',
  },
  actionRow: { padding: 12, gap: 8, alignItems: 'flex-start' },
  btn: {
    backgroundColor: '#1D3D47',
    paddingHorizontal: 14,
    paddingVertical: 10,
    borderRadius: 8,
  },
  btnDanger: { backgroundColor: '#a33b3b' },
  btnText: { color: '#fff', fontWeight: '600' },
  muted: { color: 'rgba(255,255,255,0.6)', fontSize: 13 },
  error: { color: '#f88', fontSize: 14 },
  audioToast: {
    position: 'absolute',
    bottom: 16,
    left: 12,
    right: 12,
    backgroundColor: 'rgba(0,0,0,0.82)',
    borderRadius: 8,
    padding: 12,
    flexDirection: 'row',
    alignItems: 'center',
    gap: 10,
  },
  audioToastText: { color: '#fff', fontSize: 13, flex: 1, lineHeight: 18 },
  audioToastDismiss: { color: 'rgba(255,255,255,0.6)', fontSize: 16, paddingHorizontal: 4 },
});
