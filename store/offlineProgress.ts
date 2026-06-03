/**
 * Offline progress store — persists last-watched position and watch percentage
 * for each chapter using expo-file-system (JSON file in documentDirectory).
 *
 * All operations are fire-and-forget safe — playback is never blocked on I/O.
 * Sync-to-backend is handled separately via syncProgress() which is a no-op if
 * the device is offline.
 */

import * as FileSystem from 'expo-file-system';

const STORE_FILE = `${FileSystem.documentDirectory}icare_progress.json`;

export interface ChapterProgress {
  chapterId: string;
  watchedSeconds: number;  // last known position
  durationSeconds: number; // -1 if unknown
  percentWatched: number;  // 0-100
  lastWatchedAt: string;   // ISO date string
  synced: boolean;         // false = pending upload
}

type ProgressStore = Record<string, ChapterProgress>;

let cache: ProgressStore | null = null;

async function readStore(): Promise<ProgressStore> {
  if (cache) return cache;
  try {
    const info = await FileSystem.getInfoAsync(STORE_FILE);
    if (!info.exists) return {};
    const raw = await FileSystem.readAsStringAsync(STORE_FILE);
    cache = JSON.parse(raw) as ProgressStore;
    return cache;
  } catch {
    return {};
  }
}

async function writeStore(store: ProgressStore): Promise<void> {
  cache = store;
  try {
    await FileSystem.writeAsStringAsync(STORE_FILE, JSON.stringify(store));
  } catch {
    // disk full or permissions — non-fatal
  }
}

export async function saveProgress(progress: Omit<ChapterProgress, 'synced'>): Promise<void> {
  const store = await readStore();
  store[progress.chapterId] = { ...progress, synced: false };
  await writeStore(store);
}

export async function getProgress(chapterId: string): Promise<ChapterProgress | null> {
  const store = await readStore();
  return store[chapterId] ?? null;
}

export async function getAllProgress(): Promise<ChapterProgress[]> {
  const store = await readStore();
  return Object.values(store);
}

export async function markSynced(chapterId: string): Promise<void> {
  const store = await readStore();
  if (store[chapterId]) {
    store[chapterId].synced = true;
    await writeStore(store);
  }
}

export async function clearProgress(chapterId: string): Promise<void> {
  const store = await readStore();
  delete store[chapterId];
  cache = store;
  await writeStore(store);
}

/** Returns all unsynced records — call this when internet returns. */
export async function getUnsyncedProgress(): Promise<ChapterProgress[]> {
  const store = await readStore();
  return Object.values(store).filter((p) => !p.synced);
}
