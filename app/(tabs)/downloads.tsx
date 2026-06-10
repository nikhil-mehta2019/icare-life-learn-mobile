import * as FileSystem from 'expo-file-system';
import { useRouter, type Href } from 'expo-router';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  ActivityIndicator,
  Alert,
  Animated,
  Image,
  Modal,
  Platform,
  Pressable,
  RefreshControl,
  ScrollView,
  StyleSheet,
  Text,
  View,
} from 'react-native';
import IcareOfflineDrm, {
  onDownloadProgress,
  type DownloadInfo,
} from '../../modules/icare-offline-drm';
import { fetchChapter } from '../../api/base44Client';
import { getAllProgress, type ChapterProgress } from '../../store/offlineProgress';

// ─── Constants ──────────────────────────────────────────────────────────────────

const BRAND = '#1D3D47';
const BRAND_LIGHT = '#2A5568';
const BG = '#0F1923';
const CARD_BG = '#1C2B35';
const SURFACE = '#243344';
const TEXT = '#F0F4F8';
const TEXT_MUTED = '#8A9BB0';
const ACCENT = '#4FC3F7';
const SUCCESS = '#66BB6A';
const WARN = '#FFA726';
const DANGER = '#EF5350';

// ─── Helpers ────────────────────────────────────────────────────────────────────

function fmtBytes(b: number): string {
  if (b <= 0) return '0 B';
  if (b < 1024 * 1024) return `${(b / 1024).toFixed(0)} KB`;
  if (b < 1024 * 1024 * 1024) return `${(b / (1024 * 1024)).toFixed(1)} MB`;
  return `${(b / (1024 * 1024 * 1024)).toFixed(2)} GB`;
}

function fmtDuration(sec: number): string {
  if (sec <= 0) return '';
  const h = Math.floor(sec / 3600);
  const m = Math.floor((sec % 3600) / 60);
  const s = Math.floor(sec % 60);
  if (h > 0) return `${h}h ${m}m`;
  if (m > 0) return `${m}m ${s}s`;
  return `${s}s`;
}

function fmtDate(iso: string | null | undefined): string {
  if (!iso) return '';
  try {
    return new Date(iso).toLocaleDateString(undefined, { day: 'numeric', month: 'short' });
  } catch { return ''; }
}

function licenseAge(downloadedAt: string | null | undefined): 'active' | 'expiring' | 'expired' {
  if (!downloadedAt) return 'active';
  const ageMs = Date.now() - new Date(downloadedAt).getTime();
  const thirtyD = 30 * 24 * 60 * 60 * 1000;
  const fiveD = 5 * 24 * 60 * 60 * 1000;
  if (ageMs > thirtyD) return 'expired';
  if (ageMs > thirtyD - fiveD) return 'expiring';
  return 'active';
}

// Returns true if s looks like a raw MongoDB ObjectId (24 hex chars) — i.e. title was never set.
function isRawId(s: string | null | undefined): boolean {
  return !!s && /^[0-9a-f]{24}$/i.test(s);
}

// Extract a "course name" from the chapter title.
// Titles look like "Course Name – Chapter N" or "Course Name: Chapter N".
// If no separator, every chapter is its own group.
function courseKey(title: string | null | undefined): string {
  if (!title) return '__ungrouped__';
  const sep = title.indexOf(' – ') !== -1 ? ' – ' : title.indexOf(': ') !== -1 ? ': ' : null;
  return sep ? title.split(sep)[0].trim() : title.trim();
}

interface EnrichedDownload extends DownloadInfo {
  progress: ChapterProgress | null;
  licStatus: 'active' | 'expiring' | 'expired';
}

// ─── Thumbnail Placeholder ──────────────────────────────────────────────────────

function Thumbnail({ size, isActive, url }: { size: number; isActive?: boolean; url?: string | null }) {
  return (
    <View style={[thumbStyles.box, { width: size, height: size * 0.5625 }]}>
      {url ? (
        <Image source={{ uri: url }} style={StyleSheet.absoluteFill} resizeMode="cover" />
      ) : (
        <>
          <View style={thumbStyles.gradient} />
          <Text style={thumbStyles.icon}>🎬</Text>
        </>
      )}
      {isActive && (
        <View style={thumbStyles.playBadge}>
          <Text style={thumbStyles.playBadgeText}>▶</Text>
        </View>
      )}
    </View>
  );
}

