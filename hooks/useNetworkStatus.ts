/**
 * useNetworkStatus — lightweight network detection via periodic fetch ping.
 * Zero extra dependencies: uses React Native AppState + setInterval.
 *
 * Returns { isOnline: boolean | null }
 *   null  = not yet determined (first check in progress)
 *   true  = internet reachable
 *   false = internet not reachable
 */

import { useEffect, useRef, useState } from 'react';
import { AppState, type AppStateStatus } from 'react-native';

const PING_URL = 'https://clients3.google.com/generate_204';
const PING_INTERVAL_MS = 15_000;
const PING_TIMEOUT_MS = 5_000;

async function checkOnline(): Promise<boolean> {
  try {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), PING_TIMEOUT_MS);
    const res = await fetch(PING_URL, { method: 'HEAD', signal: controller.signal });
    clearTimeout(timer);
    return res.status === 204 || res.ok;
  } catch {
    return false;
  }
}

export function useNetworkStatus(): { isOnline: boolean | null } {
  const [isOnline, setIsOnline] = useState<boolean | null>(null);
  const intervalRef = useRef<ReturnType<typeof setInterval> | null>(null);

  const ping = async () => {
    const online = await checkOnline();
    setIsOnline(online);
  };

  useEffect(() => {
    ping();
    intervalRef.current = setInterval(ping, PING_INTERVAL_MS);

    const sub = AppState.addEventListener('change', (state: AppStateStatus) => {
      if (state === 'active') ping();
    });

    return () => {
      if (intervalRef.current) clearInterval(intervalRef.current);
      sub.remove();
    };
  }, []);

  return { isOnline };
}
