import { useSyncExternalStore } from 'react';

/**
 * iOS: whether the online (web) player is currently full screen. The tab bar reads this to
 * hide the "My Downloads" button while the video fills the screen. Only ever set to true by
 * the iOS WebView bridge, so other platforms never see a change.
 */
let active = false;
const listeners = new Set<() => void>();

export function setWebFullscreen(next: boolean): void {
  if (active === next) return;
  active = next;
  listeners.forEach((l) => l());
}

export function useWebFullscreen(): boolean {
  return useSyncExternalStore(
    (cb) => { listeners.add(cb); return () => { listeners.delete(cb); }; },
    () => active,
    () => false,
  );
}
