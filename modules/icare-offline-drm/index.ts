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

const NativeModule =
  Platform.OS === 'android' ? requireNativeModule('IcareOfflineDrm') : null;
const NativeLanguagePreferences =
  Platform.OS === 'android' ? requireNativeModule('IcareLanguagePreferences') : null;

function ensureAndroid(method: string) {
  if (Platform.OS !== 'android') {
    throw new Error(
      `IcareOfflineDrm.${method} is only supported on Android. ` +
      `iOS uses FairPlay offline via AVAssetDownloadTask — not yet implemented.`
    );
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

  async removeDownload(id: string): Promise<void> {
    ensureAndroid('removeDownload');
    return NativeModule.removeDownload(id);
  },

  async listDownloads(): Promise<DownloadInfo[]> {
    if (Platform.OS !== 'android') return [];
    return NativeModule.listDownloads();
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
  return emitter.addListener('onDownloadProgress', listener);
}

export default IcareOfflineDrm;
