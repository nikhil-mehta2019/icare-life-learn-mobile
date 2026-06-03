/**
 * Download Center — full offline learning management screen.
 *
 * Sections:
 *   1. Storage summary header (used bytes, device free space, download count)
 *   2. Filter chips: All / Downloading / Downloaded / Expired / Failed
 *   3. Download list with per-item actions
 *
 * Each download card shows:
 *   - Chapter title (or ID fallback)
 *   - Status badge + progress bar
 *   - File size
 *   - Completed date
 *   - License status (Active / Expiring Soon / Expired)
 *   - Last watched position (from local progress store)
 *   - Actions: Play / Pause / Resume / Delete / Renew License
 */

import * as FileSystem from 'expo-file-system';
import { useRouter, type Href } from 'expo-router';
import { useCallback, useEffect, useMemo, useState } from 'react';
import {
  ActivityIndicator,
  Alert,
  FlatList,
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
  type StorageStats,
} from '../../modules/icare-offline-drm';
import { getAllProgress, type ChapterProgress } from '../../store/offlineProgress';

// ─── Types ─────────────────────────────────────────────────────────────────────

type FilterTab = 'all' | 'downloading' | 'downloaded' | 'failed';

// ─── Helpers ───────────────────────────────────────────────────────────────────

function formatBytes(bytes: number): string {
  if (bytes <= 0) return '0 B';
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  if (bytes < 1024 * 1024 * 1024) return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
  return `${(bytes / (1024 * 1024 * 1024)).toFixed(2)} GB`;
}

function formatDate(iso: string | null | undefined): string {
  if (!iso) return '—';
  try {
    const d = new Date(iso);
    return d.toLocaleDateString(undefined, { day: 'numeric', month: 'short', year: 'numeric' });
  } catch {
    return '—';
  }
}

function formatDuration(seconds: number): string {
  if (seconds <= 0) return '0:00';
  const m = Math.floor(seconds / 60);
  const s = Math.floor(seconds % 60);
  return `${m}:${s.toString().padStart(2, '0')}`;
}

/** Mux offline DRM licenses are 30-day by default. We flag "expiring soon" at 5 days. */
function licenseStatus(downloadedAt: string | null | undefined): 'active' | 'expiring' | 'expired' | 'unknown' {
  if (!downloadedAt) return 'unknown';
  try {
    const acquired = new Date(downloadedAt).getTime();
    const now = Date.now();
    const ageMs = now - acquired;
    const thirtyDaysMs = 30 * 24 * 60 * 60 * 1000;
    const fiveDaysMs = 5 * 24 * 60 * 60 * 1000;
    if (ageMs > thirtyDaysMs) return 'expired';
    if (ageMs > thirtyDaysMs - fiveDaysMs) return 'expiring';
    return 'active';
  } catch {
    return 'unknown';
  }
}

function licenseExpiresLabel(downloadedAt: string | null | undefined): string {
  if (!downloadedAt) return '';
  try {
    const acquired = new Date(downloadedAt).getTime();
    const expiresAt = new Date(acquired + 30 * 24 * 60 * 60 * 1000);
    return `Expires ${expiresAt.toLocaleDateString(undefined, { day: 'numeric', month: 'short' })}`;
  } catch {
    return '';
  }
}

// ─── StorageSummary ────────────────────────────────────────────────────────────

function StorageSummary({ stats, freeBytes }: { stats: StorageStats; freeBytes: number }) {
  const LOW_STORAGE_THRESHOLD = 2 * 1024 * 1024 * 1024; // 2 GB
  const isLow = freeBytes > 0 && freeBytes < LOW_STORAGE_THRESHOLD;

  return (
    <View style={summaryStyles.card}>
      <Text style={summaryStyles.heading}>Downloads Storage</Text>
      <View style={summaryStyles.row}>
        <View style={summaryStyles.stat}>
          <Text style={summaryStyles.value}>{formatBytes(stats.usedBytes)}</Text>
          <Text style={summaryStyles.label}>Used</Text>
        </View>
        <View style={summaryStyles.divider} />
        <View style={summaryStyles.stat}>
          <Text style={[summaryStyles.value, isLow && summaryStyles.valueWarn]}>
            {freeBytes > 0 ? formatBytes(freeBytes) : '—'}
          </Text>
          <Text style={summaryStyles.label}>Available</Text>
        </View>
        <View style={summaryStyles.divider} />
        <View style={summaryStyles.stat}>
          <Text style={summaryStyles.value}>{stats.downloadCount}</Text>
          <Text style={summaryStyles.label}>{stats.downloadCount === 1 ? 'Video' : 'Videos'}</Text>
        </View>
      </View>
      {isLow && (
        <View style={summaryStyles.warningBanner}>
          <Text style={summaryStyles.warningText}>
            ⚠ Less than 2 GB storage remaining. Delete unused downloads to free space.
          </Text>
        </View>
      )}
    </View>
  );
}

