import { Image } from 'expo-image';
import { useEffect, useState } from 'react';
import { ActivityIndicator, ScrollView, StyleSheet, View } from 'react-native';

import ParallaxScrollView from '@/components/parallax-scroll-view';
import { ThemedText } from '@/components/themed-text';
import { ThemedView } from '@/components/themed-view';
import { testConnection, fetchEntities } from '../../api/base44Client';

export default function HomeScreen() {
  const [connStatus, setConnStatus] = useState<'loading' | 'success' | 'error'>('loading');
  const [connMessage, setConnMessage] = useState('Connecting to Base44...');
  const [appData, setAppData] = useState<any>(null);
  const [entities, setEntities] = useState<any>(null);

  useEffect(() => {
    async function loadData() {
      try {
        const conn = await testConnection();
        if (conn.status === 200 || conn.status === 401) {
          setConnStatus('success');
          setConnMessage(`Reached Base44 ✓  (HTTP ${conn.status})`);
          setAppData(conn.data);
        }

        // Try fetching common entity names from iCare
        const attempts = ['Course', 'Student', 'User', 'Enrollment'];
        for (const name of attempts) {
          const result = await fetchEntities(name);
          if (result.status === 200 && Array.isArray(result.data)) {
            setEntities({ name, records: result.data.slice(0, 3) });
            break;
          }
        }
      } catch (err: any) {
        setConnStatus('error');
        setConnMessage('Error: ' + err.message);
      }
    }
    loadData();
  }, []);

  return (
    <ParallaxScrollView
      headerBackgroundColor={{ light: '#1D3D47', dark: '#1D3D47' }}
      headerImage={
        <Image
          source={require('@/assets/images/partial-react-logo.png')}
          style={styles.reactLogo}
        />
      }>
      <ThemedView style={styles.titleContainer}>
        <ThemedText type="title">iCare Life Learn</ThemedText>
      </ThemedView>

      <ThemedView style={styles.card}>
        <ThemedText type="subtitle">Base44 Connection</ThemedText>
        {connStatus === 'loading' && (
          <View style={styles.row}>
            <ActivityIndicator size="small" />
            <ThemedText style={styles.muted}>{connMessage}</ThemedText>
          </View>
        )}
        {connStatus === 'success' && (
          <ThemedText style={styles.success}>{connMessage}</ThemedText>
        )}
        {connStatus === 'error' && (
          <ThemedText style={styles.error}>{connMessage}</ThemedText>
        )}
        {appData && (
          <ThemedText style={styles.muted} numberOfLines={4}>
            {JSON.stringify(appData, null, 2).slice(0, 200)}
          </ThemedText>
        )}
      </ThemedView>

      {entities && (
        <ThemedView style={styles.card}>
          <ThemedText type="subtitle">{entities.name} (live from Base44)</ThemedText>
          {entities.records.map((record: any, i: number) => (
            <ThemedView key={i} style={styles.record}>
              <ThemedText style={styles.muted}>
                {JSON.stringify(record, null, 2).slice(0, 150)}
              </ThemedText>
            </ThemedView>
          ))}
        </ThemedView>
      )}

      <ThemedView style={styles.card}>
        <ThemedText type="subtitle">Milestone Status</ThemedText>
        <ThemedText style={styles.success}>✓ Milestone 1: EAS Build Foundation</ThemedText>
        <ThemedText style={styles.success}>✓ Milestone 2: Base44 Connection</ThemedText>
        <ThemedText style={styles.muted}>○ Milestone 3: Android DRM POC</ThemedText>
      </ThemedView>
    </ParallaxScrollView>
  );
}

const styles = StyleSheet.create({
  titleContainer: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 8,
    marginBottom: 8,
  },
  card: {
    gap: 8,
    marginBottom: 16,
    padding: 12,
    borderRadius: 8,
    backgroundColor: 'rgba(255,255,255,0.05)',
  },
  record: {
    padding: 8,
    borderRadius: 6,
    backgroundColor: 'rgba(255,255,255,0.03)',
  },
  row: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 8,
  },
  muted: { opacity: 0.6, fontSize: 12 },
  success: { color: '#4CAF50', lineHeight: 22 },
  error: { color: '#f44336' },
  reactLogo: {
    height: 178,
    width: 290,
    bottom: 0,
    left: 0,
    position: 'absolute',
  },
});
