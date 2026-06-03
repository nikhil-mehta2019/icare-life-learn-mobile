import { Tabs } from 'expo-router';

/**
 * Tab layout — tab bar is hidden; all navigation is driven by the Base44 WebView
 * or programmatic router.push() calls. The Downloads screen is reachable via
 * router.push('/downloads') from the player and from deep links.
 */
export default function TabLayout() {
  return (
    <Tabs
      screenOptions={{
        headerShown: false,
        tabBarStyle: { display: 'none' },
      }}>
      <Tabs.Screen
        name="explore"
        options={{ title: 'Explore' }}
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
