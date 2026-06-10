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

import { useIsFocused } from 'expo-router';
import * as FileSystem from 'expo-file-system';
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
  type Chapter,
  type MuxTokenResponse,
  fetchChapter,
  selectMuxPlaybackId,
  getMuxTokenWithJwt,
  getMuxDownloadToken,
} from '../../api/base44Client';
import { waitForPlayerData, type BridgeResult } from '../../api/playerCache';
import { requestWebViewTokens, getAuthJwt } from '../(tabs)/explore';
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

/** Synthesise a minimal Chapter object from locally-stored DownloadInfo.
 *  Used on the offline path so no network call is required. */
function chapterFromDownload(id: string, info: DownloadInfo): Chapter {
  return {
    _id: id,
    title: info.title ?? id,
    muxPlaybackId: null,
    muxSignedPlaybackId: null,
    muxDrmPlaybackId: null,
    muxDrmProtected: false,
    muxSignedPlaybackRequired: false,
  } as unknown as Chapter;
}

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
  isDownloadPending: boolean;
  onDownload: () => void;
  onDelete: () => void;
  onGoToDownloads: () => void;
  onRenewLicense: () => void;
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
  isDownloadPending,
  onDownload,
  onDelete,
  onGoToDownloads,
  onRenewLicense,
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
        isDownloadPending={isDownloadPending}
        onDownload={onDownload}
        onDelete={onDelete}
        onGoToDownloads={onGoToDownloads}
        onRenewLicense={onRenewLicense}
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
  // Guard: true while handleDownload is running — prevents concurrent executions.
  const [isDownloadPending, setIsDownloadPending] = useState(false);

  // ── initial load ──
  useEffect(() => {
    let cancelled = false;
    let cancelWait: (() => void) | null = null;

    (async () => {
      try {
        if (!chapterId) throw new Error('Missing chapterId');
        console.log(`[player] initialLoad START — chapterId=${chapterId} platform=${Platform.OS}`);

        // 1) Restore last-watched position
        const savedProg = await getProgress(chapterId);
        if (!cancelled && savedProg && savedProg.watchedSeconds > 5) {
          setInitialPositionSeconds(savedProg.watchedSeconds);
        }

        // 2) Check for offline copy — fully local, zero network calls.
        const [off, dlInfo] = await Promise.all([
          IcareOfflineDrm.getOfflineSource({ id: chapterId }),
          IcareOfflineDrm.getDownload(chapterId),
        ]);
        if (cancelled) return;
        console.log(`[player] initialLoad: offlineSource=${off ? 'FOUND' : 'null'} dlInfo=${dlInfo ? dlInfo.state : 'null'}`);

        if (off) {
          // Offline DRM path: launch native ExoPlayer Activity with the persisted
          // keySetId. react-native-video does not support offline DRM license restore
          // (its DRMProps parser ignores offlineLicense and requires licenseServer).
          console.log(`[player] initialLoad: offline copy found — launching native OfflinePlayerActivity`);
          const ch = dlInfo ? chapterFromDownload(chapterId, dlInfo) : { _id: chapterId, title: chapterId } as unknown as Chapter;
          setChapter(ch);
          setDownload(dlInfo);
          try {
            await IcareOfflineDrm.launchOfflinePlayer(chapterId);
            // Activity launched — go back so the downloads screen is visible behind it.
            if (!cancelled) router.back();
          } catch (launchErr: any) {
            console.error(`[player] launchOfflinePlayer failed: ${launchErr?.message}`);
            // Fall through to show error — don't try streaming if device is offline.
            throw launchErr;
          }
          return;
        }

        // 3) No offline copy — wait for tokens from WebView bridge.
        console.log(`[player] initialLoad: no offline copy — waiting for playerCache delivery`);
        const handle = waitForPlayerData(chapterId);
        cancelWait = handle.cancel;

        const result: BridgeResult = await handle.promise;
        if (cancelled) return;
        cancelWait = null;
        console.log(`[player] initialLoad: playerCache resolved ok=${result.ok}`);

        if (result.ok) {
          setChapter(result.data.chapter);
          setTokens(result.data.tokens);
          if (FORCE_ANDROID_WEBVIEW_PLAYER) {
            setMode('webview-fallback');
          } else {
            setMode('online');
          }
          console.log(`[player] initialLoad: → mode=${FORCE_ANDROID_WEBVIEW_PLAYER ? 'webview-fallback' : 'online'} tokens=SET`);
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
      console.log(`[player] onDownloadProgress id=${evt.id} state=${evt.state} bytes=${evt.bytesDownloaded} pct=${evt.percentDownloaded?.toFixed(1)}`);
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

  // ── token resolver: use already-held tokens or request fresh ones ──
  // Root cause of 20s timeout: when the player is a Stack screen on top of
  // the (tabs) screen, Android suspends the WebView postMessage bridge for
  // the backgrounded tab screen. injectJavaScript fires but CHAPTER_TOKENS
  // never arrives back in onMessage. Always prefer the tokens already in
  // component state (delivered synchronously at chapter-open time) before
  // falling back to the WebView bridge.
  const resolveTokens = useCallback(async (): Promise<MuxTokenResponse | null> => {
    console.log(`[player] resolveTokens ENTER — chapterId=${chapterId} tokens=${tokens ? 'SET' : 'NULL'}`);

    // Fast path: tokens are already in state from the chapter-open flow.
    // This avoids the WebView bridge entirely — critical on Android where
    // postMessage from a backgrounded Stack screen is unreliable.
    if (tokens) {
      console.log(`[player] resolveTokens: FAST-PATH — returning tokens from state for ${chapterId}`);
      return tokens;
    }

    // JWT-direct path: use the auth JWT captured from the WebView while it was
    // foregrounded to call getMuxToken natively — bypasses backgrounded WebView
    // entirely. Needed for re-download / license renewal from offline mode.
    const jwt = getAuthJwt();
    if (jwt) {
      console.log(`[player] resolveTokens: JWT-PATH — fetching chapter + getMuxToken natively for ${chapterId}`);
      const { data: ch } = await fetchChapter(chapterId!);
      const playbackId = selectMuxPlaybackId(ch);
      if (!playbackId) throw new Error('Chapter has no Mux playback ID');
      const tk = await getMuxTokenWithJwt(playbackId, jwt);
      console.log(`[player] resolveTokens: JWT-PATH success`);
      return tk;
    }

    // Slow path: only reached when player opened without prior token delivery
    // (e.g. offline→delete→resume, or direct deep-link navigation).
    console.log(`[player] resolveTokens: SLOW-PATH — requesting from WebView bridge for ${chapterId}`);
    console.log(`[player] resolveTokens: calling requestWebViewTokens…`);
    const dispatched = requestWebViewTokens(chapterId!);
    console.log(`[player] resolveTokens: requestWebViewTokens returned ${dispatched} (_tokenRequester ${dispatched ? 'SET' : 'NULL'})`);

    if (!dispatched) {
      console.warn(`[player] resolveTokens: ExploreScreen not mounted — cannot request tokens`);
      return null;
    }

    console.log(`[player] resolveTokens: waiting for playerCache delivery (${20}s timeout)…`);
    const handle = waitForPlayerData(chapterId!);
    const result = await handle.promise;
    console.log(`[player] resolveTokens: playerCache resolved ok=${result.ok}${result.ok ? '' : ` error=${(result as any).error}`}`);

    if (!result.ok) throw new Error(result.error);
    console.log(`[player] resolveTokens: SLOW-PATH success — tokens delivered`);
    return result.data.tokens;
  }, [tokens, chapterId]);

  // ── download handler ──
  const handleDownload = useCallback(async () => {
    if (!chapter || !chapterId) return;
    if (isDownloadPending) return;

    setIsDownloadPending(true);
    try {
      // Storage pre-check: require at least 500 MB free before starting.
      const MIN_FREE_BYTES = 500 * 1024 * 1024;
      try {
        const free = await FileSystem.getFreeDiskStorageAsync();
        if (typeof free === 'number' && free < MIN_FREE_BYTES) {
          const freeMb = Math.round(free / (1024 * 1024));
          Alert.alert(
            'Not enough storage',
            `Only ${freeMb} MB available. Please free up at least 500 MB and try again.`,
          );
          return;
        }
      } catch {
        // Storage check failed — proceed anyway, ExoPlayer will catch a full disk.
      }

      // Offline download always uses the /download endpoint so DRM chapters receive
      // a Widevine-PSSH-bearing manifest and a persistent offline license token.
      // selectMuxPlaybackId() picks DRM > Signed > Public — same priority as streaming.
      const playbackId = selectMuxPlaybackId(chapter);
      if (!playbackId) {
        Alert.alert('Download failed', 'Chapter has no Mux playback ID.');
        return;
      }

      const jwt = getAuthJwt();
      const dlTokens = await getMuxDownloadToken(playbackId, jwt ?? undefined);

      console.log(
        `[OFFLINE-DRM]\nchapterId=${chapterId}\nplaybackId=${playbackId}` +
        `\nmanifestUrl=${dlTokens.manifestUrl ?? 'null'}` +
        `\ndrmLicenseUrl=${dlTokens.widevineLicenseUrl ?? 'null'}` +
        `\ndrmTokenPresent=${!!dlTokens.drmToken}`
      );

      if (!dlTokens.manifestUrl) {
        Alert.alert('Download failed', 'Could not resolve manifest URL for this chapter.');
        return;
      }

      await IcareOfflineDrm.startDownload({
        id:            chapterId,
        manifestUrl:   dlTokens.manifestUrl,
        drmLicenseUrl: dlTokens.widevineLicenseUrl ?? '',
        drmToken:      dlTokens.drmToken ?? '',
        title:         chapter.title,
        thumbnailUrl:  (chapter as any).videoPosterUrl ?? undefined,
        durationSeconds: (chapter as any).estimatedMinutes
          ? Math.round((chapter as any).estimatedMinutes * 60)
          : undefined,
      });
    } catch (err: any) {
      console.error(`[player] handleDownload: FAILED — ${err?.message}`);
      Alert.alert('Download failed', err?.message ?? String(err));
    } finally {
      setIsDownloadPending(false);
    }
  }, [chapter, chapterId, isDownloadPending]);

  // ── delete-download handler ──
  // Uses resolveTokens() so the fast-path (tokens already in state) is taken
  // on Android, where the backgrounded WebView postMessage bridge is unreliable.
  const handleDeleteDownload = useCallback(async () => {
    if (!chapterId) return;
    console.log(`[player] handleDeleteDownload: removing download for ${chapterId}`);
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
    console.log(`[player] handleDeleteDownload: resolving tokens for ${chapterId}`);

    let tk: MuxTokenResponse | null = null;
    try {
      tk = await resolveTokens();
    } catch (err: any) {
      console.error(`[player] handleDeleteDownload: resolveTokens threw: ${err?.message}`);
      setErrorMsg(err?.message ?? 'Could not resume streaming');
      setMode('error');
      return;
    }

    if (!tk) {
      console.warn(`[player] handleDeleteDownload: resolveTokens returned null`);
      setErrorMsg('Please return to the course page and tap the chapter again.');
      setMode('error');
      return;
    }

    console.log(`[player] handleDeleteDownload: tokens resolved — resuming streaming`);
    setTokens(tk);
    if (FORCE_ANDROID_WEBVIEW_PLAYER) {
      setMode('webview-fallback');
    } else {
      setMode('online');
    }
  }, [chapter, chapterId, resolveTokens]);

  // ── Go to downloads ──
  const handleGoToDownloads = useCallback(() => {
    router.push('/(tabs)/downloads' as any);
  }, [router]);

  // ── Renew offline DRM license ──
  const handleRenewLicense = useCallback(async () => {
    if (!chapterId || isDownloadPending) return;
    setIsDownloadPending(true);
    try {
      const tk = await resolveTokens();
      if (!tk) {
        Alert.alert('Renewal failed', 'Please return to the course page and try again.');
        return;
      }
      await IcareOfflineDrm.renewOfflineLicense(chapterId, tk.drmLicenseUrl, tk.drmToken);
      // Force re-check so the UI reflects the renewed license.
      const updated = await IcareOfflineDrm.getDownload(chapterId);
      if (updated) setDownload(updated);
      Alert.alert('License renewed', 'Your offline license has been renewed for 30 days.');
    } catch (err: any) {
      Alert.alert('Renewal failed', err?.message ?? String(err));
    } finally {
      setIsDownloadPending(false);
    }
  }, [chapterId, isDownloadPending, resolveTokens]);

  // ── webview-fallback navigation ── (disabled: show download UI instead of going back)
  // Previously this navigated back immediately, but that meant Android users
  // had no way to trigger a download. Now we stay on screen and show controls.

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
      <View style={[styles.center, { justifyContent: 'flex-start', paddingTop: 40, paddingHorizontal: 24 }]}>
        <Text style={[styles.muted, { fontSize: 18, fontWeight: '700', color: '#fff', marginBottom: 8, textAlign: 'center' }]}>
          {chapter?.title ?? 'Chapter'}
        </Text>
        <Text style={[styles.muted, { marginBottom: 32, textAlign: 'center' }]}>
          Watch this chapter in the Learn tab. You can download it here for offline viewing.
        </Text>
        <DownloadControls
          download={download}
          offline={false}
          offlineDownload={download}
          isDownloadPending={isDownloadPending}
          onDownload={handleDownload}
          onDelete={handleDeleteDownload}
          onGoToDownloads={handleGoToDownloads}
          onRenewLicense={handleRenewLicense}
        />
        <Pressable style={[styles.btn, styles.btnSecondary, { marginTop: 16 }]} onPress={() => router.back()}>
          <Text style={[styles.btnText, { color: '#1D3D47' }]}>Go Back</Text>
        </Pressable>
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
    return null;
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
      isDownloadPending={isDownloadPending}
      onDownload={handleDownload}
      onDelete={handleDeleteDownload}
      onGoToDownloads={handleGoToDownloads}
      onRenewLicense={handleRenewLicense}
    />
  );
}

// ─── DownloadControls ─────────────────────────────────────────────────────────

function DownloadControls({
  download,
  offline,
  offlineDownload,
  isDownloadPending,
  onDownload,
  onDelete,
  onGoToDownloads,
  onRenewLicense,
}: {
  download: DownloadInfo | null;
  offline: boolean;
  offlineDownload: DownloadInfo | null;
  isDownloadPending: boolean;
  onDownload: () => void;
  onDelete: () => void;
  onGoToDownloads: () => void;
  onRenewLicense: () => void;
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
          <View style={styles.actionBtnRow}>
            <Text style={styles.licWarn}>⚠ Offline license expired.</Text>
            <Pressable
              style={[styles.btn, isDownloadPending && styles.btnDisabled]}
              onPress={onRenewLicense}
              disabled={isDownloadPending}
            >
              <Text style={styles.btnText}>
                {isDownloadPending ? 'Renewing…' : '↺ Renew License'}
              </Text>
            </Pressable>
          </View>
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
        <Pressable
          style={[styles.btn, isDownloadPending && styles.btnDisabled]}
          onPress={onDownload}
          disabled={isDownloadPending}
        >
          <Text style={styles.btnText}>{isDownloadPending ? 'Starting…' : 'Retry'}</Text>
        </Pressable>
      </View>
    );
  }

  return (
    <View style={styles.actionRow}>
      <Pressable
        style={[styles.btn, styles.btnDownload, isDownloadPending && styles.btnDisabled]}
        onPress={onDownload}
        disabled={isDownloadPending}
      >
        <Text style={styles.btnText}>
          {isDownloadPending ? '⏳  Preparing download…' : '⬇  Download for Offline Viewing'}
        </Text>
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
  btnDisabled: { opacity: 0.55 },
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
