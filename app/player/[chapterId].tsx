/**
 * player/[chapterId].tsx — offline-learning-center upgrade
 *
 * Architecture: shell + child pattern (hook-order-v2 preserved).
 *
 * New in this revision:
 *   - Offline/online network detection (useNetworkStatus ping hook)
 *   - "Playing downloaded content" banner when mode === 'offline'
 *   - "Internet connection required" when device is offline and no download exists
 *   - Watch-position persistence via offlineProgress store (fire-and-forget)
 *   - Resume from last position on load
 *   - Improved DownloadControls: "Download for Offline Viewing", "Downloaded ✓",
 *     "Remove Download", "Go to Downloads"
 *   - License renewal entry point when license is expired
 */

console.log('[build] iCare player offline-learning-center active');

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
import { useNetworkStatus } from '../../hooks/useNetworkStatus';
import {
  saveProgress,
  getProgress,
  clearProgress,
} from '../../store/offlineProgress';

type Mode = 'loading' | 'online' | 'offline' | 'error' | 'webview-fallback' | 'no-internet';

// ─── Android online playback gate ────────────────────────────────────────────
// react-native-video 5.2.1 is Old Architecture only; crashes on RN 0.76+ New Arch.
// Online playback on Android is forced to the Base44 WebView player.
// Offline DRM playback continues to use the native Video component on all platforms.

const FORCE_ANDROID_WEBVIEW_PLAYER = Platform.OS === 'android';

// ─── License status ──────────────────────────────────────────────────────────

function isLicenseExpired(downloadedAt?: string | null): boolean {
  if (!downloadedAt) return false;
  try {
    const ageMs = Date.now() - new Date(downloadedAt).getTime();
    return ageMs > 30 * 24 * 60 * 60 * 1000;
  } catch {
    return false;
  }
}

// ─── Keep-awake hook ─────────────────────────────────────────────────────────

const KEEP_AWAKE_TAG = 'icare-chapter-player';

function useChapterKeepAwake(shouldKeepAwake: boolean) {
  useEffect(() => {
    let released = false;
    async function apply() {
      try {
        if (shouldKeepAwake) await activateKeepAwakeAsync(KEEP_AWAKE_TAG);
        else await deactivateKeepAwake(KEEP_AWAKE_TAG);
      } catch (e) {
        console.warn('[player] keep-awake update failed', e);
      }
    }
    apply();
    return () => {
      if (!released) {
        released = true;
        deactivateKeepAwake(KEEP_AWAKE_TAG).catch(() => {});
      }
    };
  }, [shouldKeepAwake]);
}

// ─── Offline banner ──────────────────────────────────────────────────────────

function OfflineBanner({ message }: { message: string }) {
  return (
    <View style={bannerStyles.banner}>
      <Text style={bannerStyles.icon}>📥</Text>
      <Text style={bannerStyles.text}>{message}</Text>
    </View>
  );
}

const bannerStyles = StyleSheet.create({
  banner: {
    flexDirection: 'row',
    alignItems: 'center',
    backgroundColor: '#1D3D47',
    paddingHorizontal: 14,
    paddingVertical: 8,
    gap: 8,
  },
  icon: { fontSize: 14 },
  text: { color: '#fff', fontSize: 12, fontWeight: '500', flex: 1 },
});

// ─── VideoPlayer child ────────────────────────────────────────────────────────

interface VideoPlayerProps {
  source: ReactVideoSource;
  drm: Record<string, any> | undefined;
  chapter: Chapter | null;
  mode: 'online' | 'offline';
  offline: OfflinePlaybackSource | null;
  download: DownloadInfo | null;
  chapterId: string;
  initialPositionSeconds: number;
  onDownload: () => void;
  onDelete: () => void;
  onGoToDownloads: () => void;
}