const summaryStyles = StyleSheet.create({
  card: {
    backgroundColor: '#1D3D47',
    borderRadius: 14,
    padding: 16,
    margin: 12,
    marginBottom: 4,
  },
  heading: { color: '#fff', fontSize: 15, fontWeight: '700', marginBottom: 12 },
  row: { flexDirection: 'row', justifyContent: 'space-around' },
  stat: { alignItems: 'center', flex: 1 },
  value: { color: '#fff', fontSize: 20, fontWeight: '700' },
  valueWarn: { color: '#FFD54F' },
  label: { color: 'rgba(255,255,255,0.65)', fontSize: 12, marginTop: 2 },
  divider: { width: 1, backgroundColor: 'rgba(255,255,255,0.2)', marginHorizontal: 4 },
  warningBanner: {
    marginTop: 12,
    backgroundColor: 'rgba(255,213,79,0.15)',
    borderRadius: 8,
    padding: 10,
    borderLeftWidth: 3,
    borderLeftColor: '#FFD54F',
  },
  warningText: { color: '#FFD54F', fontSize: 12, lineHeight: 17 },
});

// ─── FilterChips ───────────────────────────────────────────────────────────────

function FilterChips({
  active,
  counts,
  onChange,
}: {
  active: FilterTab;
  counts: Record<FilterTab, number>;
  onChange: (t: FilterTab) => void;
}) {
  const tabs: { key: FilterTab; label: string }[] = [
    { key: 'all', label: 'All' },
    { key: 'downloading', label: 'Downloading' },
    { key: 'downloaded', label: 'Downloaded' },
    { key: 'failed', label: 'Failed' },
  ];
  return (
    <ScrollView
      horizontal
      showsHorizontalScrollIndicator={false}
      contentContainerStyle={chipStyles.row}
    >
      {tabs.map((t) => (
        <Pressable
          key={t.key}
          style={[chipStyles.chip, active === t.key && chipStyles.chipActive]}
          onPress={() => onChange(t.key)}
        >
          <Text style={[chipStyles.label, active === t.key && chipStyles.labelActive]}>
            {t.label}
            {counts[t.key] > 0 ? ` (${counts[t.key]})` : ''}
          </Text>
        </Pressable>
      ))}
    </ScrollView>
  );
}

const chipStyles = StyleSheet.create({
  row: { paddingHorizontal: 12, paddingVertical: 8, gap: 8 },
  chip: {
    paddingHorizontal: 14,
    paddingVertical: 7,
    borderRadius: 20,
    backgroundColor: '#f0f0f0',
  },
  chipActive: { backgroundColor: '#1D3D47' },
  label: { fontSize: 13, color: '#555', fontWeight: '500' },
  labelActive: { color: '#fff' },
});

// ─── ProgressBar ───────────────────────────────────────────────────────────────

function ProgressBar({ pct }: { pct: number }) {
  const w = Math.max(0, Math.min(100, pct));
  return (
    <View style={pbStyles.track}>
      <View style={[pbStyles.fill, { width: `${w}%` as any }]} />
    </View>
  );
}

const pbStyles = StyleSheet.create({
  track: { height: 4, backgroundColor: '#e0e0e0', borderRadius: 2, marginTop: 6 },
  fill: { height: 4, backgroundColor: '#2196F3', borderRadius: 2 },
});

// ─── LicenseBadge ──────────────────────────────────────────────────────────────

function LicenseBadge({ status }: { status: ReturnType<typeof licenseStatus> }) {
  const config = {
    active: { label: 'License Active', bg: '#E8F5E9', color: '#2E7D32' },
    expiring: { label: 'Expiring Soon', bg: '#FFF8E1', color: '#F57F17' },
    expired: { label: 'License Expired', bg: '#FFEBEE', color: '#C62828' },
    unknown: { label: 'License Unknown', bg: '#F5F5F5', color: '#757575' },
  }[status];
  return (
    <View style={[lbStyles.badge, { backgroundColor: config.bg }]}>
      <Text style={[lbStyles.text, { color: config.color }]}>{config.label}</Text>
    </View>
  );
}

const lbStyles = StyleSheet.create({
  badge: { paddingHorizontal: 8, paddingVertical: 3, borderRadius: 6, alignSelf: 'flex-start' },
  text: { fontSize: 11, fontWeight: '600' },
});

