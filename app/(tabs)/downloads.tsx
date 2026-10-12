import { Ionicons } from '@expo/vector-icons';
import { useRouter, type Href } from 'expo-router';
import { useCallback, useEffect, useState } from 'react';
import {
  ActivityIndicator,
  Alert,
  FlatList,
  Platform,
  Pressable,
  RefreshControl,
  StyleSheet,
  Text,
  View,
} from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { fetchChapter } from '../../api/base44Client';
import IcareOfflineDrm, {
  onDownloadProgress,
  type DownloadInfo,
} from '../../modules/icare-offline-drm';

function LegacyDownloadsScreen() {
  const router = useRouter();
  const [items, setItems] = useState<DownloadInfo[]>([]);
  const [loading, setLoading] = useState(true);
  const [refreshing, setRefreshing] = useState(false);

  const load = useCallback(async () => {
    try {
      const list = await IcareOfflineDrm.listDownloads();
      setItems(list);
    } finally {
      setLoading(false);
      setRefreshing(false);
    }
  }, []);

  useEffect(() => { load(); }, [load]);

  // Live updates from the DownloadService.
  useEffect(() => {
    const sub = onDownloadProgress((evt) => {
      setItems((prev) => {
        const idx = prev.findIndex((d) => d.id === evt.id);
        if (idx === -1) return [evt, ...prev];
        const next = [...prev];
        next[idx] = evt;
        return next;
      });
    });
    return () => sub.remove();
  }, []);

  const remove = async (id: string) => {
    await IcareOfflineDrm.removeDownload(id);
    setItems((prev) => prev.filter((d) => d.id !== id));
  };

  if (loading) {
    return (
      <View style={styles.center}>
        <ActivityIndicator />
      </View>
    );
  }

  if (items.length === 0) {
    return (
      <View style={styles.center}>
        <Text style={styles.emptyTitle}>No downloads yet</Text>
        <Text style={styles.muted}>
          Open a chapter and tap "Download for offline".
        </Text>
      </View>
    );
  }

  return (
    <FlatList
      data={items}
      keyExtractor={(d) => d.id}
      contentContainerStyle={{ padding: 12 }}
      refreshControl={
        <RefreshControl
          refreshing={refreshing}
          onRefresh={() => { setRefreshing(true); load(); }}
        />
      }
      ListHeaderComponent={
        <Text style={styles.listHeader}>
          {items.length} downloaded {items.length === 1 ? 'chapter' : 'chapters'}
        </Text>
      }
      renderItem={({ item }) => (
        <View style={styles.row}>
          <Pressable
            style={{ flex: 1 }}
            onPress={() =>
              router.push({
                pathname: '/player/[chapterId]',
                params: { chapterId: item.id },
              } as unknown as Href)
            }>
            {/* Show chapter title if available, fall back to ID */}
            <Text style={styles.title} numberOfLines={2}>
              {(item as any).title ?? item.id}
            </Text>
            <Text style={styles.statusText}>
              <StatusDot state={item.state} />
              {'  '}
              {stateLabel(item)}
            </Text>
          </Pressable>
          <Pressable
            style={[styles.btn, styles.btnDanger]}
            onPress={() => remove(item.id)}>
            <Text style={styles.btnText}>Remove</Text>
          </Pressable>
        </View>
      )}
    />
  );
}

// ─── Entry point ─────────────────────────────────────────────────────────────
// Android keeps the original screen unchanged; iOS gets the themed version.
export default function DownloadsScreen() {
  return Platform.OS === 'ios' ? <IosDownloadsScreen /> : <LegacyDownloadsScreen />;
}

// ─── iOS version ─────────────────────────────────────────────────────────────

const C = {
  bg: '#160d28',
  card: '#231638',
  border: '#3a2658',
  accent: '#7a45a8',
  text: '#ffffff',
  muted: 'rgba(255,255,255,0.62)',
  danger: '#e5484d',
  ok: '#3ecf8e',
  info: '#6aa8ff',
};