function VideoPlayer({
  source,
  drm,
  chapter,
  mode,
  offline,
  download,
  chapterId,
  initialPositionSeconds,
  onDownload,
  onDelete,
  onGoToDownloads,
}: VideoPlayerProps) {
  const videoRef = useRef<VideoRef>(null);
  const { width } = useWindowDimensions();
  const [isFullscreen, setIsFullscreen] = useState(false);
  const peakScale = useRef(1);
  const [audioToastVisible, setAudioToastVisible] = useState(false);
  const audioToastOpacity = useRef(new Animated.Value(0)).current;
  const durationRef = useRef(-1);
  const lastSavedPosition = useRef(0);
  const hasSeekedToResume = useRef(false);

  const handleVideoLoad = useCallback(
    async (data: any) => {
      activateKeepAwakeAsync(KEEP_AWAKE_TAG);
      durationRef.current = data?.duration ?? -1;

      // Seek to last-watched position (only once per mount)
      if (!hasSeekedToResume.current && initialPositionSeconds > 5) {
        hasSeekedToResume.current = true;
        videoRef.current?.seek(initialPositionSeconds);
      }

      const tracks: any[] = data?.audioTracks ?? [];
      if (tracks.length <= 1) return;
      try {
        const seen = await getItemAsync('audio_lang_hint_shown');
        if (seen) return;
        await setItemAsync('audio_lang_hint_shown', '1');
      } catch {}
      setAudioToastVisible(true);
      Animated.sequence([
        Animated.timing(audioToastOpacity, { toValue: 1, duration: 300, useNativeDriver: true }),
        Animated.delay(4000),
        Animated.timing(audioToastOpacity, { toValue: 0, duration: 400, useNativeDriver: true }),
      ]).start(() => setAudioToastVisible(false));
    },
    [audioToastOpacity, initialPositionSeconds],
  );

  const handleProgress = useCallback(
    (data: { currentTime: number; playableDuration: number; seekableDuration: number }) => {
      const pos = data.currentTime;
      // Save every 10 seconds to avoid excessive I/O
      if (pos - lastSavedPosition.current < 10) return;
      lastSavedPosition.current = pos;
      const dur = durationRef.current;
      const pct = dur > 0 ? (pos / dur) * 100 : 0;
      saveProgress({
        chapterId,
        watchedSeconds: pos,
        durationSeconds: dur,
        percentWatched: pct,
        lastWatchedAt: new Date().toISOString(),
      }).catch(() => {});
    },
    [chapterId],
  );

  const handleEnd = useCallback(() => {
    console.log('[player] Playback ended');
    // Mark as fully watched
    const dur = durationRef.current;
    if (dur > 0) {
      saveProgress({
        chapterId,
        watchedSeconds: dur,
        durationSeconds: dur,
        percentWatched: 100,
        lastWatchedAt: new Date().toISOString(),
      }).catch(() => {});
    }
  }, [chapterId]);

  const pinchGesture = Gesture.Pinch()
    .runOnJS(true)
    .onStart(() => { peakScale.current = 1; })
    .onUpdate((e) => { if (e.scale > peakScale.current) peakScale.current = e.scale; })
    .onEnd(() => {
      const peak = peakScale.current;
      peakScale.current = 1;
      if (peak > 1.1 && !isFullscreen) {
        setIsFullscreen(true);
        videoRef.current?.presentFullscreenPlayer();
      } else if (peak < 0.9 && isFullscreen) {
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
          progressUpdateInterval={1000}
          onLoad={handleVideoLoad}
          onProgress={handleProgress}
          onEnd={handleEnd}
          onReadyForDisplay={() => activateKeepAwakeAsync(KEEP_AWAKE_TAG)}
          onFullscreenPlayerWillPresent={() => activateKeepAwakeAsync(KEEP_AWAKE_TAG)}
          onFullscreenPlayerDidPresent={() => activateKeepAwakeAsync(KEEP_AWAKE_TAG)}
          onFullscreenPlayerWillDismiss={() => activateKeepAwakeAsync(KEEP_AWAKE_TAG)}
          onFullscreenPlayerDidDismiss={() => {
            setIsFullscreen(false);
            activateKeepAwakeAsync(KEEP_AWAKE_TAG);
          }}
          style={StyleSheet.absoluteFill}
          onError={(e: any) => {
            const detail = JSON.stringify(e?.error ?? e);
            console.error(`[player] Playback error for chapter ${chapterId}: ${detail}`);
            Alert.alert('Playback error', detail);
          }}
        />
        <GestureDetector gesture={pinchGesture}>
          <View style={[StyleSheet.absoluteFill, styles.pinchOverlay]} pointerEvents="box-none" />
        </GestureDetector>
        {audioToastVisible && (
          <Animated.View style={[styles.audioToast, { opacity: audioToastOpacity }]}>
            <Text style={styles.audioToastText}>
              Multiple audio languages available. Select your preferred language from player settings.
            </Text>
            <Pressable onPress={() => { audioToastOpacity.setValue(0); setAudioToastVisible(false); }}>
              <Text style={styles.audioToastDismiss}>✕</Text>
            </Pressable>
          </Animated.View>
        )}
      </View>

      {/* Offline banner */}
      {mode === 'offline' && (
        <OfflineBanner message="Playing downloaded content" />
      )}

      <View style={styles.metaRow}>
        <Text style={styles.title} numberOfLines={2}>{chapter?.title ?? 'Lesson'}</Text>
        <Text style={styles.badge}>{mode === 'offline' ? 'Offline' : 'Streaming'}</Text>
      </View>

      <DownloadControls
        download={download}
        offline={!!offline}
        offlineDownload={download}
        onDownload={onDownload}
        onDelete={onDelete}
        onGoToDownloads={onGoToDownloads}
      />
    </GestureHandlerRootView>
  );
}

// ─── ChapterPlayerScreen (shell / parent) ─────────────────────────────────────
//
// INVARIANT: every hook in this function is called on EVERY render.

export default function ChapterPlayerScreen() {
  const { chapterId } = useLocalSearchParams<{ chapterId: string }>();
  const router = useRouter();
  const isFocused = useIsFocused();
  const { isOnline } = useNetworkStatus();

  const [mode, setMode] = useState<Mode>('loading');
  const [errorMsg, setErrorMsg] = useState<string | null>(null);
  const [chapter, setChapter] = useState<Chapter | null>(null);
  const [tokens, setTokens] = useState<MuxTokenResponse | null>(null);
  const [offline, setOffline] = useState<OfflinePlaybackSource | null>(null);
  const [download, setDownload] = useState<DownloadInfo | null>(null);
  const [initialPositionSeconds, setInitialPositionSeconds] = useState(0);

  // ── initial load ──
  useEffect(() => {
    let cancelled = false;
    let cancelWait: (() => void) | null = null;

    (async () => {
      try {
        if (!chapterId) throw new Error('Missing chapterId');

        // 1) Restore last-watched position
        const savedProg = await getProgress(chapterId);
        if (!cancelled && savedProg && savedProg.watchedSeconds > 5) {
          setInitialPositionSeconds(savedProg.watchedSeconds);
        }

        // 2) Check for offline copy
        const off = await IcareOfflineDrm.getOfflineSource({ id: chapterId });
        if (cancelled) return;

        if (off) {
          const ch = await fetchChapter(chapterId);
          if (cancelled) return;
          setChapter(ch.data);
          setOffline(off);
          setMode('offline');
          return;
        }

        // 3) No offline copy — check network before waiting for tokens
        // isOnline can be null (not yet checked). Proceed optimistically.
        // The token wait will handle the timeout case.
        const handle = waitForPlayerData(chapterId);
        cancelWait = handle.cancel;

        const result: BridgeResult = await handle.promise;
        if (cancelled) return;
        cancelWait = null;

        if (result.ok) {
          setChapter(result.data.chapter);
          setTokens(result.data.tokens);
          if (FORCE_ANDROID_WEBVIEW_PLAYER) {
            setMode('webview-fallback');
          } else {
            setMode('online');
          }
          return;
        }

        // 4) Bridge failed — if we know device is offline and there's no download,
        //    show the "no internet" screen instead of a generic error.
        if (isOnline === false) {
          setMode('no-internet');
          return;
        }

        throw new Error(result.error);
      } catch (err: any) {
        if (cancelled) return;
        const msg = err?.message ?? String(err);
        setErrorMsg(msg);
        // If we know device is offline, show the friendly no-internet screen
        if (isOnline === false) {
          setMode('no-internet');
        } else {
          setMode('error');
        }
      }
    })();

    return () => {
      cancelled = true;
      if (cancelWait) { cancelWait(); cancelWait = null; }
    };
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [chapterId]);

  // ── download progress subscription ──
  useEffect(() => {
    if (!chapterId) return;
    const sub = onDownloadProgress((evt) => {
      if (evt.id === chapterId) setDownload(evt);
    });
    IcareOfflineDrm.getDownload(chapterId).then((d) => { if (d) setDownload(d); });
    return () => sub.remove();
  }, [chapterId]);

  // ── keep-awake ──
  const shouldKeepAwake = isFocused && (mode === 'online' || mode === 'offline');
  useChapterKeepAwake(shouldKeepAwake);

  // ── video source ──
  const source: ReactVideoSource | null = useMemo(() => {
    if (mode === 'offline' && offline) {
      return { uri: offline.uri, type: 'm3u8', cacheKey: offline.cacheKey } as ReactVideoSource;
    }
    if (mode === 'online' && tokens) {
      return { uri: tokens.secureStreamUrl, type: 'm3u8' } as ReactVideoSource;
    }
    return null;
  }, [mode, offline, tokens]);

  // ── DRM config ──
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

  // ── download handler ──
  const handleDownload = useCallback(async () => {
    if (!chapter || !chapterId) return;
    const playbackId = selectMuxPlaybackId(chapter);
    if (!playbackId) return;

    const dispatched = requestWebViewTokens(chapterId);
    if (!dispatched) {
      Alert.alert('Download failed', 'Please return to the course page and try again.');
      return;
    }

    const handle = waitForPlayerData(chapterId);
    const result = await handle.promise;

    if (!result.ok) {
      Alert.alert('Download failed', result.error);
      return;
    }

    try {
      const tk = result.data.tokens;
      await IcareOfflineDrm.startDownload({
        id: chapterId,
        manifestUrl: tk.secureStreamUrl,
        drmLicenseUrl: tk.drmLicenseUrl,
        drmToken: tk.drmToken,
        title: chapter.title,
      });
    } catch (err: any) {
      Alert.alert('Download failed', err?.message ?? String(err));
    }
  }, [chapter, chapterId]);

  // ── delete-download handler ──
  const handleDeleteDownload = useCallback(async () => {
    if (!chapterId) return;
    await IcareOfflineDrm.removeDownload(chapterId);
    await clearProgress(chapterId);
    setDownload(null);
    setOffline(null);

    if (!chapter) {
      setErrorMsg('Cannot resume streaming — chapter metadata not available.');
      setMode('error');
      return;
    }

    setMode('loading');
    const dispatched = requestWebViewTokens(chapterId);
    if (!dispatched) {
      setErrorMsg('Please return to the course page and tap the chapter again.');
      setMode('error');
      return;
    }

    const handle = waitForPlayerData(chapterId);
    const result = await handle.promise;

    if (!result.ok) {
      setErrorMsg(`Could not resume streaming: ${result.error}`);
      setMode('error');
      return;
    }

    setTokens(result.data.tokens);
    if (FORCE_ANDROID_WEBVIEW_PLAYER) {
      setMode('webview-fallback');
    } else {
      setMode('online');
    }
  }, [chapter, chapterId]);

  // ── Go to downloads ──
  const handleGoToDownloads = useCallback(() => {
    router.push('/(tabs)/downloads' as any);
  }, [router]);

  // ── webview-fallback navigation ──
  useEffect(() => {
    if (mode !== 'webview-fallback') return;
    const timer = setTimeout(() => router.back(), 100);
    return () => clearTimeout(timer);
  }, [mode, router]);

  // ── ALL HOOKS ABOVE ───────────────────────────────────────────────────────

  if (mode === 'loading') {
    return (
      <View style={styles.center}>
        <ActivityIndicator size="large" />
        <Text style={styles.muted}>Loading chapter…</Text>
      </View>
    );
  }

  if (mode === 'webview-fallback') {
    return (
      <View style={styles.center}>
        <ActivityIndicator size="large" />
        <Text style={styles.muted}>Opening in browser…</Text>
      </View>
    );
  }

  if (mode === 'no-internet') {
    return (
      <View style={styles.center}>
        <Text style={styles.noInternetIcon}>📡</Text>
        <Text style={styles.noInternetTitle}>Internet connection required</Text>
        <Text style={styles.muted}>
          This lesson hasn't been downloaded for offline use.{'\n'}
          Connect to the internet to watch this lesson.
        </Text>
        <Pressable style={[styles.btn, { marginTop: 8 }]} onPress={() => router.back()}>
          <Text style={styles.btnText}>Go back</Text>
        </Pressable>
        <Pressable style={[styles.btn, styles.btnSecondary, { marginTop: 4 }]} onPress={handleGoToDownloads}>
          <Text style={[styles.btnText, { color: '#1D3D47' }]}>View Downloads</Text>
        </Pressable>
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

  if (FORCE_ANDROID_WEBVIEW_PLAYER && mode === 'online') {
    return (
      <View style={styles.center}>
        <ActivityIndicator size="large" />
        <Text style={styles.muted}>Opening in browser…</Text>
      </View>
    );
  }

  return (
    <VideoPlayer
      source={source!}
      drm={drm as Record<string, any> | undefined}
      chapter={chapter}
      mode={mode as 'online' | 'offline'}
      offline={offline}
      download={download}
      chapterId={chapterId ?? ''}
      initialPositionSeconds={initialPositionSeconds}
      onDownload={handleDownload}
      onDelete={handleDeleteDownload}
      onGoToDownloads={handleGoToDownloads}
    />
  );
}

// ─── DownloadControls ─────────────────────────────────────────────────────────

function DownloadControls({
  download,
  offline,
  offlineDownload,
  onDownload,
  onDelete,
  onGoToDownloads,
}: {
  download: DownloadInfo | null;
  offline: boolean;
  offlineDownload: DownloadInfo | null;
  onDownload: () => void;
  onDelete: () => void;
  onGoToDownloads: () => void;
}) {
  const licExpired = isLicenseExpired(offlineDownload?.downloadedAt);

  if (offline || download?.state === 'completed') {
    return (
      <View style={styles.actionRow}>
        <View style={styles.downloadedRow}>
          <Text style={styles.downloadedLabel}>Downloaded ✓</Text>
        </View>
        <View style={styles.actionBtnRow}>
          <Pressable style={[styles.btn, styles.btnSecondary]} onPress={onGoToDownloads}>
            <Text style={[styles.btnText, { color: '#1D3D47' }]}>Go To Downloads</Text>
          </Pressable>
          <Pressable style={[styles.btn, styles.btnDanger]} onPress={onDelete}>
            <Text style={styles.btnText}>Remove Download</Text>
          </Pressable>
        </View>
        {licExpired && (
          <Text style={styles.licWarn}>
            ⚠ Offline license expired. Open the chapter online to renew.
          </Text>
        )}
      </View>
    );
  }

  if (download && (download.state === 'downloading' || download.state === 'queued')) {
    const pct = download.percentDownloaded >= 0 ? `${Math.round(download.percentDownloaded)}%` : '…';
    return (
      <View style={styles.actionRow}>
        <Text style={styles.muted}>Downloading {pct}</Text>
        <Pressable style={[styles.btn, styles.btnSecondary]} onPress={onGoToDownloads}>
          <Text style={[styles.btnText, { color: '#1D3D47' }]}>Go To Downloads</Text>
        </Pressable>
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
      <Pressable style={[styles.btn, styles.btnDownload]} onPress={onDownload}>
        <Text style={styles.btnText}>⬇  Download for Offline Viewing</Text>
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
  actionRow: { padding: 12, gap: 8 },
  actionBtnRow: { flexDirection: 'row', flexWrap: 'wrap', gap: 8 },
  downloadedRow: { flexDirection: 'row', alignItems: 'center', gap: 6 },
  downloadedLabel: { color: '#4CAF50', fontSize: 14, fontWeight: '600' },
  licWarn: { color: '#FFD54F', fontSize: 12, marginTop: 4 },
  btn: {
    backgroundColor: '#1D3D47',
    paddingHorizontal: 14,
    paddingVertical: 10,
    borderRadius: 8,
    alignSelf: 'flex-start',
  },
  btnSecondary: {
    backgroundColor: 'rgba(255,255,255,0.12)',
    borderWidth: 1,
    borderColor: 'rgba(255,255,255,0.25)',
  },
  btnDownload: {
    backgroundColor: '#1D3D47',
    paddingHorizontal: 16,
    paddingVertical: 12,
  },
  btnDanger: { backgroundColor: 'rgba(163,59,59,0.8)' },
  btnText: { color: '#fff', fontWeight: '600', fontSize: 13 },
  muted: { color: 'rgba(255,255,255,0.6)', fontSize: 13 },
  error: { color: '#f88', fontSize: 14 },
  noInternetIcon: { fontSize: 40, marginBottom: 8 },
  noInternetTitle: { fontSize: 18, fontWeight: '700', color: '#fff', textAlign: 'center' },
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
