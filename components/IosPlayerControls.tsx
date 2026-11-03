import { Ionicons } from '@expo/vector-icons';
import { useCallback, useRef, useState } from 'react';
import { PanResponder, Pressable, StyleSheet, Text, View } from 'react-native';

/**
 * iOS-only transport controls for the offline player.
 *
 * Why not the system controls: in full screen the system player lists every audio and subtitle
 * track in the stream and ignores the learner's language filter. These controls keep the
 * filtered Audio / Subtitles / Speed menu identical inline and in full screen.
 */

export function formatTime(totalSeconds: number): string {
  if (!Number.isFinite(totalSeconds) || totalSeconds < 0) return '0:00';
  const s = Math.floor(totalSeconds);
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  const sec = s % 60;
  const pad = (n: number) => (n < 10 ? `0${n}` : String(n));
  return h > 0 ? `${h}:${pad(m)}:${pad(sec)}` : `${m}:${pad(sec)}`;
}

interface Props {
  title?: string;
  playing: boolean;
  currentTime: number;
  duration: number;
  isFullscreen: boolean;
  insetLeft: number;
  insetRight: number;
  onTogglePlay: () => void;
  onSkip: (deltaSeconds: number) => void;
  onSeek: (seconds: number) => void;
  onToggleFullscreen: () => void;
  onOpenSettings: () => void;
  /** Called on any interaction so the parent can restart its auto-hide timer. */
  onInteract: () => void;
}

export function IosPlayerControls({
  title, playing, currentTime, duration, isFullscreen, insetLeft, insetRight,
  onTogglePlay, onSkip, onSeek, onToggleFullscreen, onOpenSettings, onInteract,
}: Props) {
  const trackRef = useRef<View>(null);
  const trackX = useRef(0);
  const trackW = useRef(1);
  const [scrub, setScrub] = useState<number | null>(null);
  const durationRef = useRef(duration);
  durationRef.current = duration;

  const ratioFromPageX = (pageX: number) =>
    Math.min(1, Math.max(0, (pageX - trackX.current) / Math.max(1, trackW.current)));

  const pan = useRef(
    PanResponder.create({
      onStartShouldSetPanResponder: () => true,
      onMoveShouldSetPanResponder: () => true,
      onPanResponderGrant: (e) => setScrub(ratioFromPageX(e.nativeEvent.pageX) * durationRef.current),
      onPanResponderMove: (e) => setScrub(ratioFromPageX(e.nativeEvent.pageX) * durationRef.current),
      onPanResponderRelease: (e) => {
        const t = ratioFromPageX(e.nativeEvent.pageX) * durationRef.current;
        setScrub(null);
        if (durationRef.current > 0) onSeek(t);
      },
      onPanResponderTerminate: () => setScrub(null),
    }),
  ).current;

  const measure = useCallback(() => {
    trackRef.current?.measureInWindow((x, _y, w) => {
      trackX.current = x;
      trackW.current = w || 1;
    });
  }, []);

  const shown = scrub ?? currentTime;
  const progress = duration > 0 ? Math.min(1, Math.max(0, shown / duration)) : 0;

  const press = (fn: () => void) => () => { onInteract(); fn(); };

  return (
    <View style={styles.root} pointerEvents="box-none">
      <View style={styles.dim} pointerEvents="none" />

      {title ? (
        <View style={[styles.top, { paddingLeft: 14 + insetLeft, paddingRight: 14 + insetRight }]}>
          <Text style={styles.title} numberOfLines={1}>{title}</Text>
        </View>
      ) : null}

      <View style={styles.center} pointerEvents="box-none">
        <Pressable hitSlop={10} style={styles.skip} onPress={press(() => onSkip(-10))} accessibilityLabel="Back 10 seconds">
          <Ionicons name="play-back" size={26} color="#fff" />
          <Text style={styles.skipText}>10</Text>
        </Pressable>
        <Pressable hitSlop={10} style={styles.play} onPress={press(onTogglePlay)} accessibilityLabel={playing ? 'Pause' : 'Play'}>
          <Ionicons name={playing ? 'pause' : 'play'} size={34} color="#fff" />
        </Pressable>
        <Pressable hitSlop={10} style={styles.skip} onPress={press(() => onSkip(10))} accessibilityLabel="Forward 10 seconds">
          <Ionicons name="play-forward" size={26} color="#fff" />
          <Text style={styles.skipText}>10</Text>
        </Pressable>
      </View>

      <View style={[styles.bottom, { paddingLeft: 12 + insetLeft, paddingRight: 12 + insetRight }]}>
        <Text style={styles.time}>{formatTime(shown)}</Text>
        <View
          ref={trackRef}
          style={styles.trackHit}
          onLayout={measure}
          onTouchStart={measure}
          {...pan.panHandlers}>
          <View style={styles.track}>
            <View style={[styles.fill, { width: `${progress * 100}%` }]} />
          </View>
          <View style={[styles.thumb, { left: `${progress * 100}%` }]} />
        </View>
        <Text style={styles.time}>{formatTime(duration)}</Text>
        <Pressable hitSlop={8} style={styles.icon} onPress={press(onOpenSettings)} accessibilityLabel="Playback settings">
          <Ionicons name="settings-outline" size={21} color="#fff" />
        </Pressable>
        <Pressable
          hitSlop={8}
          style={styles.icon}
          onPress={press(onToggleFullscreen)}
          accessibilityLabel={isFullscreen ? 'Exit full screen' : 'Full screen'}>
          <Ionicons name={isFullscreen ? 'contract-outline' : 'expand-outline'} size={21} color="#fff" />
        </Pressable>
      </View>
    </View>
  );
}

const FILL = { position: 'absolute', top: 0, left: 0, right: 0, bottom: 0 } as const;

const styles = StyleSheet.create({
  root: { ...FILL, justifyContent: 'space-between' },
  dim: { ...FILL, backgroundColor: 'rgba(0,0,0,0.35)' },
  top: { paddingTop: 10 },
  title: { color: '#fff', fontSize: 14, fontWeight: '600' },
  center: { flexDirection: 'row', alignItems: 'center', justifyContent: 'center', gap: 36 },
  play: {
    width: 62, height: 62, borderRadius: 31,
    backgroundColor: 'rgba(0,0,0,0.45)', alignItems: 'center', justifyContent: 'center',
  },
  skip: { alignItems: 'center', justifyContent: 'center', width: 44, height: 44 },
  skipText: { color: '#fff', fontSize: 10, fontWeight: '700', marginTop: -2 },
  bottom: { flexDirection: 'row', alignItems: 'center', gap: 8, paddingBottom: 8 },
  time: { color: '#fff', fontSize: 11, fontVariant: ['tabular-nums'], minWidth: 36, textAlign: 'center' },
  trackHit: { flex: 1, height: 34, justifyContent: 'center' },
  track: { height: 4, borderRadius: 2, backgroundColor: 'rgba(255,255,255,0.3)', overflow: 'hidden' },
  fill: { height: 4, backgroundColor: '#4FC3F7' },
  thumb: {
    position: 'absolute', width: 14, height: 14, borderRadius: 7, marginLeft: -7,
    backgroundColor: '#fff', top: 10,
  },
  icon: { width: 30, height: 30, alignItems: 'center', justifyContent: 'center' },
});
