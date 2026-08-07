import { Tabs } from 'expo-router';
import { Platform, Pressable, StyleSheet, Text, View } from 'react-native';
import type { BottomTabBarProps } from '@react-navigation/bottom-tabs';

const BOTTOM_INSET = Platform.OS === 'ios' ? 28 : 12;

export default function TabLayout() {
  return (
    <Tabs
      tabBar={(props) => <OfflineLearningBar {...props} />}
      screenOptions={{ headerShown: false }}
    >
      <Tabs.Screen name="explore" options={{ title: 'Learn' }} />
      <Tabs.Screen name="downloads" options={{ title: 'Downloads' }} />
      <Tabs.Screen name="download-manager" options={{ title: 'Add Downloads', href: null }} />
      <Tabs.Screen name="index" options={{ href: null }} />
    </Tabs>
  );
}

function OfflineLearningBar({ state, navigation }: BottomTabBarProps) {
  const downloadsIdx = state.routes.findIndex((r) => r.name === 'downloads');
  const managerIdx = state.routes.findIndex((r) => r.name === 'download-manager');
  const isOnDownloads = state.index === downloadsIdx;
  const isOnManager = state.index === managerIdx;
  const isOfflineArea = isOnDownloads || isOnManager;

  if (!isOfflineArea) {
    return (
      <View style={barStyles.container}>
        <Pressable
          style={barStyles.primaryButton}
          onPress={() => navigation.navigate('downloads')}
          android_ripple={{ color: 'rgba(15,25,35,0.1)' }}
          accessibilityRole="button"
          accessibilityLabel="My Downloads"
        >
          <Text style={barStyles.primaryIcon}>⬇</Text>
          <Text style={barStyles.primaryLabel}>My Downloads</Text>
        </Pressable>
      </View>
    );
  }

  return (
    <View style={barStyles.container}>
      <View style={barStyles.segmentRow}>
        <Pressable
          style={[barStyles.segment, isOnDownloads && barStyles.segmentActive]}
          onPress={() => navigation.navigate('downloads')}
          accessibilityRole="button"
          accessibilityState={{ selected: isOnDownloads }}
          accessibilityLabel="My Downloads"
        >
          <Text style={barStyles.segmentIcon}>⬇</Text>
          <Text style={[barStyles.segmentLabel, isOnDownloads && barStyles.segmentLabelActive]}>My Downloads</Text>
        </Pressable>
        <Pressable
          style={[barStyles.segment, isOnManager && barStyles.segmentActive]}
          onPress={() => navigation.navigate('download-manager')}
          accessibilityRole="button"
          accessibilityState={{ selected: isOnManager }}
          accessibilityLabel="Add Downloads"
        >
          <Text style={barStyles.segmentIcon}>＋</Text>
          <Text style={[barStyles.segmentLabel, isOnManager && barStyles.segmentLabelActive]}>Add Downloads</Text>
        </Pressable>
      </View>
    </View>
  );
}

const barStyles = StyleSheet.create({
  container: {
    backgroundColor: '#0F1923',
    paddingTop: 10,
    paddingHorizontal: 12,
    paddingBottom: BOTTOM_INSET,
    borderTopWidth: StyleSheet.hairlineWidth,
    borderTopColor: 'rgba(255,255,255,0.10)',
    elevation: 12,
    shadowColor: '#000',
    shadowOffset: { width: 0, height: -2 },
    shadowOpacity: 0.35,
    shadowRadius: 6,
  },
  primaryButton: {
    minHeight: 50,
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'center',
    gap: 8,
    backgroundColor: '#FFFFFF',
    borderRadius: 10,
  },
  primaryIcon: { fontSize: 16 },
  primaryLabel: { color: '#0F1923', fontSize: 16, fontWeight: '700', letterSpacing: 0.2 },
  segmentRow: {
    minHeight: 54,
    flexDirection: 'row',
    padding: 4,
    gap: 4,
    borderRadius: 12,
    backgroundColor: '#1C2B35',
    borderWidth: 1,
    borderColor: 'rgba(255,255,255,0.08)',
  },
  segment: {
    flex: 1,
    minHeight: 46,
    borderRadius: 9,
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'center',
    gap: 7,
  },
  segmentActive: { backgroundColor: '#FFFFFF' },
  segmentIcon: { fontSize: 15 },
  segmentLabel: { color: '#8A9BB0', fontSize: 13, fontWeight: '800' },
  segmentLabelActive: { color: '#0F1923' },
});