const thumbStyles = StyleSheet.create({
  box: {
    backgroundColor: SURFACE,
    borderRadius: 8,
    overflow: 'hidden',
    alignItems: 'center',
    justifyContent: 'center',
  },
  gradient: {
    ...StyleSheet.absoluteFillObject,
    backgroundColor: 'rgba(29,61,71,0.4)',
  },
  icon: { fontSize: 28 },
  playBadge: {
    position: 'absolute',
    bottom: 6,
    right: 6,
    backgroundColor: ACCENT,
    borderRadius: 12,
    width: 24,
    height: 24,
    alignItems: 'center',
    justifyContent: 'center',
  },
  playBadgeText: { color: '#000', fontSize: 10, fontWeight: '900' },
});

// ─── Continue Watching row ──────────────────────────────────────────────────────

function ContinueWatchingCard({
  item,
  onPress,
}: {
  item: EnrichedDownload;
  onPress: () => void;
}) {
  const pct = item.progress ? Math.min(100, item.progress.percentWatched) : 0;
  const title = item.title ?? item.id;

  return (
    <Pressable style={cwStyles.card} onPress={onPress} android_ripple={{ color: 'rgba(255,255,255,0.08)' }}>
      <Thumbnail size={160} isActive url={item.thumbnailUrl} />
      {/* Progress bar overlay at bottom */}
      <View style={cwStyles.progressTrack}>
        <View style={[cwStyles.progressFill, { width: `${pct}%` as any }]} />
      </View>
      <Text style={cwStyles.title} numberOfLines={2}>{title}</Text>
      {item.progress && item.progress.watchedSeconds > 0 && (
        <Text style={cwStyles.meta}>
          {fmtDuration(item.progress.watchedSeconds)} watched · {Math.round(pct)}%
        </Text>
      )}
    </Pressable>
  );
}

const cwStyles = StyleSheet.create({
  card: {
    width: 160,
    marginRight: 12,
  },
  progressTrack: {
    height: 3,
    backgroundColor: 'rgba(255,255,255,0.15)',
    borderRadius: 2,
    marginTop: 0,
  },
  progressFill: {
    height: 3,
    backgroundColor: ACCENT,
    borderRadius: 2,
  },
  title: {
    color: TEXT,
    fontSize: 12,
    fontWeight: '600',
    marginTop: 6,
    lineHeight: 16,
  },
  meta: {
    color: TEXT_MUTED,
    fontSize: 10,
    marginTop: 2,
  },
});

// ─── Download Progress Card (for active/queued) ─────────────────────────────────

function ActiveDownloadCard({
  item,
  onPause,
  onResume,
  onCancel,
}: {
  item: EnrichedDownload;
  onPause: () => void;
  onResume: () => void;
  onCancel: () => void;
}) {
  const pct = item.percentDownloaded >= 0 ? item.percentDownloaded : 0;
  const isDownloading = item.state === 'downloading';
  const isFailed = item.state === 'failed';

  return (
    <View style={activeStyles.card}>
      <Thumbnail size={72} url={item.thumbnailUrl} />
      <View style={activeStyles.content}>
        <Text style={activeStyles.title} numberOfLines={2}>{item.title ?? item.id}</Text>
        {isDownloading || item.state === 'queued' || item.state === 'stopped' ? (
          <>
            <View style={activeStyles.progressRow}>
              <View style={activeStyles.track}>
                <Animated.View style={[activeStyles.fill, { width: `${pct}%` as any }]} />
              </View>
              <Text style={activeStyles.pctText}>{Math.round(pct)}%</Text>
            </View>
            <Text style={activeStyles.meta}>
              {fmtBytes(item.bytesDownloaded)}
              {item.contentLength > 0 ? ` / ${fmtBytes(item.contentLength)}` : ''}
              {item.state === 'queued' ? ' · Queued' : item.state === 'stopped' ? ' · Paused' : ''}
            </Text>
          </>
        ) : isFailed ? (
          <Text style={[activeStyles.meta, { color: DANGER }]}>Download failed</Text>
        ) : null}
        <View style={activeStyles.actions}>
          {isDownloading && (
            <Pressable style={activeStyles.actionBtn} onPress={onPause}>
              <Text style={activeStyles.actionText}>⏸ Pause</Text>
            </Pressable>
          )}
          {(item.state === 'queued' || item.state === 'stopped' || isFailed) && (
            <Pressable style={activeStyles.actionBtn} onPress={onResume}>
              <Text style={activeStyles.actionText}>▶ {isFailed ? 'Retry' : 'Resume'}</Text>
            </Pressable>
          )}
          <Pressable style={[activeStyles.actionBtn, activeStyles.cancelBtn]} onPress={onCancel}>
            <Text style={[activeStyles.actionText, { color: DANGER }]}>✕ Cancel</Text>
          </Pressable>
        </View>
      </View>
    </View>
  );
}

