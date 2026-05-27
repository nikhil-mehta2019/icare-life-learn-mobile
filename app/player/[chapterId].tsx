/**
 * player/[chapterId].tsx
 *
 * Native video player screen for a single chapter.
 *
 * ─── Loading sequence ─────────────────────────────────────────────────────────
 *
 *  1. Check for an existing offline copy + DRM licence → play offline.
 *  2. Wait for tokens pre-fetched by the WebView bridge (max 10 s).
 *     The WebView has the user's session cookies; React Native's fetch() does
 *     not share the cookie jar on Android, so all authenticated API calls are
 *     routed through the WebView.
 *  3. If the bridge times out or returns an error, show an error screen.
 *     (The old "native getMuxToken fallback" has been removed because it always
 *      fails with 401 — it was the source of the Unauthorized error.)
 *
 * ─── Token refresh (download / delete-download) ───────────────────────────────
 *
 *  Both actions require a fresh Mux token.  Instead of calling getMuxToken()
 *  natively (which fails with 401 on Android), we request the tokens from the
 *  WebView bridge via requestWebViewTokens() + waitForPlayerData().  This
 *  ensures the authenticated session cookie is always used.
 *
 * ─── Component lifecycle / memory leak prevention ────────────────────────────
 *
 *  • The initial load effect holds a { promise, cancel } handle from
 *    waitForPlayerData(). cancel() is called in the cleanup function so the
 *    pending resolver and its 10 s timer are removed immediately on unmount.
 *  • A `cancelled` flag guards every async continuation — if the component
 *    unmounts between awaits, state updates are skipped.
 *  • Keep-awake is activated while isPlaying and deactivated on unmount.
 */

