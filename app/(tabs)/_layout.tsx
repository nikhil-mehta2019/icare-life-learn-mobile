import { Tabs } from 'expo-router';

/**
 * The Base44 web app is the primary UI.
 * The tab bar is hidden — the WebView provides all navigation.
 * Home and Downloads screens are excluded; only the Explore (WebView) screen
 * is active. The native player opens as a stack screen on top of this.
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
      {/* index and downloads are kept as registered screens to satisfy
          expo-router's file-based routing, but they redirect to explore. */}
      <Tabs.Screen
        name="index"
        options={{ href: null }}
      />
      <Tabs.Screen
        name="downloads"
        options={{ href: null }}
      />
    </Tabs>
  );
}