const activeStyles = StyleSheet.create({
  card: {
    flexDirection: 'row',
    backgroundColor: CARD_BG,
    borderRadius: 12,
    padding: 12,
    marginBottom: 8,
    gap: 12,
    alignItems: 'flex-start',
  },
  content: { flex: 1 },
  title: { color: TEXT, fontSize: 13, fontWeight: '600', lineHeight: 18, marginBottom: 6 },
  progressRow: { flexDirection: 'row', alignItems: 'center', gap: 8, marginBottom: 4 },
  track: { flex: 1, height: 4, backgroundColor: SURFACE, borderRadius: 2 },
  fill: { height: 4, backgroundColor: ACCENT, borderRadius: 2 },
  pctText: { color: ACCENT, fontSize: 11, fontWeight: '700', minWidth: 30 },
  meta: { color: TEXT_MUTED, fontSize: 11, marginBottom: 8 },
  actions: { flexDirection: 'row', gap: 8 },
  actionBtn: {
    paddingHorizontal: 12,
    paddingVertical: 5,
    borderRadius: 6,
    backgroundColor: SURFACE,
  },
  cancelBtn: { backgroundColor: 'transparent' },
  actionText: { color: TEXT, fontSize: 12, fontWeight: '600' },
});

// ─── OTT Content Card (for completed downloads) ─────────────────────────────────

function ContentCard({
  item,
  onPress,
  onMorePress,
}: {
  item: EnrichedDownload;
  onPress: () => void;
  onMorePress: () => void;
}) {
  const title = item.title ?? item.id;
  const hasProgress = (item.progress?.percentWatched ?? 0) > 1;
  const pct = hasProgress ? Math.min(100, item.progress!.percentWatched) : 0;

  return (
    <Pressable
      style={ccStyles.card}
      onPress={onPress}
      android_ripple={{ color: 'rgba(255,255,255,0.06)' }}
    >
      <View style={ccStyles.thumbWrap}>
        <Thumbnail size={110} url={item.thumbnailUrl} />
        {/* watch progress stripe */}
        {hasProgress && (
          <View style={ccStyles.progressTrack}>
            <View style={[ccStyles.progressFill, { width: `${pct}%` as any }]} />
          </View>
        )}
        {/* license badge */}
        {item.licStatus === 'expiring' && (
          <View style={[ccStyles.licBadge, { backgroundColor: WARN }]}>
            <Text style={ccStyles.licBadgeText}>Expiring</Text>
          </View>
        )}
        {item.licStatus === 'expired' && (
          <View style={[ccStyles.licBadge, { backgroundColor: DANGER }]}>
            <Text style={ccStyles.licBadgeText}>Expired</Text>
          </View>
        )}
      </View>

      <Text style={ccStyles.title} numberOfLines={2}>{title}</Text>

      <View style={ccStyles.metaRow}>
        {item.durationSeconds && item.durationSeconds > 0 ? (
          <Text style={ccStyles.meta}>{fmtDuration(item.durationSeconds)}</Text>
        ) : item.contentLength > 0 ? (
          <Text style={ccStyles.meta}>{fmtBytes(item.contentLength)}</Text>
        ) : null}
        {item.downloadedAt && (
          <Text style={ccStyles.meta}>· {fmtDate(item.downloadedAt)}</Text>
        )}
      </View>

      <Pressable style={ccStyles.moreBtn} onPress={onMorePress} hitSlop={8}>
        <Text style={ccStyles.moreBtnText}>•••</Text>
      </Pressable>
    </Pressable>
  );
}

