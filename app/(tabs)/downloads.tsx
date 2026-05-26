import { useRouter, type Href } from 'expo-router';
import { useCallback, useEffect, useState } from 'react';
import {
  ActivityIndicator,
  FlatList,
  Pressable,
  RefreshControl,
  StyleSheet,
  Text,
  View,
} from 'react-native';
import IcareOfflineDrm, {
  onDownloadProgress,
  type DownloadInfo,
} from '../../modules/icare-offline-drm';

export default function DownloadsScreen() {
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