function IosDownloadsScreen() {
  const router = useRouter();
  const insets = useSafeAreaInsets();
  const [items, setItems] = useState<DownloadInfo[]>([]);
  const [titles, setTitles] = useState<Record<string, string>>({});
  const [loading, setLoading] = useState(true);
  const [refreshing, setRefreshing] = useState(false);

  const load = useCallback(async () => {
    try {
      const list = await IcareOfflineDrm.listDownloads();
      setItems(list);
    } catch {
      setItems([]);
    } finally {
      setLoading(false);
      setRefreshing(false);
    }
  }, []);

  useEffect(() => { load(); }, [load]);

  // Live progress from the native module.
  useEffect(() => {
    const sub = onDownloadProgress((evt) => {
      setItems((prev) => {
        if (evt.state === 'removing') return prev.filter((d) => d.id !== evt.id);
        const idx = prev.findIndex((d) => d.id === evt.id);
        if (idx === -1) return [evt, ...prev];
        const next = [...prev];
        next[idx] = evt;
        return next;
      });
    });
    return () => sub.remove();
  }, []);

  // Resolve lesson titles (the native record only knows the id until it is
  // rebuilt with titles). Public chapter lookup; cached per id.
  useEffect(() => {
    let cancelled = false;
    items.forEach((d) => {
      const native = (d as any).title as string | undefined;
      if (native || titles[d.id]) return;
      fetchChapter(d.id)
        .then((r) => {
          const t = r?.data?.title;
          if (!cancelled && t) setTitles((prev) => ({ ...prev, [d.id]: t }));
        })
        .catch(() => {});
    });
    return () => { cancelled = true; };
  }, [items, titles]);

  const confirmRemove = (item: DownloadInfo) => {
    Alert.alert(
      'Remove download?',
      'The lesson will no longer be available offline.',
      [
        { text: 'Cancel', style: 'cancel' },
        {
          text: 'Remove',
          style: 'destructive',
          onPress: async () => {
            await IcareOfflineDrm.removeDownload(item.id);
            setItems((prev) => prev.filter((d) => d.id !== item.id));
          },
        },
      ]
    );
  };

  const titleOf = (d: DownloadInfo) => (d as any).title ?? titles[d.id] ?? 'Lesson';
  const goBack = () => router.navigate('/(tabs)/explore' as unknown as Href);

  const header = (
    <View style={[iosStyles.header, { paddingTop: insets.top + 8 }]}>
      <Pressable onPress={goBack} hitSlop={12} style={iosStyles.backBtn}>
        <Ionicons name="chevron-back" size={24} color={C.text} />
      </Pressable>
      <Text style={iosStyles.headerTitle}>Downloads</Text>
      <View style={iosStyles.backBtn} />
    </View>
  );

  if (loading) {
    return (
      <View style={iosStyles.screen}>
        {header}
        <View style={iosStyles.center}><ActivityIndicator color={C.text} /></View>
      </View>
    );
  }

  return (
    <View style={iosStyles.screen}>
      {header}
      {items.length === 0 ? (
        <View style={iosStyles.center}>
          <Ionicons name="cloud-download-outline" size={56} color={C.muted} />
          <Text style={iosStyles.emptyTitle}>No downloads yet</Text>
          <Text style={iosStyles.muted}>
            Open a lesson and tap "Download for offline" to watch it without a connection.
          </Text>
        </View>
      ) : (
        <FlatList
          data={items}
          keyExtractor={(d) => d.id}
          contentContainerStyle={{ padding: 16, paddingBottom: insets.bottom + 24 }}
          refreshControl={
            <RefreshControl
              tintColor={C.text}
              refreshing={refreshing}
              onRefresh={() => { setRefreshing(true); load(); }}
            />
          }
          ListHeaderComponent={
            <Text style={iosStyles.listHeader}>
              {items.length} downloaded {items.length === 1 ? 'lesson' : 'lessons'}
            </Text>
          }
          renderItem={({ item }) => {
            const pct = item.percentDownloaded >= 0 ? Math.round(item.percentDownloaded) : 0;
            const inProgress = item.state === 'downloading' || item.state === 'queued';
            const playable = item.state === 'completed';
            return (
              <View style={iosStyles.row}>
                <Pressable
                  style={{ flex: 1 }}
                  disabled={!playable}
                  onPress={() =>
                    router.push({
                      pathname: '/player/[chapterId]',
                      params: { chapterId: item.id },
                    } as unknown as Href)
                  }>
                  <Text style={iosStyles.title} numberOfLines={2}>{titleOf(item)}</Text>
                  <Text style={iosStyles.statusText}>
                    <StatusDot state={item.state} />
                    {'  '}
                    {stateLabel(item)}
                  </Text>
                  {inProgress && (
                    <View style={iosStyles.progressTrack}>
                      <View style={[iosStyles.progressFill, { width: `${pct}%` }]} />
                    </View>
                  )}
                </Pressable>
                {playable && (
                  <Ionicons name="play-circle" size={30} color={C.accent} />
                )}
                <Pressable
                  accessibilityLabel="Remove download"
                  hitSlop={8}
                  onPress={() => confirmRemove(item)}>
                  <Ionicons name="trash-outline" size={22} color={C.danger} />
                </Pressable>
              </View>
            );
          }}
        />
      )}
    </View>
  );
}