const ccStyles = StyleSheet.create({
  card: {
    width: 150,
    marginRight: 12,
  },
  thumbWrap: { position: 'relative' },
  progressTrack: {
    height: 3,
    backgroundColor: 'rgba(255,255,255,0.12)',
    borderRadius: 2,
  },
  progressFill: {
    height: 3,
    backgroundColor: ACCENT,
    borderRadius: 2,
  },
  licBadge: {
    position: 'absolute',
    top: 6,
    left: 6,
    paddingHorizontal: 6,
    paddingVertical: 2,
    borderRadius: 4,
  },
  licBadgeText: { color: '#fff', fontSize: 9, fontWeight: '700' },
  title: { color: TEXT, fontSize: 12, fontWeight: '600', marginTop: 6, lineHeight: 16 },
  metaRow: { flexDirection: 'row', gap: 4, marginTop: 3, flexWrap: 'wrap' },
  meta: { color: TEXT_MUTED, fontSize: 10 },
  moreBtn: {
    marginTop: 4,
    alignSelf: 'flex-start',
    paddingHorizontal: 4,
    paddingVertical: 2,
  },
  moreBtnText: { color: TEXT_MUTED, fontSize: 14, letterSpacing: 1, fontWeight: '900' },
});

// ─── Section Header ─────────────────────────────────────────────────────────────

function SectionHeader({ title, count }: { title: string; count: number }) {
  return (
    <View style={shStyles.row}>
      <Text style={shStyles.title}>{title}</Text>
      <Text style={shStyles.count}>{count} {count === 1 ? 'video' : 'videos'}</Text>
    </View>
  );
}

const shStyles = StyleSheet.create({
  row: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', paddingHorizontal: 16, paddingTop: 20, paddingBottom: 8 },
  title: { color: TEXT, fontSize: 15, fontWeight: '700', flex: 1 },
  count: { color: TEXT_MUTED, fontSize: 12 },
});

// ─── Empty State ────────────────────────────────────────────────────────────────

function EmptyState() {
  return (
    <View style={emptyStyles.box}>
      <Text style={emptyStyles.icon}>⬇</Text>
      <Text style={emptyStyles.heading}>No Downloads Yet</Text>
      <Text style={emptyStyles.sub}>
        Open a lesson from the Learn tab and tap{'\n'}
        "Download for Offline Viewing" to watch{'\n'}
        without internet.
      </Text>
    </View>
  );
}

const emptyStyles = StyleSheet.create({
  box: { flex: 1, alignItems: 'center', justifyContent: 'center', padding: 40 },
  icon: { fontSize: 56, marginBottom: 16 },
  heading: { color: TEXT, fontSize: 20, fontWeight: '700', marginBottom: 10 },
  sub: { color: TEXT_MUTED, fontSize: 14, textAlign: 'center', lineHeight: 22 },
});

// ─── Manage Modal (bottom sheet) ────────────────────────────────────────────────

interface ManageModalProps {
  item: EnrichedDownload | null;
  visible: boolean;
  onClose: () => void;
  onDismiss: () => void;
  onDelete: (item: EnrichedDownload) => void;
  onRenew: (item: EnrichedDownload) => void;
  onPlay: (item: EnrichedDownload) => void;
}

function ManageModal({ item, visible, onClose, onDismiss, onDelete, onRenew, onPlay }: ManageModalProps) {
  if (!item) return null;
  const title = item.title ?? item.id;

  return (
    <Modal
      visible={visible}
      transparent
      animationType="slide"
      statusBarTranslucent
      onRequestClose={onClose}
      onDismiss={onDismiss}
    >
      <Pressable style={mmStyles.overlay} onPress={onClose} />
      <View style={mmStyles.sheet}>
        <View style={mmStyles.handle} />

        <Text style={mmStyles.title} numberOfLines={2}>{title}</Text>

        {item.contentLength > 0 && (
          <Text style={mmStyles.sub}>{fmtBytes(item.contentLength)} · Downloaded {fmtDate(item.downloadedAt)}</Text>
        )}

        <View style={mmStyles.divider} />

        {item.licStatus !== 'expired' && (
          <Pressable style={mmStyles.row} onPress={() => onPlay(item)}>
            <Text style={mmStyles.rowIcon}>▶</Text>
            <Text style={mmStyles.rowLabel}>Play Offline</Text>
          </Pressable>
        )}

        {(item.licStatus === 'expired' || item.licStatus === 'expiring') && (
          <Pressable style={mmStyles.row} onPress={() => { onClose(); onRenew(item); }}>
            <Text style={mmStyles.rowIcon}>↺</Text>
            <Text style={[mmStyles.rowLabel, { color: item.licStatus === 'expired' ? DANGER : WARN }]}>
              {item.licStatus === 'expired' ? 'License Expired — Renew' : 'Renew License (Expiring Soon)'}
            </Text>
          </Pressable>
        )}

        <Pressable style={mmStyles.row} onPress={() => { onClose(); onDelete(item); }}>
          <Text style={[mmStyles.rowIcon, { color: DANGER }]}>🗑</Text>
          <Text style={[mmStyles.rowLabel, { color: DANGER }]}>Delete Download</Text>
        </Pressable>

        <Pressable style={mmStyles.cancelRow} onPress={onClose}>
          <Text style={mmStyles.cancelText}>Cancel</Text>
        </Pressable>
      </View>
    </Modal>
  );
}