// ─── DownloadCard ──────────────────────────────────────────────────────────────

interface DownloadCardProps {
  item: DownloadInfo;
  progress: ChapterProgress | null;
  onPlay: () => void;
  onPause: () => void;
  onResume: () => void;
  onDelete: () => void;
  onRenew: () => void;
}

function DownloadCard({
  item,
  progress,
  onPlay,
  onPause,
  onResume,
  onDelete,
  onRenew,
}: DownloadCardProps) {
  const title = item.title ?? item.id;
  const licStat = licenseStatus(item.downloadedAt);
  const isCompleted = item.state === 'completed';
  const isDownloading = item.state === 'downloading';
  const isQueued = item.state === 'queued' || item.state === 'restarting';
  const isStopped = item.state === 'stopped';
  const isFailed = item.state === 'failed';

  const pct = item.percentDownloaded >= 0 ? item.percentDownloaded : 0;

  return (
    <View style={cardStyles.card}>
      {/* Title */}
      <Text style={cardStyles.title} numberOfLines={2}>{title}</Text>

      {/* Status line */}
      <View style={cardStyles.statusRow}>
        <View style={[cardStyles.dot, { backgroundColor: statusColor(item.state) }]} />
        <Text style={cardStyles.statusText}>{stateLabel(item)}</Text>
      </View>

      {/* Progress bar while downloading */}
      {(isDownloading || isQueued) && pct > 0 && <ProgressBar pct={pct} />}

      {/* Metadata row */}
      <View style={cardStyles.metaRow}>
        {item.contentLength > 0 && (
          <Text style={cardStyles.meta}>{formatBytes(item.bytesDownloaded)} / {formatBytes(item.contentLength)}</Text>
        )}
        {isCompleted && item.downloadedAt && (
          <Text style={cardStyles.meta}>Downloaded {formatDate(item.downloadedAt)}</Text>
        )}
      </View>

      {/* License + expiry */}
      {isCompleted && (
        <View style={cardStyles.licenseRow}>
          <LicenseBadge status={licStat} />
          {licStat !== 'expired' && (
            <Text style={cardStyles.expiryText}>{licenseExpiresLabel(item.downloadedAt)}</Text>
          )}
        </View>
      )}

      {/* Last watched position */}
      {progress && progress.watchedSeconds > 0 && (
        <Text style={cardStyles.meta}>
          Last watched: {formatDuration(progress.watchedSeconds)}
          {progress.percentWatched > 0 ? ` (${Math.round(progress.percentWatched)}%)` : ''}
        </Text>
      )}

      {/* Action buttons */}
      <View style={cardStyles.actions}>
        {isCompleted && licStat !== 'expired' && (
          <Pressable style={[cardStyles.btn, cardStyles.btnPrimary]} onPress={onPlay}>
            <Text style={cardStyles.btnTextLight}>▶  Play Offline</Text>
          </Pressable>
        )}
        {isDownloading && (
          <Pressable style={[cardStyles.btn, cardStyles.btnSecondary]} onPress={onPause}>
            <Text style={cardStyles.btnTextDark}>⏸  Pause</Text>
          </Pressable>
        )}
        {(isQueued || isStopped) && (
          <Pressable style={[cardStyles.btn, cardStyles.btnSecondary]} onPress={onResume}>
            <Text style={cardStyles.btnTextDark}>▶  Resume</Text>
          </Pressable>
        )}
        {isFailed && (
          <Pressable style={[cardStyles.btn, cardStyles.btnSecondary]} onPress={onResume}>
            <Text style={cardStyles.btnTextDark}>↺  Retry</Text>
          </Pressable>
        )}
        {isCompleted && licStat === 'expired' && (
          <Pressable style={[cardStyles.btn, cardStyles.btnSecondary]} onPress={onRenew}>
            <Text style={cardStyles.btnTextDark}>↺  Renew License</Text>
          </Pressable>
        )}
        {isCompleted && (licStat === 'expiring') && (
          <Pressable style={[cardStyles.btn, cardStyles.btnWarn]} onPress={onRenew}>
            <Text style={cardStyles.btnTextDark}>↺  Renew License</Text>
          </Pressable>
        )}
        <Pressable style={[cardStyles.btn, cardStyles.btnDanger]} onPress={onDelete}>
          <Text style={cardStyles.btnTextLight}>Delete</Text>
        </Pressable>
      </View>
    </View>
  );
}

