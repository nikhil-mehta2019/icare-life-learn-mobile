import { requireNativeModule, EventEmitter } from 'expo-modules-core';
import { Platform } from 'react-native';

export type DownloadState =
  | 'queued'
  | 'downloading'
  | 'completed'
  | 'failed'
  | 'removing'
  | 'restarting'
  | 'stopped';

export interface DownloadInfo {
  id: string;
  state: DownloadState;
  bytesDownloaded: number;
  contentLength: number;
  percentDownloaded: number;
  failureReason?: string | null;
  title?: string | null;
  downloadedAt?: string | null;
  thumbnailUrl?: string | null;
  durationSeconds?: number | null;
}

export interface StartDownloadParams {
  id: string;
  manifestUrl: string;
  drmLicenseUrl: string;
  drmToken: string;
  title?: string;
  thumbnailUrl?: string;
  durationSeconds?: number;
  audioLanguages?: string[];
  captionLanguages?: string[];
}

export interface PlaybackSourceParams {
  id: string;
}

export interface OfflinePlaybackSource {
  cacheKey: string;
  uri: string;
  offlineLicenseKeySetId: string;
}

export interface StorageStats {
  usedBytes: number;
  downloadCount: number;
}

export interface DeviceStorageStats {
  totalBytes: number;
  freeBytes: number;
  usedBytes: number;
}

export interface DownloadEntitlement {
  courseId: string | null;
  chapterId: string | null;
  accessExpiresAt: string | null;
  validatedAt: string | null;
}

const NativeModule =
  Platform.OS === 'android' ? requireNativeModule('IcareOfflineDrm') : null;
const NativeLanguagePreferences =
  Platform.OS === 'android' ? requireNativeModule('IcareLanguagePreferences') : null;
const NativeDownloadManager =
  Platform.OS === 'android' ? requireNativeModule('IcareDownloadManager') : null;

function ensureAndroid(method: string) {
  if (Platform.OS !== 'android') {
    throw new Error(
      `IcareOfflineDrm.${method} is only supported on Android. ` +
      `iOS uses FairPlay offline via AVAssetDownloadTask — not yet implemented.`
    );
  }
}

function sleep(ms: number) {
  return new Promise<void>((resolve) => setTimeout(resolve, ms));
}

async function refreshNativeLanguagePreferences(): Promise<void> {
  if (Platform.OS !== 'android') return;
  try {
    // The Explore WebView owns the in-memory authenticated JWT. Dynamic imports
    // avoid introducing a static screen/module cycle and let existing downloads
    // pick up newly changed learner preferences before native playback starts.
    const explore = await import('../../app/(tabs)/explore');
    const jwt = explore.getAuthJwt?.();
    if (!jwt) return;
    const client = await import('../../api/base44Client');
    await client.fetchUserPreferences(jwt);
  } catch (error) {
    // Offline launch must never depend on network/session availability. The
    // native store retains the last successfully synced ordered preference trio.
    console.warn('[IcareOfflineDrm] language preference refresh skipped', error);
  }
}

