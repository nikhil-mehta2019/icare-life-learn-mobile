declare module 'react-native-video' {
  import { Component } from 'react';
  import { ViewProps } from 'react-native';

  export type DRMType = 'widevine' | 'playready' | 'clearkey' | 'fairplay';

  export interface ReactVideoSource {
    uri?: string;
    type?: string;
    cacheKey?: string;
    [key: string]: any;
  }

  export interface DRMProps {
    type?: DRMType;
    licenseServer?: string;
    headers?: Record<string, string>;
    offlineLicense?: string;
    offlineLicenseKeySetId?: string;
    [key: string]: any;
  }


  export interface OnLoadData {
    audioTracks: Array<{
      index: number;
      title: string;
      language: string;
      type: string;
    }>;
    textTracks: Array<{
      index: number;
      title: string;
      language: string;
      type: string;
    }>;
    duration: number;
    naturalSize: { width: number; height: number; orientation: string };
    [key: string]: any;
  }

  export interface OnPlaybackStateChangedData {
    isPlaying: boolean;
    isSeeking: boolean;
  }

  export interface VideoProperties extends ViewProps {
    source?: ReactVideoSource;
    drm?: DRMProps;
    controls?: boolean;
    resizeMode?: 'none' | 'contain' | 'cover' | 'stretch';
    fullscreen?: boolean;
    paused?: boolean;
    muted?: boolean;
    repeat?: boolean;
    onLoad?: (data: OnLoadData) => void;
    onEnd?: () => void;
    onError?: (error: any) => void;
    onPlaybackStateChanged?: (data: OnPlaybackStateChangedData) => void;
    onFullscreenPlayerDidDismiss?: () => void;
    onFullscreenPlayerDidPresent?: () => void;
    onProgress?: (data: any) => void;
    [key: string]: any;
  }

  export default class Video extends Component<VideoProperties> {
    presentFullscreenPlayer(): void;
    dismissFullscreenPlayer(): void;
    seek(time: number, tolerance?: number): void;
  }

  // VideoRef is an alias for the Video class instance so that
  // useRef<VideoRef> satisfies RefObject<Video> on the component's ref prop.
  export type VideoRef = Video;
}