function statusColor(state: string): string {
  switch (state) {
    case 'completed': return '#4CAF50';
    case 'downloading': return '#2196F3';
    case 'queued': case 'restarting': return '#FF9800';
    case 'failed': return '#F44336';
    case 'stopped': return '#9E9E9E';
    default: return '#9E9E9E';
  }
}

function stateLabel(item: DownloadInfo): string {
  switch (item.state) {
    case 'completed': return 'Downloaded ✓';
    case 'downloading':
      return item.percentDownloaded >= 0
        ? `Downloading ${Math.round(item.percentDownloaded)}%`
        : 'Downloading…';
    case 'queued': return 'Queued…';
    case 'restarting': return 'Restarting…';
    case 'stopped': return 'Paused';
    case 'removing': return 'Removing…';
    case 'failed': return `Failed${item.failureReason ? ': ' + item.failureReason : ''}`;
    default: return item.state;
  }
}

const cardStyles = StyleSheet.create({
  card: {
    backgroundColor: '#fff',
    borderRadius: 12,
    padding: 14,
    marginBottom: 10,
    elevation: 2,
    shadowColor: '#000',
    shadowOffset: { width: 0, height: 1 },
    shadowOpacity: 0.08,
    shadowRadius: 4,
  },
  title: { fontSize: 14, fontWeight: '700', color: '#1a1a1a', lineHeight: 20, marginBottom: 6 },
  statusRow: { flexDirection: 'row', alignItems: 'center', gap: 6, marginBottom: 4 },
  dot: { width: 8, height: 8, borderRadius: 4 },
  statusText: { fontSize: 12, color: '#555' },
  metaRow: { flexDirection: 'row', gap: 12, marginTop: 6, flexWrap: 'wrap' },
  meta: { fontSize: 11, color: '#888' },
  licenseRow: { flexDirection: 'row', alignItems: 'center', gap: 10, marginTop: 8 },
  expiryText: { fontSize: 11, color: '#888' },
  actions: { flexDirection: 'row', flexWrap: 'wrap', gap: 8, marginTop: 12 },
  btn: { paddingHorizontal: 14, paddingVertical: 8, borderRadius: 8 },
  btnPrimary: { backgroundColor: '#1D3D47' },
  btnSecondary: { backgroundColor: '#f0f0f0' },
  btnWarn: { backgroundColor: '#FFF8E1', borderWidth: 1, borderColor: '#FFB300' },
  btnDanger: { backgroundColor: '#FFEBEE' },
  btnTextLight: { color: '#fff', fontSize: 13, fontWeight: '600' },
  btnTextDark: { color: '#333', fontSize: 13, fontWeight: '600' },
});

// ─── Main Screen ───────────────────────────────────────────────────────────────

