/**
 * playerCache.ts
 *
 * Bridges pre-fetched Mux tokens from the WebView auth context to the native
 * player screen.
 *
 * Flow:
 *  1. explore.tsx injected JS detects a chapter URL, fetches chapter metadata
 *     and Mux tokens using the WebView's authenticated session cookies, then
 *     posts a CHAPTER_TOKENS message to the native layer.
 *  2. explore.tsx onMessage calls deliverPlayerData() with the result.
 *  3. player/[chapterId].tsx calls waitForPlayerData() which either resolves
 *     immediately (if tokens already arrived) or waits up to TIMEOUT_MS.
 *  4. On timeout or CHAPTER_ERROR the promise resolves with null so the player
 *     can fall back to native API calls.
 */

import type { Chapter, MuxTokenResponse } from './base44Client';

export interface CachedPlayerData {
  chapter: Chapter;
  tokens: MuxTokenResponse;
}

const TIMEOUT_MS = 10_000;

// Tokens that arrived before the player screen mounted.
const store: Record<string, CachedPlayerData> = {};

// Resolver callbacks waiting inside waitForPlayerData().
const pending: Record<string, Array<(d: CachedPlayerData | null) => void>> = {};

/**
 * Called from the player screen.  Resolves with token data once the WebView
 * bridge delivers them, or with null if the timeout fires first.
 */
export function waitForPlayerData(
  chapterId: string
): Promise<CachedPlayerData | null> {
  // Already cached from a fast network / early delivery
  if (chapterId in store) {
    const d = store[chapterId];
    delete store[chapterId];
    return Promise.resolve(d);
  }

  return new Promise((resolve) => {
    if (!pending[chapterId]) pending[chapterId] = [];
    pending[chapterId].push(resolve);

    const timer = setTimeout(() => {
      const arr = pending[chapterId];
      if (arr) {
        const idx = arr.indexOf(resolve);
        if (idx >= 0) arr.splice(idx, 1);
        if (arr.length === 0) delete pending[chapterId];
      }
      resolve(null); // fall back to native fetch path
    }, TIMEOUT_MS);

    // Prevent the timer from blocking Node/JS teardown in tests
    if (typeof timer === 'object' && (timer as any).unref) {
      (timer as any).unref();
    }
  });
}

/**
 * Called from explore.tsx when CHAPTER_TOKENS or CHAPTER_ERROR arrives.
 * Pass null on error so waitForPlayerData() unblocks immediately.
 */
export function deliverPlayerData(
  chapterId: string,
  data: CachedPlayerData | null
): void {
  const arr = pending[chapterId];
  if (arr && arr.length > 0) {
    arr.forEach((r) => r(data));
    delete pending[chapterId];
  } else if (data) {
    // Player not yet mounted — store for later pickup
    store[chapterId] = data;
  }
}
