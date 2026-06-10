import { Tabs } from 'expo-router';
import { Platform, Pressable, StatusBar, StyleSheet, Text, View } from 'react-native';
import type { BottomTabBarProps } from '@react-navigation/bottom-tabs';

// Safe bottom inset — leaves breathing room above the home indicator on iOS.
const BOTTOM_INSET = Platform.OS === 'ios' ? 28 : 12;

export default function TabLayout() {
  return (
    <Tabs
      tabBar={(props) => <MyDownloadsBar {...props} />}
      screenOptions={{ headerShown: false }}
    >
      <Tabs.Screen name="explore"   options={{ title: 'Learn' }} />
      <Tabs.Screen name="downloads" options={{ title: 'Downloads' }} />
      <Tabs.Screen name="index"     options={{ href: null }} />
    </Tabs>
  );
}

// ─── Single full-width "My Downloads" button bar ─────────────────────────────

function MyDownloadsBar({ state, navigation }: BottomTabBarProps) {
  const downloadsIdx = state.routes.findIndex((r) => r.name === 'downloads');
  const isOnDownloads = state.index === downloadsIdx;

  return (
    <View style={barStyles.container}>
      <Pressable
        style={barStyles.button}
        onPress={() => {
          if (!isOnDownloads) navigation.navigate('downloads');
        }}
        android_ripple={{ color: 'rgba(15,25,35,0.1)' }}
        accessibilityRole="button"
        accessibilityLabel="My Downloads"
      >
        <Text style={barStyles.icon}>⬇</Text>
        <Text style={barStyles.label}>My Downloads</Text>
      </Pressable>
    </View>
  );
}

const barStyles = StyleSheet.create({
  container: {
    backgroundColor: '#0F1923',
    paddingHorizontal: 16,
    paddingTop: 10,
    paddingBottom: BOTTOM_INSET,
    borderTopWidth: StyleSheet.hairlineWidth,
    borderTopColor: 'rgba(255,255,255,0.10)',
    // Elevation so it sits above the web content's own nav bar
    elevation: 12,
    shadowColor: '#000',
    shadowOffset: { width: 0, height: -2 },
    shadowOpacity: 0.35,
    shadowRadius: 6,
  },
  button: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'center',
    gap: 8,
    backgroundColor: '#FFFFFF',
    borderRadius: 14,
    paddingVertical: 14,
  },
  icon: {
    fontSize: 16,
  },
  label: {
    color: '#0F1923',
    fontSize: 16,
    fontWeight: '700',
    letterSpacing: 0.2,
  },
});
