import { useLocalSearchParams, useRouter } from 'expo-router';
import { activateKeepAwakeAsync, deactivateKeepAwake } from 'expo-keep-awake';
import { useEffect, useMemo, useRef, useState } from 'react';
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
import { getItemAsync, setItemAsync } from 'expo-secure-store';
import { GestureDetector, Gesture, GestureHandlerRootView } from 'react-native-gesture-handler';
import Video, { type VideoRef, type ReactVideoSource, type DRMType } from 'react-native-video';
import {
  fetchChapter,
  getMuxToken,
  selectMuxPlaybackId,
  type Chapter,
} from '../../api/base44Client';
import IcareOfflineDrm, {
  onDownloadProgress,
  type DownloadInfo,
  type OfflinePlaybackSource,
} from '../../modules/icare-offline-drm';

type Mode = 'loading' | 'online' | 'offline' | 'error';

interface MuxTokenResponse {
  token: string;
  drmToken: string;
  drmLicenseUrl: string;
  secureStreamUrl: string;
}

export default function ChapterPlayerScreen() {
  const { chapterId } = useLocalSearchParams<{ chapterId: string }>();
  const router = useRouter();
  const videoRef = useRef<VideoRef>(null);
  const { width } = useWindowDimensions();
  const [isFullscreen, setIsFullscreen] = useState(false);

  const [mode, setMode] = useState<Mode>('loading');
  const [isPlaying, setIsPlaying] = useState(false);
  const [errorMsg, setErrorMsg] = useState<string | null>(null);
  const [audioToastVisible, setAudioToastVisible] = useState(false);
  const audioToastOpacity = useRef(new Animated.Value(0)).current;
  const [chapter, setChapter] = useState<Chapter | null>(null);
  const [tokens, setTokens] = useState<MuxTokenResponse | null>(null);
  const [offline, setOffline] = useState<OfflinePlaybackSource | null>(null);
  const [download, setDownload] = useState<DownloadInfo | null>(null);

  // ----- Initial load: prefer offline source, fall back to online streaming.
  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        if (!chapterId) throw new Error('Missing chapterId');

        // 1) Check for an existing offline copy + license.
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

        // 2) Online flow: fetch chapter, then signed Mux tokens.
        const ch = await fetchChapter(chapterId);
        if (cancelled) return;
        if (ch.status !== 200) throw new Error(`Chapter fetch ${ch.status}`);

        const meta = ch.data;
        setChapter(meta);

        // 3) Select the correct Mux playback ID.
        //    Priority: DRM playback ID > Signed playback ID > Public playback ID.
        //    Using the wrong ID causes unsigned streams or failed DRM license requests.
        const playbackId = selectMuxPlaybackId(meta);
        if (!playbackId) {
          throw new Error('Chapter has no Mux playback ID configured');
        }

        const tk = await getMuxToken(playbackId);
        if (cancelled) return;
        setTokens(tk);
        setMode('online');
      } catch (err: any) {
        if (cancelled) return;
        setErrorMsg(err?.message ?? String(err));
        setMode('error');
      }
    })();
    return () => { cancelled = true; };
  }, [chapterId]);

  // ----- Subscribe to download progress for this chapter.
  useEffect(() => {
    if (!chapterId) return;
    const sub = onDownloadProgress((evt) => {
      if (evt.id === chapterId) setDownload(evt);
    });
    IcareOfflineDrm.getDownload(chapterId).then((d) => {
      if (d) setDownload(d);
    });
    return () => sub.remove();
  }, [chapterId]);

  // ----- Audio language toast: show once per device if multiple tracks found. -----
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

  // ----- Keep screen awake while playing, release on pause/end/unmount. -----
  useEffect(() => {
    const TAG = 'video-player';
    if (isPlaying) {
      activateKeepAwakeAsync(TAG);
    } else {
      deactivateKeepAwake(TAG);
    }
    return () => { deactivateKeepAwake(TAG); };
  }, [isPlaying]);

  // ----- Build the Video source. -----
  const source: ReactVideoSource | null = useMemo(() => {
    if (mode === 'offline' && offline) {
      return {
        uri: offline.uri,
        type: 'm3u8',
        cacheKey: offline.cacheKey,
      } as ReactVideoSource;
    }
    if (mode === 'online' && tokens) {
      return { uri: tokens.secureStreamUrl, type: 'm3u8' } as ReactVideoSource;
    }
    return null;
  }, [mode, offline, tokens]);

  // ----- DRM block -----
  const drm = useMemo(() => {
    if (mode === 'offline' && offline) {
      return {
        type: 'widevine' as DRMType,
        offlineLicense: offline.offlineLicenseKeySetId,
      };
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

  const handleDownload = async () => {
    if (!chapter) return;
    const playbackId = selectMuxPlaybackId(chapter);
    if (!playbackId) return;
    try {
      const tk = await getMuxToken(playbackId);
      await IcareOfflineDrm.startDownload({
        id: chapter.id,
        manifestUrl: tk.secureStreamUrl,
        drmLicenseUrl: tk.drmLicenseUrl,
        drmToken: tk.drmToken,
        title: chapter.title,
      });
    } catch (err: any) {
      Alert.alert('Download failed', err?.message ?? String(err));
    }
  };

  const handleDeleteDownload = async () => {
    if (!chapterId) return;
    await IcareOfflineDrm.removeDownload(chapterId);
    setDownload(null);
    setOffline(null);
    if (chapter) {
      const playbackId = selectMuxPlaybackId(chapter);
      if (playbackId) {
        try {
          const tk = await getMuxToken(playbackId);
          setTokens(tk);
          setMode('online');
        } catch (err: any) {
          setErrorMsg(err?.message ?? String(err));
          setMode('error');
        }
      }
    }
  };

  // ----- Render -----
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

  // Pinch gesture: spreading fingers → fullscreen, pinching in → exit fullscreen
  const pinchGesture = Gesture.Pinch()
    .runOnJS(true)
    .onEnd((e) => {
      if (e.scale > 1.2 && !isFullscreen) {
        setIsFullscreen(true);
        videoRef.current?.presentFullscreenPlayer();
      } else if (e.scale < 0.8 && isFullscreen) {
        setIsFullscreen(false);
        videoRef.current?.dismissFullscreenPlayer();
      }
    });

  // Natural player height based on screen width, 16:9
  const playerHeight = (width / 16) * 9;

  return (
    <GestureHandlerRootView style={styles.container}>
      <GestureDetector gesture={pinchGesture}>
        <View style={[styles.playerWrap, { width, height: playerHeight }]}>
          {source && (
            <Video
              ref={videoRef}
              source={source}
              drm={drm}
              controls
              resizeMode="contain"
              fullscreen={isFullscreen}
              onFullscreenPlayerDidDismiss={() => setIsFullscreen(false)}
              onLoad={handleVideoLoad}
              onPlaybackStateChanged={({ isPlaying: playing }) => setIsPlaying(playing)}
              onEnd={() => setIsPlaying(false)}
              style={StyleSheet.absoluteFill}
              onError={(e: any) => {
                setIsPlaying(false);
                console.warn('[player] error', e);
                Alert.alert('Playback error', JSON.stringify(e?.error ?? e));
              }}
            />
          )}
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
      </GestureDetector>

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

const styles = StyleSheet.create({
  container: { flex: 1, backgroundColor: '#000' },
  playerWrap: { backgroundColor: '#000', position: 'relative' },
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
  audioToastText: {
    color: '#fff',
    fontSize: 13,
    flex: 1,
    lineHeight: 18,
  },
  audioToastDismiss: {
    color: 'rgba(255,255,255,0.6)',
    fontSize: 16,
    paddingHorizontal: 4,
  },
});