const mmStyles = StyleSheet.create({
  overlay: {
    flex: 1,
    backgroundColor: 'rgba(0,0,0,0.6)',
  },
  sheet: {
    backgroundColor: CARD_BG,
    borderTopLeftRadius: 20,
    borderTopRightRadius: 20,
    paddingTop: 12,
    paddingBottom: Platform.OS === 'android' ? 24 : 36,
    paddingHorizontal: 20,
  },
  handle: {
    alignSelf: 'center',
    width: 40,
    height: 4,
    borderRadius: 2,
    backgroundColor: SURFACE,
    marginBottom: 16,
  },
  title: { color: TEXT, fontSize: 16, fontWeight: '700', marginBottom: 4 },
  sub: { color: TEXT_MUTED, fontSize: 12, marginBottom: 12 },
  divider: { height: 1, backgroundColor: SURFACE, marginBottom: 8 },
  row: {
    flexDirection: 'row',
    alignItems: 'center',
    paddingVertical: 14,
    gap: 16,
  },
  rowIcon: { fontSize: 18, width: 24, textAlign: 'center', color: TEXT },
  rowLabel: { color: TEXT, fontSize: 15 },
  cancelRow: { marginTop: 8, paddingVertical: 14, alignItems: 'center' },
  cancelText: { color: TEXT_MUTED, fontSize: 15 },
});

// ─── Storage Bar ────────────────────────────────────────────────────────────────

function StorageBar({ usedBytes, freeBytes, count }: { usedBytes: number; freeBytes: number; count: number }) {
  const total = usedBytes + freeBytes;
  const fillPct = total > 0 ? Math.min(100, (usedBytes / total) * 100) : 0;
  const isLow = freeBytes > 0 && freeBytes < 2 * 1024 * 1024 * 1024;

  return (
    <View style={sbStyles.box}>
      <View style={sbStyles.row}>
        <Text style={sbStyles.label}>Storage</Text>
        <Text style={sbStyles.right}>
          {fmtBytes(usedBytes)} used · {count} {count === 1 ? 'video' : 'videos'}
        </Text>
      </View>
      <View style={sbStyles.track}>
        <View style={[sbStyles.fill, { width: `${fillPct}%` as any }, isLow && { backgroundColor: WARN }]} />
      </View>
      {isLow && <Text style={sbStyles.warn}>⚠ Less than 2 GB remaining</Text>}
    </View>
  );
}

const sbStyles = StyleSheet.create({
  box: { marginHorizontal: 16, marginBottom: 4, marginTop: 8 },
  row: { flexDirection: 'row', justifyContent: 'space-between', marginBottom: 6 },
  label: { color: TEXT_MUTED, fontSize: 11, fontWeight: '600', textTransform: 'uppercase', letterSpacing: 0.5 },
  right: { color: TEXT_MUTED, fontSize: 11 },
  track: { height: 4, backgroundColor: SURFACE, borderRadius: 2 },
  fill: { height: 4, backgroundColor: ACCENT, borderRadius: 2 },
  warn: { color: WARN, fontSize: 11, marginTop: 4 },
});

// ─── Main Screen ─────────────────────────────────────────────────────────────────

type Section =
  | { type: 'storage'; usedBytes: number; freeBytes: number; count: number }
  | { type: 'continue'; items: EnrichedDownload[] }
  | { type: 'active'; items: EnrichedDownload[] }
  | { type: 'course'; course: string; items: EnrichedDownload[] }
  | { type: 'empty' };

