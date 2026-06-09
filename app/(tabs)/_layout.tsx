import { Tabs } from 'expo-router';
import { Platform, StatusBar } from 'react-native';

const STATUS_BAR_HEIGHT = Platform.OS === 'android' ? (StatusBar.currentHeight ?? 24) : 44;

export default function TabLayout() {
  return (
    <Tabs
      tabBar={(props) => <TopTabBar {...props} />}
      screenOptions={{
        headerShown: false,
      }}
    >
      <Tabs.Screen
        name="explore"
        options={{ title: 'Learn' }}
      />
      <Tabs.Screen
        name="downloads"
        options={{ title: 'Downloads' }}
      />
      <Tabs.Screen
        name="index"
        options={{ href: null }}
      />
    </Tabs>
  );
}

import { Pressable, StyleSheet, Text, View } from 'react-native';
import type { BottomTabBarProps } from '@react-navigation/bottom-tabs';

function TopTabBar({ state, descriptors, navigation }: BottomTabBarProps) {
  const visibleRoutes = state.routes.filter((r) => {
    const opts = descriptors[r.key]?.options as any;
    return opts?.href !== null;
  });

  return (
    <View style={barStyles.bar}>
      {visibleRoutes.map((route) => {
        const isFocused = state.index === state.routes.indexOf(route);
        const label =
          (descriptors[route.key]?.options as any)?.title ?? route.name;

        return (
          <Pressable
            key={route.key}
            style={barStyles.tab}
            onPress={() => {
              if (!isFocused) navigation.navigate(route.name);
            }}
            android_ripple={{ color: 'rgba(79,195,247,0.15)', borderless: false }}
          >
            <Text style={[barStyles.icon, isFocused && barStyles.iconActive]}>
              {route.name === 'explore' ? '📚' : '⬇'}
            </Text>
            <Text style={[barStyles.label, isFocused && barStyles.labelActive]}>
              {label}
            </Text>
            {isFocused && <View style={barStyles.indicator} />}
          </Pressable>
        );
      })}
    </View>
  );
}

const barStyles = StyleSheet.create({
  bar: {
    flexDirection: 'row',
    backgroundColor: '#0F1923',
    paddingTop: STATUS_BAR_HEIGHT,
    borderBottomWidth: 1,
    borderBottomColor: '#1C2B35',
    elevation: 8,
    shadowColor: '#000',
    shadowOffset: { width: 0, height: 2 },
    shadowOpacity: 0.3,
    shadowRadius: 4,
  },
  tab: {
    flex: 1,
    alignItems: 'center',
    paddingVertical: 10,
    position: 'relative',
  },
  icon: { fontSize: 18, marginBottom: 2, opacity: 0.45 },
  iconActive: { opacity: 1 },
  label: { fontSize: 11, fontWeight: '600', color: '#5A7080' },
  labelActive: { color: '#4FC3F7' },
  indicator: {
    position: 'absolute',
    bottom: 0,
    left: '20%',
    right: '20%',
    height: 2,
    backgroundColor: '#4FC3F7',
    borderTopLeftRadius: 2,
    borderTopRightRadius: 2,
  },
});