export default function DownloadCenterScreen() {
  const router = useRouter();
  const [items, setItems] = useState<DownloadInfo[]>([]);
  const [stats, setStats] = useState<StorageStats>({ usedBytes: 0, downloadCount: 0 });
  const [freeBytes, setFreeBytes] = useState(0);
  const [progressMap, setProgressMap] = useState<Record<string, ChapterProgress>>({});
  const [filter, setFilter] = useState<FilterTab>('all');
  const [loading, setLoading] = useState(true);
  const [refreshing, setRefreshing] = useState(false);

  const load = useCallback(async () => {
    try {
      const [list, s, allProg] = await Promise.all([
        IcareOfflineDrm.listDownloads(),
        IcareOfflineDrm.getStorageStats(),
        getAllProgress(),
      ]);
      setItems(list);
      setStats(s);

      // Device free space via expo-file-system
      try {
        const fsInfo = await FileSystem.getFreeDiskStorageAsync();
        setFreeBytes(typeof fsInfo === 'number' ? fsInfo : 0);
      } catch {
        setFreeBytes(0);
      }

      const pm: Record<string, ChapterProgress> = {};
      for (const p of allProg) pm[p.chapterId] = p;
      setProgressMap(pm);
    } finally {
      setLoading(false);
      setRefreshing(false);
    }
  }, []);

  useEffect(() => { load(); }, [load]);

  // Live progress updates
  useEffect(() => {
    const sub = onDownloadProgress((evt) => {
      setItems((prev) => {
        const idx = prev.findIndex((d) => d.id === evt.id);
        if (idx === -1) return [evt, ...prev];
        const next = [...prev];
        next[idx] = evt;
        return next;
      });
      // Refresh stats when a download completes
      if (evt.state === 'completed') {
        IcareOfflineDrm.getStorageStats().then(setStats).catch(() => {});
      }
    });
    return () => sub.remove();
  }, []);

  // ── Actions ──

  const handleDelete = useCallback((id: string, title: string) => {
    Alert.alert(
      'Delete Download',
      `Remove "${title}" from offline storage?`,
      [
        { text: 'Cancel', style: 'cancel' },
        {
          text: 'Delete',
          style: 'destructive',
          onPress: async () => {
            await IcareOfflineDrm.removeDownload(id);
            setItems((prev) => prev.filter((d) => d.id !== id));
            IcareOfflineDrm.getStorageStats().then(setStats).catch(() => {});
          },
        },
      ]
    );
  }, []);

  const handlePause = useCallback(async (id: string) => {
    await IcareOfflineDrm.pauseDownload(id);
  }, []);

  const handleResume = useCallback(async (id: string) => {
    await IcareOfflineDrm.resumeDownload(id);
  }, []);

  const handleRenew = useCallback((id: string) => {
    // License renewal requires fresh DRM tokens from the WebView bridge.
    // Navigate to the player for this chapter — the player handles token acquisition
    // and exposes a Renew action when the license is expired.
    Alert.alert(
      'Renew License',
      'Open this chapter to renew the offline license. You need an internet connection.',
      [
        { text: 'Cancel', style: 'cancel' },
        {
          text: 'Open Chapter',
          onPress: () =>
            router.push({
              pathname: '/player/[chapterId]',
              params: { chapterId: id },
            } as unknown as Href),
        },
      ]
    );
  }, [router]);

  // ── Filter ──

  const counts: Record<FilterTab, number> = useMemo(() => {
    const c = { all: items.length, downloading: 0, downloaded: 0, failed: 0 };
    for (const d of items) {
      if (d.state === 'downloading' || d.state === 'queued') c.downloading++;
      else if (d.state === 'completed') c.downloaded++;
      else if (d.state === 'failed') c.failed++;
    }
    return c;
  }, [items]);

  const filtered = useMemo(() => {
    switch (filter) {
      case 'downloading': return items.filter((d) => d.state === 'downloading' || d.state === 'queued' || d.state === 'stopped');
      case 'downloaded': return items.filter((d) => d.state === 'completed');
      case 'failed': return items.filter((d) => d.state === 'failed');
      default: return items;
    }
  }, [items, filter]);

  // ── Render ──

  if (loading) {
    return (
      <View style={screenStyles.center}>
        <ActivityIndicator size="large" color="#1D3D47" />
      </View>
    );
  }

  return (
    <View style={screenStyles.screen}>
      {/* Storage summary */}
      <StorageSummary stats={stats} freeBytes={freeBytes} />

      {/* Filter chips */}
      <FilterChips active={filter} counts={counts} onChange={setFilter} />

      {/* Download list */}
      {filtered.length === 0 ? (
        <View style={screenStyles.emptyBox}>
          {items.length === 0 ? (
            <>
              <Text style={screenStyles.emptyTitle}>No downloads yet</Text>
              <Text style={screenStyles.muted}>
                Open a lesson and tap "Download for Offline Viewing".
              </Text>
            </>
          ) : (
            <Text style={screenStyles.muted}>No downloads in this category.</Text>
          )}
        </View>
      ) : (
        <FlatList
          data={filtered}
          keyExtractor={(d) => d.id}
          contentContainerStyle={screenStyles.list}
          refreshControl={
            <RefreshControl
              refreshing={refreshing}
              colors={['#1D3D47']}
              onRefresh={() => { setRefreshing(true); load(); }}
            />
          }
          renderItem={({ item }) => (
            <DownloadCard
              item={item}
              progress={progressMap[item.id] ?? null}
              onPlay={() =>
                router.push({
                  pathname: '/player/[chapterId]',
                  params: { chapterId: item.id },
                } as unknown as Href)
              }
              onPause={() => handlePause(item.id)}
              onResume={() => handleResume(item.id)}
              onDelete={() => handleDelete(item.id, item.title ?? item.id)}
              onRenew={() => handleRenew(item.id)}
            />
          )}
        />
      )}
    </View>
  );
}

const screenStyles = StyleSheet.create({
  screen: { flex: 1, backgroundColor: '#F5F5F5' },
  center: { flex: 1, alignItems: 'center', justifyContent: 'center' },
  list: { padding: 12, paddingTop: 8 },
  emptyBox: {
    flex: 1,
    alignItems: 'center',
    justifyContent: 'center',
    padding: 32,
    gap: 8,
  },
  emptyTitle: { fontSize: 16, fontWeight: '600', color: '#333' },
  muted: { fontSize: 13, color: '#888', textAlign: 'center', lineHeight: 19 },
});