export default function DownloadsScreen() {
  const router = useRouter();
  const [items, setItems] = useState<DownloadInfo[]>([]);
  const [progressMap, setProgressMap] = useState<Record<string, ChapterProgress>>({});
  const [usedBytes, setUsedBytes] = useState(0);
  const [freeBytes, setFreeBytes] = useState(0);
  const [loading, setLoading] = useState(true);
  const [refreshing, setRefreshing] = useState(false);
  const [modalItem, setModalItem] = useState<EnrichedDownload | null>(null);
  const [resolvedTitles, setResolvedTitles] = useState<Record<string, string>>({});
  const resolvedTitlesRef = useRef<Record<string, string>>({});
  const pollRef = useRef<ReturnType<typeof setInterval> | null>(null);
  // pendingNavId: set before closing modal, consumed in onModalDismiss to
  // navigate AFTER the modal is fully gone (avoids NavigationContainer crash on Android).
  const pendingNavId = useRef<string | null>(null);

  // ── Load ──

  const load = useCallback(async () => {
    try {
      const [list, allProg] = await Promise.all([
        IcareOfflineDrm.listDownloads(),
        getAllProgress(),
      ]);
      setItems(list);
      const pm: Record<string, ChapterProgress> = {};
      for (const p of allProg) pm[p.chapterId] = p;
      setProgressMap(pm);

      try {
        const stats = await IcareOfflineDrm.getStorageStats();
        setUsedBytes(stats.usedBytes);
      } catch { /**/ }
      try {
        const f = await FileSystem.getFreeDiskStorageAsync();
        setFreeBytes(typeof f === 'number' ? f : 0);
      } catch { /**/ }
    } finally {
      setLoading(false);
      setRefreshing(false);
    }
  }, []);

  useEffect(() => { load(); }, [load]);

  // ── Live events ──

  useEffect(() => {
    const sub = onDownloadProgress((evt) => {
      setItems((prev) => {
        const idx = prev.findIndex((d) => d.id === evt.id);
        if (idx === -1) return [evt, ...prev];
        const next = [...prev];
        next[idx] = evt;
        return next;
      });
      if (evt.state === 'completed') {
        IcareOfflineDrm.getStorageStats()
          .then((s) => setUsedBytes(s.usedBytes))
          .catch(() => {});
      }
    });
    return () => sub.remove();
  }, []);

  // ── Fallback poll when active downloads exist ──

  useEffect(() => {
    const hasActive = items.some(
      (d) => d.state === 'downloading' || d.state === 'queued' || d.state === 'restarting'
    );
    if (hasActive && !pollRef.current) {
      pollRef.current = setInterval(async () => {
        const updated = await IcareOfflineDrm.listDownloads();
        setItems((prev) => {
          let changed = false;
          const next = prev.map((p) => {
            const u = updated.find((d) => d.id === p.id);
            if (!u) return p;
            if (u.bytesDownloaded !== p.bytesDownloaded || u.state !== p.state) {
              changed = true; return u;
            }
            return p;
          });
          return changed ? next : prev;
        });
        const stillActive = updated.some(
          (d) => d.state === 'downloading' || d.state === 'queued' || d.state === 'restarting'
        );
        if (!stillActive && pollRef.current) {
          clearInterval(pollRef.current);
          pollRef.current = null;
          IcareOfflineDrm.getStorageStats().then((s) => setUsedBytes(s.usedBytes)).catch(() => {});
        }
      }, 3000);
    }
    if (!hasActive && pollRef.current) {
      clearInterval(pollRef.current);
      pollRef.current = null;
    }
    return () => {
      if (pollRef.current) { clearInterval(pollRef.current); pollRef.current = null; }
    };
  }, [items.length]);

  // ── Resolve missing/raw-ID titles from Base44 API ──

  // Stable key: sorted IDs that still need a real title fetched.
  // Changes only when the set of unresolved IDs changes — NOT on every poll tick.
  const needsResolutionKey = useMemo(
    () =>
      items
        .filter((d) => !resolvedTitlesRef.current[d.id] && (!d.title || isRawId(d.title)))
        .map((d) => d.id)
        .sort()
        .join(','),
    [items]
  );

  useEffect(() => {
    if (!needsResolutionKey) return; // nothing to resolve
    let cancelled = false;
    (async () => {
      const toResolve = needsResolutionKey.split(',').filter(Boolean);
      const updates: Record<string, string> = {};
      for (const id of toResolve) {
        if (resolvedTitlesRef.current[id]) continue; // already resolved
        try {
          const { data } = await fetchChapter(id);
          if (data?.title) updates[id] = data.title;
        } catch { /* silently ignore — will show id as fallback */ }
      }
      if (!cancelled && Object.keys(updates).length > 0) {
        resolvedTitlesRef.current = { ...resolvedTitlesRef.current, ...updates };
        setResolvedTitles(resolvedTitlesRef.current);
      }
    })();
    return () => { cancelled = true; };
  }, [needsResolutionKey]);

  // ── Actions ──

  const navigateToPlayer = useCallback((id: string) => {
    router.push({
      pathname: '/player/[chapterId]',
      params: { chapterId: id },
    } as unknown as Href);
  }, [router]);

  // Called directly (no modal involved) — safe to navigate immediately.
  const playChapter = useCallback((id: string) => {
    navigateToPlayer(id);
  }, [navigateToPlayer]);

  // Called from inside ManageModal — close modal first, navigate after dismiss.
  const playChapterFromModal = useCallback((id: string) => {
    pendingNavId.current = id;
    setModalItem(null);
  }, []);

  const onModalDismiss = useCallback(() => {
    const id = pendingNavId.current;
    pendingNavId.current = null;
    if (id) navigateToPlayer(id);
  }, [navigateToPlayer]);

  const handleDelete = useCallback((item: EnrichedDownload) => {
    Alert.alert(
      'Delete Download',
      `Remove "${item.title ?? item.id}" from offline storage?`,
      [
        { text: 'Cancel', style: 'cancel' },
        {
          text: 'Delete',
          style: 'destructive',
          onPress: async () => {
            await IcareOfflineDrm.removeDownload(item.id);
            setItems((prev) => prev.filter((d) => d.id !== item.id));
            IcareOfflineDrm.getStorageStats().then((s) => setUsedBytes(s.usedBytes)).catch(() => {});
          },
        },
      ]
    );
  }, []);

  const handleRenew = useCallback((item: EnrichedDownload) => {
    Alert.alert(
      'Renew License',
      'Open this chapter online to renew the offline license. An internet connection is required.',
      [
        { text: 'Cancel', style: 'cancel' },
        {
          text: 'Open Chapter',
          onPress: () => navigateToPlayer(item.id),
        },
      ]
    );
  }, [navigateToPlayer]);

  // ── Enrich ──

  const enriched: EnrichedDownload[] = useMemo(
    () =>
      items.map((d) => ({
        ...d,
        // Prefer API-resolved title > stored title (only if it's not a raw ObjectId) > null
        title: resolvedTitles[d.id] ?? (isRawId(d.title) ? null : d.title) ?? null,
        progress: progressMap[d.id] ?? null,
        licStatus: licenseAge(d.downloadedAt),
      })),
    [items, progressMap, resolvedTitles]
  );

  // ── Build sections ──

  const sections: Section[] = useMemo(() => {
    const completed = enriched.filter((d) => d.state === 'completed');
    const active = enriched.filter((d) => d.state !== 'completed');

    if (enriched.length === 0) return [{ type: 'empty' }];

    const result: Section[] = [];

    result.push({ type: 'storage', usedBytes, freeBytes, count: completed.length });

    // Continue Watching — completed chapters with >1% progress, sorted by last watched
    const continueItems = completed
      .filter((d) => (d.progress?.percentWatched ?? 0) > 1 && (d.progress?.percentWatched ?? 0) < 95)
      .sort((a, b) => {
        const ta = a.progress?.lastWatchedAt ?? '';
        const tb = b.progress?.lastWatchedAt ?? '';
        return tb.localeCompare(ta);
      })
      .slice(0, 10);

    if (continueItems.length > 0) {
      result.push({ type: 'continue', items: continueItems });
    }

    // Active downloads
    if (active.length > 0) {
      result.push({ type: 'active', items: active });
    }

    // Completed grouped by course
    const courseMap = new Map<string, EnrichedDownload[]>();
    for (const d of completed) {
      const key = courseKey(d.title);
      const arr = courseMap.get(key) ?? [];
      arr.push(d);
      courseMap.set(key, arr);
    }

    for (const [course, courseItems] of courseMap.entries()) {
      result.push({ type: 'course', course, items: courseItems });
    }

    return result;
  }, [enriched, usedBytes, freeBytes]);

  // ── Render section ──

  const renderSection = useCallback((section: Section, index: number) => {
    switch (section.type) {
      case 'storage':
        return (
          <StorageBar
            key="storage"
            usedBytes={section.usedBytes}
            freeBytes={section.freeBytes}
            count={section.count}
          />
        );

      case 'continue':
        return (
          <View key="continue">
            <SectionHeader title="Continue Watching" count={section.items.length} />
            <ScrollView
              horizontal
              showsHorizontalScrollIndicator={false}
              contentContainerStyle={{ paddingHorizontal: 16, paddingBottom: 8 }}
            >
              {section.items.map((item) => (
                <ContinueWatchingCard
                  key={item.id}
                  item={item}
                  onPress={() => playChapter(item.id)}
                />
              ))}
            </ScrollView>
          </View>
        );

      case 'active':
        return (
          <View key="active" style={{ paddingHorizontal: 16 }}>
            <SectionHeader title="Downloading" count={section.items.length} />
            {section.items.map((item) => (
              <ActiveDownloadCard
                key={item.id}
                item={item}
                onPause={() => IcareOfflineDrm.pauseDownload(item.id)}
                onResume={() => IcareOfflineDrm.resumeDownload(item.id)}
                onCancel={() => handleDelete(item)}
              />
            ))}
          </View>
        );

      case 'course': {
        const displayName =
          section.course === '__ungrouped__' ? 'Downloaded Videos' : section.course;
        return (
          <View key={`course-${section.course}`}>
            <SectionHeader title={displayName} count={section.items.length} />
            <ScrollView
              horizontal
              showsHorizontalScrollIndicator={false}
              contentContainerStyle={{ paddingHorizontal: 16, paddingBottom: 12 }}
            >
              {section.items.map((item) => (
                <ContentCard
                  key={item.id}
                  item={item}
                  onPress={() => {
                    if (item.licStatus === 'expired') {
                      setModalItem(item);
                    } else {
                      playChapter(item.id);
                    }
                  }}
                  onMorePress={() => setModalItem(item)}
                />
              ))}
            </ScrollView>
          </View>
        );
      }

      case 'empty':
        return <EmptyState key="empty" />;

      default:
        return null;
    }
  }, [playChapter, handleDelete]);

  // ── Loading ──

  if (loading) {
    return (
      <View style={screenStyles.loadingBox}>
        <ActivityIndicator size="large" color={ACCENT} />
      </View>
    );
  }

  return (
    <View style={screenStyles.screen}>
      {/* Header */}
      <View style={screenStyles.header}>
        <Text style={screenStyles.headerTitle}>My Downloads</Text>
      </View>

      {/* Sections */}
      <ScrollView
        style={screenStyles.scroll}
        contentContainerStyle={enriched.length === 0 ? screenStyles.scrollEmpty : screenStyles.scrollContent}
        refreshControl={
          <RefreshControl
            refreshing={refreshing}
            tintColor={ACCENT}
            colors={[ACCENT]}
            onRefresh={() => { setRefreshing(true); load(); }}
          />
        }
      >
        {sections.map((s, i) => renderSection(s, i))}
        <View style={{ height: 24 }} />
      </ScrollView>

      {/* Manage modal — navigation happens in onDismiss, after modal is fully gone */}
      <ManageModal
        item={modalItem}
        visible={modalItem !== null}
        onClose={() => setModalItem(null)}
        onDismiss={onModalDismiss}
        onDelete={(item) => { setModalItem(null); handleDelete(item); }}
        onRenew={(item) => { setModalItem(null); handleRenew(item); }}
        onPlay={(item) => playChapterFromModal(item.id)}
      />
    </View>
  );
}

const screenStyles = StyleSheet.create({
  screen: { flex: 1, backgroundColor: BG },
  loadingBox: { flex: 1, backgroundColor: BG, alignItems: 'center', justifyContent: 'center' },
  header: {
    paddingTop: 16,
    paddingBottom: 12,
    paddingHorizontal: 16,
    backgroundColor: BG,
  },
  headerTitle: { color: TEXT, fontSize: 26, fontWeight: '800', letterSpacing: -0.5 },
  scroll: { flex: 1 },
  scrollContent: { paddingBottom: 40 },
  scrollEmpty: { flex: 1 },
});
