/**
 * playerCache.ts
 *
 * Bridges pre-fetched Mux tokens from the WebView auth context to the native
 * player screen.
 *
 * ─── Flow ────────────────────────────────────────────────────────────────────
 *
 *  OPEN_CHAPTER path (primary):
 *   1. explore.tsx injected JS detects a chapter URL via SPA navigation hook.
 *   2. Injected JS posts OPEN_CHAPTER → native opens player in 'loading' state.
 *   3. Injected JS posts REQUEST_TOKENS to itself (no history.back involved).
 *   4. Injected JS fetches chapter + Mux tokens using the WebView's authenticated
 *      session cookies (credentials: 'include'), then posts CHAPTER_TOKENS.
 *   5. explore.tsx onMessage calls deliverPlayerData() with the result.
 *   6. player/[chapterId].tsx calls waitForPlayerData() which resolves
 *      immediately (tokens already cached) or waits up to TIMEOUT_MS.
 *
 *  REQUEST_TOKENS path (download / delete-download):
 *   1. Player screen posts REQUEST_TOKENS message to the WebView.
 *   2. WebView bridge fetches and posts CHAPTER_TOKENS.
 *   3. Player resolves via the same waitForPlayerData() mechanism.
 *
 *  Error / timeout path:
 *   - CHAPTER_ERROR or 10 s timeout → resolves null → player shows error.
 *   - Player unmount calls cancelWait() → clears the pending resolver and its
 *     timer immediately; no stale setState after unmount.
 *
 * ─── Safety guarantees ───────────────────────────────────────────────────────
 *  • Stored entries expire after STORE_TTL_MS (60 s) — stale Mux tokens are
 *    never served to a re-mounted player.
 *  • cancelWait() removes only the caller's own resolver; unrelated waiters for
 *    the same chapterId are unaffected.
 *  • Multiple simultaneous waiters for the same chapterId are all resolved when
 *    tokens arrive (though the UI should prevent this via deduplication).
 */

import type { Chapter, MuxTokenResponse } from './base44Client';

export interface CachedPlayerData {
  chapter: Chapter;
  tokens: MuxTokenResponse;
}

/** How long to wait for the WebView to deliver tokens before resolving null. */
const TIMEOUT_MS = 10_000;

/** How long a pre-cached entry remains valid. Mux tokens are long-lived but we
 *  refresh conservatively to avoid serving stale DRM licenses. */
const STORE_TTL_MS = 60_000;

// ─── Internal types ──────────────────────────────────────────────────────────

interface StoredEntry {
  data: CachedPlayerData;
  expiresAt: number;
}

interface PendingResolver {
  resolve: (d: CachedPlayerData | null) => void;
  timer: ReturnType<typeof setTimeout>;
}

// ─── Module-level state ──────────────────────────────────────────────────────

/** Tokens that arrived before the player screen mounted (fast network path). */
const store: Record<string, StoredEntry> = {};

/** Resolvers waiting inside waitForPlayerData(). */
const pending: Record<string, PendingResolver[]> = {};

// ─── Exported API ─────────────────────────────────────────────────────────────

/**
 * Called from the player screen on mount.
 *
 * Returns a resolver handle that MUST be passed to cancelWait() in the
 * effect cleanup to prevent stale setState after unmount.
 *
 * Usage:
 *   const { promise, cancel } = waitForPlayerData(chapterId);
 *   promise.then(data => { if (!cancelled) { ... } });
 *   return () => { cancelled = true; cancel(); };
 */
export function waitForPlayerData(chapterId: string): {
  promise: Promise<CachedPlayerData | null>;
  cancel: () => void;
} {
  // Fast path: tokens already arrived before this call.
  const cached = store[chapterId];
  if (cached) {
    if (Date.now() < cached.expiresAt) {
      delete store[chapterId];
      console.log(`[playerCache] Cache hit for chapter ${chapterId}`);
      return {
        promise: Promise.resolve(cached.data),
        cancel: () => { /* nothing to cancel */ },
      };
    }
    // Expired — discard and wait for a fresh fetch.
    console.warn(`[playerCache] Discarding expired cache entry for chapter ${chapterId}`);
    delete store[chapterId];
  }

  // Slow path: register a resolver and wait.
  let resolver!: PendingResolver;

  const promise = new Promise<CachedPlayerData | null>((resolve) => {
    const timer = setTimeout(() => {
      _removeResolver(chapterId, resolver);
      console.warn(`[playerCache] Timeout waiting for tokens for chapter ${chapterId} — falling back`);
      resolve(null);
    }, TIMEOUT_MS);

    // Prevent the timer from blocking Node/JS teardown in tests.
    if (typeof timer === 'object' && (timer as NodeJS.Timeout).unref) {
      (timer as NodeJS.Timeout).unref();
    }

    resolver = { resolve, timer };
    if (!pending[chapterId]) pending[chapterId] = [];
    pending[chapterId].push(resolver);

    console.log(`[playerCache] Waiting for tokens for chapter ${chapterId} (${pending[chapterId].length} waiter(s))`);
  });

  const cancel = () => {
    _removeResolver(chapterId, resolver);
    console.log(`[playerCache] Wait cancelled for chapter ${chapterId}`);
  };

  return { promise, cancel };
}

/**
 * Called from explore.tsx when CHAPTER_TOKENS or CHAPTER_ERROR arrives.
 * Pass null on error so waitForPlayerData() unblocks immediately.
 */
export function deliverPlayerData(
  chapterId: string,
  data: CachedPlayerData | null
): void {
  const waiters = pending[chapterId];

  if (waiters && waiters.length > 0) {
    console.log(
      `[playerCache] Delivering ${data ? 'tokens' : 'null (error)'} to ${waiters.length} waiter(s) for chapter ${chapterId}`
    );
    // Snapshot the array before clearing — resolver callbacks could re-enter.
    const snapshot = [...waiters];
    delete pending[chapterId];
    snapshot.forEach((w) => {
      clearTimeout(w.timer);
      w.resolve(data);
    });
  } else if (data) {
    // No waiter yet — store for pickup when player mounts.
    console.log(`[playerCache] No waiters yet — caching tokens for chapter ${chapterId}`);
    store[chapterId] = { data, expiresAt: Date.now() + STORE_TTL_MS };
  } else {
    // Error and no waiters — nothing to do.
    console.warn(`[playerCache] Received error for chapter ${chapterId} with no waiters`);
  }
}

/**
 * Clears ALL state for a given chapterId (pending resolvers + cached entry).
 * Use sparingly — prefer cancelWait() per resolver for targeted cleanup.
 */
export function clearChapterData(chapterId: string): void {
  const waiters = pending[chapterId];
  if (waiters) {
    waiters.forEach((w) => {
      clearTimeout(w.timer);
      w.resolve(null);
    });
    delete pending[chapterId];
  }
  delete store[chapterId];
  console.log(`[playerCache] Cleared all state for chapter ${chapterId}`);
}

// ─── Internal helpers ─────────────────────────────────────────────────────────

function _removeResolver(chapterId: string, resolver: PendingResolver): void {
  clearTimeout(resolver.timer);
  const arr = pending[chapterId];
  if (!arr) return;
  const idx = arr.indexOf(resolver);
  if (idx >= 0) arr.splice(idx, 1);
  if (arr.length === 0) delete pending[chapterId];
}