const iosStyles = StyleSheet.create({
  screen: { flex: 1, backgroundColor: C.bg },
  header: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    paddingHorizontal: 12,
    paddingBottom: 12,
    borderBottomWidth: StyleSheet.hairlineWidth,
    borderBottomColor: C.border,
  },
  backBtn: { width: 36, alignItems: 'flex-start' },
  headerTitle: { color: C.text, fontSize: 18, fontWeight: '700' },
  center: { flex: 1, alignItems: 'center', justifyContent: 'center', padding: 32, gap: 10 },
  emptyTitle: { color: C.text, fontSize: 17, fontWeight: '700' },
  muted: { color: C.muted, fontSize: 14, textAlign: 'center', lineHeight: 20 },
  listHeader: { color: C.muted, fontSize: 13, marginBottom: 12, paddingHorizontal: 2 },
  row: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 14,
    padding: 14,
    borderRadius: 14,
    backgroundColor: C.card,
    borderWidth: StyleSheet.hairlineWidth,
    borderColor: C.border,
    marginBottom: 10,
  },
  title: { color: C.text, fontSize: 15, fontWeight: '600', lineHeight: 20 },
  statusText: { color: C.muted, fontSize: 12.5, marginTop: 4 },
  progressTrack: {
    height: 4,
    borderRadius: 2,
    backgroundColor: 'rgba(255,255,255,0.14)',
    marginTop: 8,
    overflow: 'hidden',
  },
  progressFill: { height: 4, backgroundColor: C.accent },
});

function StatusDot({ state }: { state: string }) {
  const color =
    state === 'completed' ? '#4CAF50'
    : state === 'downloading' ? '#2196F3'
    : state === 'failed' ? '#f44336'
    : '#888';
  return <Text style={{ color }}>●</Text>;
}

function stateLabel(item: DownloadInfo): string {
  if (item.state === 'completed') return 'Ready for offline';
  if (item.state === 'downloading' && item.percentDownloaded >= 0) {
    return `Downloading ${Math.round(item.percentDownloaded)}%`;
  }
  if (item.state === 'queued') return 'Queued…';
  if (item.state === 'failed') return `Failed${item.failureReason ? ': ' + item.failureReason : ''}`;
  return item.state;
}

const styles = StyleSheet.create({
  center: {
    flex: 1,
    alignItems: 'center',
    justifyContent: 'center',
    padding: 24,
    gap: 8,
  },
  emptyTitle: {
    fontSize: 16,
    fontWeight: '600',
    color: '#333',
  },
  listHeader: {
    fontSize: 13,
    color: '#888',
    marginBottom: 8,
    paddingHorizontal: 4,
  },
  row: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 12,
    padding: 12,
    borderRadius: 10,
    backgroundColor: '#fff',
    marginBottom: 8,
    elevation: 1,
    shadowColor: '#000',
    shadowOffset: { width: 0, height: 1 },
    shadowOpacity: 0.06,
    shadowRadius: 3,
  },
  title: {
    fontSize: 14,
    fontWeight: '600',
    color: '#1a1a1a',
    lineHeight: 19,
  },
  statusText: {
    fontSize: 12,
    color: '#666',
    marginTop: 3,
  },
  muted: {
    fontSize: 13,
    opacity: 0.65,
    textAlign: 'center',
  },
  btn: {
    backgroundColor: '#1D3D47',
    paddingHorizontal: 12,
    paddingVertical: 8,
    borderRadius: 8,
  },
  btnDanger: { backgroundColor: '#a33b3b' },
  btnText: { color: '#fff', fontWeight: '600', fontSize: 13 },
});
