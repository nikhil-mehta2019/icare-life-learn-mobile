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
        <Text style={styles.muted}>No downloads yet.</Text>
        <Text style={styles.muted}>
          Open a chapter and tap “Download for offline”.
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
        <RefreshControl refreshing={refreshing} onRefresh={() => { setRefreshing(true); load(); }} />
      }
      renderItem={({ item }) => (
        <View style={styles.row}>
          <Pressable
            style={{ flex: 1 }}
            onPress={() => router.push({ pathname: '/player/[chapterId]', params: { chapterId: item.id } } as unknown as Href)}>
            <Text style={styles.title} numberOfLines={1}>{item.id}</Text>
            <Text style={styles.muted}>
              {item.state}
              {item.percentDownloaded >= 0
                ? ` · ${Math.round(item.percentDownloaded)}%`
                : ''}
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

const styles = StyleSheet.create({
  center: { flex: 1, alignItems: 'center', justifyContent: 'center', padding: 16, gap: 8 },
  row: {
    flexDirection: 'row', alignItems: 'center', gap: 12,
    padding: 12, borderRadius: 10, backgroundColor: 'rgba(0,0,0,0.05)', marginBottom: 8,
  },
  title: { fontSize: 14, fontWeight: '600' },
  muted: { fontSize: 12, opacity: 0.65, marginTop: 2 },
  btn: { backgroundColor: '#1D3D47', paddingHorizontal: 12, paddingVertical: 8, borderRadius: 8 },
  btnDanger: { backgroundColor: '#a33b3b' },
  btnText: { color: '#fff', fontWeight: '600', fontSize: 13 },
});