export const IcareOfflineDrm = {
  async startDownload(params: StartDownloadParams): Promise<void> {
    ensureAndroid('startDownload');
    return NativeModule.startDownload(params);
  },

  async pauseDownload(id: string): Promise<void> {
    ensureAndroid('pauseDownload');
    return NativeModule.pauseDownload(id);
  },

  async resumeDownload(id: string): Promise<void> {
    ensureAndroid('resumeDownload');
    return NativeModule.resumeDownload(id);
  },

  /**
   * Media3 removal is asynchronous. Resolve only after the DownloadIndex no
   * longer contains the item so React screens never reinterpret REMOVING as a
   * fresh/active download. This also makes Delete a single deterministic action.
   */
  async removeDownload(id: string): Promise<void> {
    ensureAndroid('removeDownload');
    await NativeModule.removeDownload(id);

    const deadline = Date.now() + 12_000;
    while (Date.now() < deadline) {
      const current = await NativeModule.getDownload(id);
      if (!current) {
        try { await NativeDownloadManager?.clearEntitlement(id); } catch { /* non-fatal */ }
        return;
      }
      await sleep(250);
    }

    // Do not lie to the UI: if Media3 still owns the row after the deadline,
    // surface a real failure rather than showing the item as deleted.
    throw new Error('Download removal is still pending. Please try again in a moment.');
  },

  async listDownloads(): Promise<DownloadInfo[]> {
    if (Platform.OS !== 'android') return [];
    const list: DownloadInfo[] = await NativeModule.listDownloads();
    // REMOVING is an internal transient Media3 state, not a user-download state.
    return list.filter((item) => item.state !== 'removing');
  },

  async getDownload(id: string): Promise<DownloadInfo | null> {
    if (Platform.OS !== 'android') return null;
    return NativeModule.getDownload(id);
  },

  async getOfflineSource(
    params: PlaybackSourceParams
  ): Promise<OfflinePlaybackSource | null> {
    if (Platform.OS !== 'android') return null;
    return NativeModule.getOfflineSource(params);
  },

  async renewOfflineLicense(
    id: string,
    drmLicenseUrl: string,
    drmToken: string
  ): Promise<void> {
    ensureAndroid('renewOfflineLicense');
    return NativeModule.renewOfflineLicense(id, drmLicenseUrl, drmToken);
  },

  async getStorageStats(): Promise<StorageStats> {
    if (Platform.OS !== 'android') return { usedBytes: 0, downloadCount: 0 };
    return NativeModule.getStorageStats();
  },

  async getDeviceStorageStats(): Promise<DeviceStorageStats> {
    if (Platform.OS !== 'android') return { totalBytes: 0, freeBytes: 0, usedBytes: 0 };
    return NativeDownloadManager.getDeviceStorageStats();
  },

  async setDownloadEntitlement(params: {
    id: string;
    courseId?: string | null;
    chapterId?: string | null;
    accessExpiresAt?: string | null;
  }): Promise<void> {
    if (Platform.OS !== 'android') return;
    await NativeDownloadManager.setEntitlement(
      params.id,
      params.courseId ?? '',
      params.chapterId ?? params.id,
      params.accessExpiresAt ?? null,
    );
  },

  async getDownloadEntitlement(id: string): Promise<DownloadEntitlement | null> {
    if (Platform.OS !== 'android') return null;
    const value = await NativeDownloadManager.getEntitlement(id);
    if (!value || (!value.courseId && !value.chapterId && !value.accessExpiresAt)) return null;
    return value as DownloadEntitlement;
  },

  /**
   * Persist the learner's ordered three-language contract in native storage.
   * This does not alter download selection; the offline player uses it only
   * for visibility, ordering and default audio/caption selection.
   */
  async setPreferredLanguages(codes: string[]): Promise<string[]> {
    if (Platform.OS !== 'android') return codes.slice(0, 3);
    return NativeLanguagePreferences.setPreferredLanguages(codes);
  },

  async getPreferredLanguages(): Promise<string[]> {
    if (Platform.OS !== 'android') return [];
    return NativeLanguagePreferences.getPreferredLanguages();
  },

  async launchOfflinePlayer(id: string): Promise<void> {
    ensureAndroid('launchOfflinePlayer');

    // New downloads carry the authoritative Base44 course-entitlement expiry.
    // Legacy downloads have no entitlement metadata and remain backward-compatible.
    const entitlement = await this.getDownloadEntitlement(id);
    const expiresAt = entitlement?.accessExpiresAt
      ? new Date(entitlement.accessExpiresAt).getTime()
      : Number.NaN;
    if (Number.isFinite(expiresAt) && Date.now() >= expiresAt) {
      try { await this.removeDownload(id); } catch { /* playback still stays blocked */ }
      throw new Error('Course access has expired. This offline download is no longer available.');
    }

    await refreshNativeLanguagePreferences();
    return NativeModule.launchOfflinePlayer(id);
  },
};

export type DownloadProgressEvent = DownloadInfo;

type IcareDrmEvents = {
  onDownloadProgress: (e: DownloadProgressEvent) => void;
};

const emitter =
  Platform.OS === 'android'
    ? new EventEmitter<IcareDrmEvents>(NativeModule as any)
    : null;

export function onDownloadProgress(
  listener: (e: DownloadProgressEvent) => void
) {
  if (!emitter) return { remove: () => {} };
  return emitter.addListener('onDownloadProgress', (event) => {
    // REMOVING is a transient implementation state. Suppressing it prevents the
    // Downloads screen from flashing a deleted completed item under "Downloading".
    if (event.state === 'removing') return;
    listener(event);
  });
}

export default IcareOfflineDrm;
