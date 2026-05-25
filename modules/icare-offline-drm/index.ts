import { requireNativeModule, EventEmitter } from 'expo-modules-core';
import { Platform } from 'react-native';

// ----- Types ------------------------------------------------------------

export type DownloadState =
  | 'queued'
  | 'downloading'
  | 'completed'
  | 'failed'
  | 'removing'
  | 'restarting'
  | 'stopped';

export interface DownloadInfo {
  id: string;                 // chapterId — used as the download key
  state: DownloadState;
  bytesDownloaded: number;
  contentLength: number;      // -1 if unknown
  percentDownloaded: number;  // 0..100, -1 if unknown
  failureReason?: string | null;
}

export interface StartDownloadParams {
  /** Use chapterId so we can look the download up later. */
  id: string;
  /** Pre-signed HLS .m3u8 URL — what `secureStreamUrl` from getMuxToken returns. */
  manifestUrl: string;
  /** Widevine license server URL — `drmLicenseUrl` from getMuxToken. */
  drmLicenseUrl: string;
  /** Widevine license token — `drmToken` from getMuxToken. Sent as `x-mux-license-token` header. */
  drmToken: string;
  /** Optional human title for the notification + downloads UI. */
  title?: string;
}

export interface PlaybackSourceParams {
  id: string;
}

export interface OfflinePlaybackSource {
  /** Local cache key for ExoPlayer's DownloadCache. The native module passes
   *  this back to react-native-video via the `cacheKey` prop. */
  cacheKey: string;
  /** Original manifest URL we downloaded from. The video player still uses
   *  this URI; ExoPlayer transparently serves bytes from cache. */
  uri: string;
  /** Stored Widevine offline license keySetId (base64). */
  offlineLicenseKeySetId: string;
}

// ----- Native module wrapper -------------------------------------------

const NativeModule =
  Platform.OS === 'android' ? requireNativeModule('IcareOfflineDrm') : null;

function ensureAndroid(method: string) {
  if (Platform.OS !== 'android') {
    throw new Error(
      `IcareOfflineDrm.${method} is only supported on Android. ` +
      `iOS uses FairPlay offline via AVAssetDownloadTask — not yet implemented.`
    );
  }
}

// ----- Public API -------------------------------------------------------

export const IcareOfflineDrm = {
  /** Queue a chapter for offline download. Resolves once accepted by the
   *  DownloadService. Listen to `onDownloadProgress` for updates. */
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

  /** Returns all known downloads (queued, in-progress, completed). */
  async listDownloads(): Promise<DownloadInfo[]> {
    if (Platform.OS !== 'android') return [];
    return NativeModule.listDownloads();
  },

  async getDownload(id: string): Promise<DownloadInfo | null> {
    if (Platform.OS !== 'android') return null;
    return NativeModule.getDownload(id);
  },

  /** Resolve a chapter ID to an offline playback source if it's downloaded
   *  AND has a valid (non-expired) offline Widevine license. */
  async getOfflineSource(
    params: PlaybackSourceParams
  ): Promise<OfflinePlaybackSource | null> {
    if (Platform.OS !== 'android') return null;
    return NativeModule.getOfflineSource(params);
  },

  /** Renew an offline Widevine license (e.g. before it expires). Requires a
   *  fresh drmToken/drmLicenseUrl from getMuxToken. */
  async renewOfflineLicense(
    id: string,
    drmLicenseUrl: string,
    drmToken: string
  ): Promise<void> {
    ensureAndroid('renewOfflineLicense');
    return NativeModule.renewOfflineLicense(id, drmLicenseUrl, drmToken);
  },
};

// ----- Events -----------------------------------------------------------

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
