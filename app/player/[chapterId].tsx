import { useLocalSearchParams, useRouter } from 'expo-router';
import { useEffect, useMemo, useRef, useState } from 'react';
import {
  ActivityIndicator,
  Alert,
  Pressable,
  StyleSheet,
  Text,
  View,
} from 'react-native';
import Video, { type VideoRef, type ReactVideoSource, type DRMType } from 'react-native-video';

import { fetchChapter, getMuxToken } from '../../api/base44Client';
import IcareOfflineDrm, {
  onDownloadProgress,
  type DownloadInfo,
  type OfflinePlaybackSource,
} from '../../modules/icare-offline-drm';

type Mode = 'loading' | 'online' | 'offline' | 'error';

interface ChapterMeta {
  id: string;
  title?: string;
  muxPlaybackId?: string;
  muxDrmProtected?: boolean;
  muxSignedPlaybackRequired?: boolean;
  videoPosterUrl?: string;
}

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

  const [mode, setMode] = useState<Mode>('loading');
  const [errorMsg, setErrorMsg] = useState<string | null>(null);
  const [chapter, setChapter] = useState<ChapterMeta | null>(null);
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
          // Still load chapter meta for the title/poster.
          const ch = await fetchChapter(chapterId);
          if (cancelled) return;
          setChapter({ id: chapterId, ...ch.data });
          setOffline(off);
          setMode('offline');
          return;
        }

        // 2) Online flow: fetch chapter, then signed Mux tokens.
        const ch = await fetchChapter(chapterId);
        if (cancelled) return;
        if (ch.status !== 200) throw new Error(`Chapter fetch ${ch.status}`);
        const meta: ChapterMeta = { id: chapterId, ...ch.data };
        setChapter(meta);

        if (!meta.muxPlaybackId) {
          throw new Error('Chapter has no muxPlaybackId');
        }

        const tk = await getMuxToken(meta.muxPlaybackId);
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

  // ----- Build the Video source. -----
  const source: ReactVideoSource | null = useMemo(() => {
    if (mode === 'offline' && offline) {
      return {
        uri: offline.uri,
        type: 'm3u8',
        // react-native-video honors `cacheKey` to look the asset up from
        // ExoPlayer's cache. The DRM block uses the offline keySetId so
        // ExoPlayer doesn't hit the license server.
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
        // Tell ExoPlayer to use the persisted offline license — no network
        // license request happens for the offline path.
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
    if (!chapter || !chapter.muxPlaybackId) return;
    try {
      // Always fetch fresh tokens before initiating an offline license request.
      const tk = await getMuxToken(chapter.muxPlaybackId);
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
    // Re-resolve to fall back to online.
    if (chapter?.muxPlaybackId) {
      try {
        const tk = await getMuxToken(chapter.muxPlaybackId);
        setTokens(tk);
        setMode('online');
      } catch (err: any) {
        setErrorMsg(err?.message ?? String(err));
        setMode('error');
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

  return (
    <View style={styles.container}>
      <View style={styles.playerWrap}>
        {source && (
          <Video
            ref={videoRef}
            source={source}
            drm={drm}
            controls
            resizeMode="contain"
            style={StyleSheet.absoluteFill}
            onError={(e: any) => {
              console.warn('[player] error', e);
              Alert.alert('Playback error', JSON.stringify(e?.error ?? e));
            }}
          />
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
    </View>
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
  playerWrap: { aspectRatio: 16 / 9, backgroundColor: '#000', position: 'relative' },
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
});