import { activateKeepAwakeAsync, deactivateKeepAwake } from 'expo-keep-awake';
import { useLocalSearchParams, useRouter } from 'expo-router';
import { getItemAsync, setItemAsync } from 'expo-secure-store';
import { useEffect, useMemo, useRef, useState, useCallback } from 'react';
import {
  ActivityIndicator,
  Alert,
  Animated,
  Pressable,
  StyleSheet,
  Text,
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
import { waitForPlayerData } from '../../api/playerCache';
import { requestWebViewTokens } from '../(tabs)/explore';
import IcareOfflineDrm, {
  onDownloadProgress,
  type DownloadInfo,
  type OfflinePlaybackSource,
} from '../../modules/icare-offline-drm';

type Mode = 'loading' | 'online' | 'offline' | 'error';

export default function ChapterPlayerScreen() {
  const { chapterId } = useLocalSearchParams<{ chapterId: string }>();
  const router = useRouter();
  const videoRef = useRef<VideoRef>(null);
  const { width } = useWindowDimensions();
  const [isFullscreen, setIsFullscreen] = useState(false);

  const [mode, setMode] = useState<Mode>('loading');
  const [isPlaying, setIsPlaying] = useState(false);
  const [errorMsg, setErrorMsg] = useState<string | null>(null);
  // Peak scale tracked across the pinch gesture — Android MediaController
  // intercepts touches so onEnd scale is often 1.0; we track the max instead.
  const peakScale = useRef(1);
  const [audioToastVisible, setAudioToastVisible] = useState(false);
  const audioToastOpacity = useRef(new Animated.Value(0)).current;
  const [chapter, setChapter] = useState<Chapter | null>(null);
  const [tokens, setTokens] = useState<MuxTokenResponse | null>(null);
  const [offline, setOffline] = useState<OfflinePlaybackSource | null>(null);
  const [download, setDownload] = useState<DownloadInfo | null>(null);

  // ----- Initial load --------------------------------------------------------
  useEffect(() => {
    let cancelled = false;
    // cancelWait() clears our resolver from playerCache immediately on unmount,
    // preventing the 10 s timer from firing setState on an unmounted component.
    let cancelWait: (() => void) | null = null;

    (async () => {
      try {
        if (!chapterId) throw new Error('Missing chapterId');
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

        const cached = await handle.promise;
        if (cancelled) return;
        cancelWait = null; // resolved — no longer need to cancel

        if (cached) {
          console.log(`[player] Tokens received for chapter ${chapterId} — starting playback`);
          setChapter(cached.chapter);
          setTokens(cached.tokens);
          setMode('online');
          return;
        }

        // 3) Bridge timed out or returned an error.
        //    We do NOT fall back to a native getMuxToken() call because it
        //    always fails with 401 on Android (no shared cookie jar).
        //    Instead, surface a clear error so the user knows to re-tap or
        //    check their login.
        console.warn(`[player] No tokens received for chapter ${chapterId} — showing error`);
        throw new Error(
          'Could not load this chapter. Please make sure you are logged in and try again.'
        );
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

  // ----- Download progress subscription ------------------------------------
  useEffect(() => {
    if (!chapterId) return;
    const sub = onDownloadProgress((evt) => {
      if (evt.id === chapterId) {
        console.log(`[player] Download progress for chapter ${chapterId}: ${evt.percentDownloaded}%`);
        setDownload(evt);
      }
    });
    IcareOfflineDrm.getDownload(chapterId).then((d) => {
      if (d) setDownload(d);
    });
    return () => sub.remove();
  }, [chapterId]);

  // ----- Audio language toast -----------------------------------------------
  const handleVideoLoad = async (data: any) => {
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
  };

  // ----- Keep screen awake --------------------------------------------------
  useEffect(() => {
    const TAG = 'video-player';
    if (isPlaying) {
      activateKeepAwakeAsync(TAG);
    } else {
      deactivateKeepAwake(TAG);
    }
    return () => { deactivateKeepAwake(TAG); };
  }, [isPlaying]);

  // ----- Build Video source -------------------------------------------------
  const source: ReactVideoSource | null = useMemo(() => {
    if (mode === 'offline' && offline) {
      return { uri: offline.uri, type: 'm3u8', cacheKey: offline.cacheKey } as ReactVideoSource;
    }
    if (mode === 'online' && tokens) {
      return { uri: tokens.secureStreamUrl, type: 'm3u8' } as ReactVideoSource;
    }
    return null;
  }, [mode, offline, tokens]);

  // ----- DRM config ---------------------------------------------------------
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

  // ----- Download -----------------------------------------------------------
  /**
   * Request a fresh token via the WebView bridge, then start the download.
   * This avoids calling getMuxToken() natively (which fails with 401 on Android
   * because React Native's fetch() does not share the WebView cookie jar).
   */
  const handleDownload = async () => {
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
    const data = await handle.promise;

    if (!data) {
      console.warn(`[player] Download token fetch timed out for chapter ${chapterId}`);
      Alert.alert('Download failed', 'Could not retrieve download token. Please try again.');
      return;
    }

    try {
      const tk = data.tokens;
      console.log(`[player] Starting download for chapter ${chapterId}`);
      await IcareOfflineDrm.startDownload({
        id: chapterId,
        manifestUrl: tk.secureStreamUrl,
        drmLicenseUrl: tk.drmLicenseUrl,
        drmToken: tk.drmToken,
        title: chapter.title,
      });
    } catch (err: any) {
      console.error(`[player] Download start failed for chapter ${chapterId}: ${err?.message}`);
      Alert.alert('Download failed', err?.message ?? String(err));
    }
  };

  // ----- Delete download ----------------------------------------------------
  /**
   * Remove the offline copy, then re-fetch tokens via the WebView bridge to
   * resume online streaming.  This avoids the native getMuxToken() 401 issue.
   */
  const handleDeleteDownload = async () => {
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
    console.log(`[player] Requesting fresh tokens after download deletion for chapter ${chapterId}`);
    const dispatched = requestWebViewTokens(chapterId);
    if (!dispatched) {
      setErrorMsg('Please return to the course page and tap the chapter again to resume streaming.');
      setMode('error');
      return;
    }

    const handle = waitForPlayerData(chapterId);
    const data = await handle.promise;

    if (!data) {
      console.warn(`[player] Token refresh timed out after download deletion for chapter ${chapterId}`);
      setErrorMsg('Could not resume streaming. Please go back and re-open the chapter.');
      setMode('error');
      return;
    }

    console.log(`[player] Resuming online streaming for chapter ${chapterId}`);
    setTokens(data.tokens);
    setMode('online');
  };

  // ----- Render: loading / error --------------------------------------------
  if (mode === 'loading') {
    return (
      <View style={styles.center}>
        <ActivityIndicator size="large" />
        <Text style={styles.muted}>Loading chapter…</Text>
      </View>
    );
  }
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

  // ----- Pinch-to-fullscreen gesture ----------------------------------------
  //
  // Two fixes vs the previous implementation:
  //
  // 1. Track PEAK scale via onUpdate, not final scale via onEnd.
  //    On Android, the native MediaController intercepts touch events, so by
  //    the time fingers lift the reported scale is often back near 1.0.
  //    Tracking the maximum scale seen during the gesture is reliable.
  //
  // 2. The GestureDetector is placed on a transparent OVERLAY View that sits
  //    ABOVE the Video component (not wrapping it).  This prevents the Video's
  //    native MediaController from swallowing pinch pointer events before RNGH
  //    can read them, while still allowing single taps to reach the controls.
  //
  // 3. Use only the imperative ref methods (presentFullscreenPlayer /
  //    dismissFullscreenPlayer) — NOT the fullscreen prop — to avoid double-
  //    triggering the native fullscreen on some Android RNVideo 5.x builds.

  const pinchGesture = Gesture.Pinch()
    .runOnJS(true)
    .onStart(() => {
      peakScale.current = 1;
    })
    .onUpdate((e) => {
      if (e.scale > peakScale.current) peakScale.current = e.scale;
    })
    .onEnd(() => {
      const peak = peakScale.current;
      peakScale.current = 1;
      if (peak > 1.1 && !isFullscreen) {
        console.log(`[player] Pinch-out detected (peak ${peak.toFixed(2)}) — entering fullscreen`);
        setIsFullscreen(true);
        videoRef.current?.presentFullscreenPlayer();
      } else if (peak < 0.9 && isFullscreen) {
        console.log(`[player] Pinch-in detected (peak ${peak.toFixed(2)}) — exiting fullscreen`);
        setIsFullscreen(false);
        videoRef.current?.dismissFullscreenPlayer();
      }
    });

  // onPlaybackRateChange is the correct v5.2.1 callback for play/pause state.
  // onPlaybackStateChanged does not exist in v5 — it was silently ignored.
  const handlePlaybackRateChange = useCallback(({ playbackRate }: { playbackRate: number }) => {
    setIsPlaying(playbackRate > 0);
  }, []);

  const playerHeight = (width / 16) * 9;

  // ----- Render: player -----------------------------------------------------
  return (
    <GestureHandlerRootView style={styles.container}>
      <View style={[styles.playerWrap, { width, height: playerHeight }]}>
        {source && (
          <Video
            ref={videoRef}
            source={source}
            drm={drm}
            controls
            resizeMode="contain"
            onFullscreenPlayerDidDismiss={() => {
              console.log('[player] Fullscreen dismissed');
              setIsFullscreen(false);
            }}
            onLoad={handleVideoLoad}
            onPlaybackRateChange={handlePlaybackRateChange}
            onEnd={() => {
              console.log('[player] Playback ended');
              setIsPlaying(false);
            }}
            style={StyleSheet.absoluteFill}
            onError={(e: any) => {
              setIsPlaying(false);
              const detail = JSON.stringify(e?.error ?? e);
              console.error(`[player] Playback error for chapter ${chapterId}: ${detail}`);
              Alert.alert('Playback error', detail);
            }}
          />
        )}

        {/* Transparent pinch-capture overlay — above Video so RNGH receives
            pinch pointers before the native MediaController can swallow them.
            pointerEvents="box-none" lets single taps pass through to controls. */}
        <GestureDetector gesture={pinchGesture}>
          <View style={[StyleSheet.absoluteFill, styles.pinchOverlay]} pointerEvents="box-none" />
        </GestureDetector>

        {audioToastVisible && (
          <Animated.View style={[styles.audioToast, { opacity: audioToastOpacity }]}>
            <Text style={styles.audioToastText}>
              Multiple audio languages available. Select your preferred language from player settings.
            </Text>
            <Pressable onPress={() => {
              audioToastOpacity.setValue(0);
              setAudioToastVisible(false);
            }}>
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
        onDownload={handleDownload}
        onDelete={handleDeleteDownload}
      />
    </GestureHandlerRootView>
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
    const pct = download.percentDownloaded >= 0
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
        <Text style={styles.error}>Download failed: {download.failureReason ?? 'unknown'}</Text>
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
  // Transparent view that sits above the Video to capture pinch gestures
  // before the native MediaController can intercept them.
  pinchOverlay: { backgroundColor: 'transparent' },
  center: { flex: 1, alignItems: 'center', justifyContent: 'center', padding: 16, gap: 8 },
  metaRow: { flexDirection: 'row', alignItems: 'center', padding: 12, gap: 12 },
  title: { color: '#fff', fontSize: 16, fontWeight: '600', flex: 1 },
  badge: {
    color: '#fff', fontSize: 11, paddingHorizontal: 8, paddingVertical: 4,
    borderRadius: 6, backgroundColor: 'rgba(255,255,255,0.15)',
  },
  actionRow: { padding: 12, gap: 8, alignItems: 'flex-start' },
  btn: {
    backgroundColor: '#1D3D47', paddingHorizontal: 14, paddingVertical: 10,
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
