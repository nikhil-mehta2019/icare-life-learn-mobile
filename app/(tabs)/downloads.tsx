import { useRouter, type Href } from 'expo-router';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  ActivityIndicator,
  Alert,
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
import { fetchChapter, fetchCourse, fetchModule } from '../../api/base44Client';
import IcareOfflineDrm, {
  onDownloadProgress,
  type DeviceStorageStats,
  type DownloadEntitlement,
  type DownloadInfo,
} from '../../modules/icare-offline-drm';
import { getAllProgress, type ChapterProgress } from '../../store/offlineProgress';

const BG = '#0F1923';
const CARD_BG = '#1C2B35';
const SURFACE = '#243344';
const TEXT = '#F0F4F8';
const TEXT_MUTED = '#8A9BB0';
const ACCENT = '#4FC3F7';
const SUCCESS = '#66BB6A';
const WARN = '#FFA726';
const DANGER = '#EF5350';

const ZERO_DEVICE_STORAGE: DeviceStorageStats = {
  totalBytes: 0,
  usedBytes: 0,
  freeBytes: 0,
};

function fmtBytes(bytes: number): string {
  if (!Number.isFinite(bytes) || bytes <= 0) return '0 B';
  if (bytes < 1024 * 1024) return `${Math.round(bytes / 1024)} KB`;
  if (bytes < 1024 * 1024 * 1024) return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
  return `${(bytes / (1024 * 1024 * 1024)).toFixed(2)} GB`;
}

function fmtDuration(sec: number): string {
  if (!sec || sec <= 0) return '';
  const h = Math.floor(sec / 3600);
  const m = Math.floor((sec % 3600) / 60);
  const s = Math.floor(sec % 60);
  if (h > 0) return `${h}h ${m}m`;
  if (m > 0) return `${m}m ${s}s`;
  return `${s}s`;
}

function fmtDate(iso: string | null | undefined): string {
  if (!iso) return '';
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return '';
  return d.toLocaleDateString(undefined, { day: 'numeric', month: 'short', year: 'numeric' });
}

function accessState(expiresAt: string | null | undefined): 'active' | 'expiring' | 'expired' {
  if (!expiresAt) return 'active';
  const time = new Date(expiresAt).getTime();
  if (!Number.isFinite(time)) return 'active';
  const remaining = time - Date.now();
  if (remaining <= 0) return 'expired';
  if (remaining <= 5 * 24 * 60 * 60 * 1000) return 'expiring';
  return 'active';
}

function isRawId(value: string | null | undefined): boolean {
  return !!value && /^[0-9a-f]{24}$/i.test(value);
}

function courseKey(title: string | null | undefined): string {
  if (!title) return '__ungrouped__';
  const sep = title.includes(' – ') ? ' – ' : title.includes(': ') ? ': ' : null;
  return sep ? title.split(sep)[0].trim() : title.trim();
}

interface EnrichedDownload extends DownloadInfo {
  progress: ChapterProgress | null;
  entitlement: DownloadEntitlement | null;
  accessStatus: 'active' | 'expiring' | 'expired';
  courseName: string | null;
  moduleName: string | null;
}

function Thumbnail({ size, url, showPlay = false }: { size: number; url?: string | null; showPlay?: boolean }) {
  return (
    <View style={[styles.thumb, { width: size, height: size * 0.5625 }]}>
      {url ? (
        <Image source={{ uri: url }} style={StyleSheet.absoluteFill} resizeMode="cover" />
      ) : (
        <Text style={styles.thumbIcon}>🎬</Text>
      )}
      {showPlay ? (
        <View style={styles.playBadge}>
          <Text style={styles.playBadgeText}>▶</Text>
        </View>
      ) : null}
    </View>
  );
}

function StorageSummary({
  device,
  offlineBytes,
  count,
}: {
  device: DeviceStorageStats;
  offlineBytes: number;
  count: number;
}) {
  const pct = device.totalBytes > 0
    ? Math.min(100, (device.usedBytes / device.totalBytes) * 100)
    : 0;
  const isLow = device.freeBytes > 0 && device.freeBytes < 2 * 1024 * 1024 * 1024;

  return (
    <View style={styles.storageCard}>
      <View style={styles.storageTopRow}>
        <View>
          <Text style={styles.eyebrow}>DEVICE STORAGE</Text>
          <Text style={styles.storageHeadline}>
            {device.totalBytes > 0 ? `${fmtBytes(device.freeBytes)} available` : 'Storage unavailable'}
          </Text>
        </View>
        <Text style={styles.storageTotal}>
          {device.totalBytes > 0 ? `${fmtBytes(device.totalBytes)} total` : ''}
        </Text>
      </View>

      <View style={styles.storageTrack}>
        <View
          style={[
            styles.storageFill,
            { width: `${pct}%` as any },
            isLow && { backgroundColor: WARN },
          ]}
        />
      </View>

      <View style={styles.storageMetaRow}>
        <Text style={styles.storageMeta}>
          Device used {fmtBytes(device.usedBytes)}
        </Text>
        <Text style={styles.storageMeta}>
          iCare offline {fmtBytes(offlineBytes)} · {count} {count === 1 ? 'video' : 'videos'}
        </Text>
      </View>

      {isLow ? (
        <Text style={styles.storageWarning}>⚠ Low storage. Keep at least 2 GB free for reliable downloads.</Text>
      ) : null}
    </View>
  );
}

function SectionHeader({ title, count }: { title: string; count: number }) {
  return (
    <View style={styles.sectionHeader}>
      <Text style={styles.sectionTitle}>{title}</Text>
      <Text style={styles.sectionCount}>{count} {count === 1 ? 'video' : 'videos'}</Text>
    </View>
  );
}

function ModuleHeader({ title, count }: { title: string; count: number }) {
  return (
    <View style={styles.moduleHeader}>
      <View style={styles.moduleAccent} />
      <Text style={styles.moduleTitle} numberOfLines={1}>{title}</Text>
      <Text style={styles.sectionCount}>{count}</Text>
    </View>
  );
}

function ContinueWatchingCard({ item, onPress }: { item: EnrichedDownload; onPress: () => void }) {
  const pct = Math.min(100, item.progress?.percentWatched ?? 0);
  return (
    <Pressable style={styles.continueCard} onPress={onPress}>
      <Thumbnail size={160} url={item.thumbnailUrl} showPlay />
      <View style={styles.watchTrack}>
        <View style={[styles.watchFill, { width: `${pct}%` as any }]} />
      </View>
      <Text style={styles.compactTitle} numberOfLines={2}>{item.title ?? item.id}</Text>
      <Text style={styles.smallMeta}>{Math.round(pct)}% watched</Text>
    </Pressable>
  );
}

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
  const pct = item.percentDownloaded >= 0 ? Math.min(100, item.percentDownloaded) : 0;
  const isDownloading = item.state === 'downloading';
  const isFailed = item.state === 'failed';

  return (
    <View style={styles.activeCard}>
      <Thumbnail size={76} url={item.thumbnailUrl} />
      <View style={{ flex: 1 }}>
        <Text style={styles.activeTitle} numberOfLines={2}>{item.title ?? item.id}</Text>
        {!isFailed ? (
          <>
            <View style={styles.progressRow}>
              <View style={styles.downloadTrack}>
                <View style={[styles.downloadFill, { width: `${pct}%` as any }]} />
              </View>
              <Text style={styles.progressPct}>{Math.round(pct)}%</Text>
            </View>
            <Text style={styles.smallMeta}>
              {fmtBytes(item.bytesDownloaded)}
              {item.contentLength > 0 ? ` / ${fmtBytes(item.contentLength)}` : ''}
              {item.state === 'queued' ? ' · Queued' : item.state === 'stopped' ? ' · Paused' : ''}
            </Text>
          </>
        ) : (
          <Text style={[styles.smallMeta, { color: DANGER }]}>Download failed</Text>
        )}
        <View style={styles.actionRow}>
          {isDownloading ? (
            <Pressable style={styles.actionButton} onPress={onPause}>
              <Text style={styles.actionText}>⏸ Pause</Text>
            </Pressable>
          ) : null}
          {(item.state === 'queued' || item.state === 'stopped' || isFailed) ? (
            <Pressable style={styles.actionButton} onPress={onResume}>
              <Text style={styles.actionText}>▶ {isFailed ? 'Retry' : 'Resume'}</Text>
            </Pressable>
          ) : null}
          <Pressable style={styles.cancelButton} onPress={onCancel}>
            <Text style={[styles.actionText, { color: DANGER }]}>✕ Cancel</Text>
          </Pressable>
        </View>
      </View>
    </View>
  );
}

function ContentCard({ item, onPress, onMorePress }: {
  item: EnrichedDownload;
  onPress: () => void;
  onMorePress: () => void;
}) {
  const watched = Math.min(100, item.progress?.percentWatched ?? 0);
  return (
    <Pressable style={styles.contentCard} onPress={onPress}>
      <View style={{ position: 'relative' }}>
        <Thumbnail size={110} url={item.thumbnailUrl} />
        {watched > 1 ? (
          <View style={styles.watchTrack}>
            <View style={[styles.watchFill, { width: `${watched}%` as any }]} />
          </View>
        ) : null}
        {item.accessStatus !== 'active' ? (
          <View style={[
            styles.accessBadge,
            { backgroundColor: item.accessStatus === 'expired' ? DANGER : WARN },
          ]}>
            <Text style={styles.accessBadgeText}>
              {item.accessStatus === 'expired' ? 'Access expired' : 'Expires soon'}
            </Text>
          </View>
        ) : null}
      </View>
      <Text style={styles.compactTitle} numberOfLines={2}>{item.title ?? item.id}</Text>
      <View style={styles.metaWrap}>
        {item.durationSeconds ? <Text style={styles.smallMeta}>{fmtDuration(item.durationSeconds)}</Text> : null}
        {item.entitlement?.accessExpiresAt ? (
          <Text style={styles.smallMeta}>Access until {fmtDate(item.entitlement.accessExpiresAt)}</Text>
        ) : item.downloadedAt ? (
          <Text style={styles.smallMeta}>Downloaded {fmtDate(item.downloadedAt)}</Text>
        ) : null}
      </View>
      <Pressable style={styles.moreButton} onPress={onMorePress} hitSlop={8}>
        <Text style={styles.moreText}>•••</Text>
      </Pressable>
    </Pressable>
  );
}

function EmptyState() {
  return (
    <View style={styles.empty}>
      <View style={styles.emptyIconWrap}><Text style={styles.emptyIcon}>⬇</Text></View>
      <Text style={styles.emptyTitle}>No Offline Videos Yet</Text>
      <Text style={styles.emptyCopy}>
        Open a lesson and tap Download. Your offline content, storage usage and access validity will appear here.
      </Text>
    </View>
  );
}

function ManageModal({
  item,
  visible,
  onClose,
  onDismiss,
  onDelete,
  onPlay,
}: {
  item: EnrichedDownload | null;
  visible: boolean;
  onClose: () => void;
  onDismiss: () => void;
  onDelete: (item: EnrichedDownload) => void;
  onPlay: (item: EnrichedDownload) => void;
}) {
  if (!item) return null;
  return (
    <Modal
      visible={visible}
      transparent
      animationType="slide"
      statusBarTranslucent
      onRequestClose={onClose}
      onDismiss={onDismiss}
    >
      <Pressable style={styles.modalOverlay} onPress={onClose} />
      <View style={styles.modalSheet}>
        <View style={styles.modalHandle} />
        <Text style={styles.modalTitle} numberOfLines={2}>{item.title ?? item.id}</Text>
        {item.entitlement?.accessExpiresAt ? (
          <Text style={styles.modalSub}>Course access until {fmtDate(item.entitlement.accessExpiresAt)}</Text>
        ) : item.contentLength > 0 ? (
          <Text style={styles.modalSub}>{fmtBytes(item.contentLength)}</Text>
        ) : null}
        <View style={styles.modalDivider} />
        {item.accessStatus !== 'expired' ? (
          <Pressable style={styles.modalRow} onPress={() => onPlay(item)}>
            <Text style={styles.modalIcon}>▶</Text>
            <Text style={styles.modalLabel}>Play Offline</Text>
          </Pressable>
        ) : (
          <View style={styles.expiredMessage}>
            <Text style={styles.expiredText}>This course access has expired. Offline playback is unavailable.</Text>
          </View>
        )}
        <Pressable style={styles.modalRow} onPress={() => { onClose(); onDelete(item); }}>
          <Text style={[styles.modalIcon, { color: DANGER }]}>🗑</Text>
          <Text style={[styles.modalLabel, { color: DANGER }]}>Delete Download</Text>
        </Pressable>
        <Pressable style={styles.modalCancel} onPress={onClose}>
          <Text style={styles.modalCancelText}>Cancel</Text>
        </Pressable>
      </View>
    </Modal>
  );
}

type Section =
  | { type: 'storage' }
  | { type: 'continue'; items: EnrichedDownload[] }
  | { type: 'active'; items: EnrichedDownload[] }
  | { type: 'course'; courseName: string; modules: { moduleName: string; items: EnrichedDownload[] }[] }
  | { type: 'empty' };

export default function DownloadsScreen() {
  const router = useRouter();
  const [items, setItems] = useState<DownloadInfo[]>([]);
  const [progressMap, setProgressMap] = useState<Record<string, ChapterProgress>>({});
  const [entitlementMap, setEntitlementMap] = useState<Record<string, DownloadEntitlement | null>>({});
  const [offlineBytes, setOfflineBytes] = useState(0);
  const [deviceStorage, setDeviceStorage] = useState<DeviceStorageStats>(ZERO_DEVICE_STORAGE);
  const [loading, setLoading] = useState(true);
  const [refreshing, setRefreshing] = useState(false);
  const [modalItem, setModalItem] = useState<EnrichedDownload | null>(null);
  const [resolvedTitles, setResolvedTitles] = useState<Record<string, string>>({});
  const resolvedTitlesRef = useRef<Record<string, string>>({});
  const [resolvedHierarchy, setResolvedHierarchy] = useState<Record<string, { courseName: string; moduleName: string }>>({});
  const resolvedHierarchyRef = useRef<Record<string, { courseName: string; moduleName: string }>>({});
  const pollRef = useRef<ReturnType<typeof setInterval> | null>(null);
  const pendingNavId = useRef<string | null>(null);

  const refreshStorage = useCallback(async () => {
    const [offline, device] = await Promise.all([
      IcareOfflineDrm.getStorageStats().catch(() => ({ usedBytes: 0, downloadCount: 0 })),
      IcareOfflineDrm.getDeviceStorageStats().catch(() => ZERO_DEVICE_STORAGE),
    ]);
    setOfflineBytes(offline.usedBytes);
    setDeviceStorage(device);
  }, []);

  const load = useCallback(async () => {
    try {
      const [list, allProgress] = await Promise.all([
        IcareOfflineDrm.listDownloads(),
        getAllProgress(),
      ]);
      setItems(list);

      const progress: Record<string, ChapterProgress> = {};
      for (const entry of allProgress) progress[entry.chapterId] = entry;
      setProgressMap(progress);

      const entitlementEntries = await Promise.all(
        list.map(async (item) => [
          item.id,
          await IcareOfflineDrm.getDownloadEntitlement(item.id).catch(() => null),
        ] as const),
      );
      setEntitlementMap(Object.fromEntries(entitlementEntries));
      await refreshStorage();
    } finally {
      setLoading(false);
      setRefreshing(false);
    }
  }, [refreshStorage]);

  useEffect(() => { load(); }, [load]);

  useEffect(() => {
    const sub = onDownloadProgress((evt) => {
      setItems((prev) => {
        const idx = prev.findIndex((item) => item.id === evt.id);
        if (idx < 0) return [evt, ...prev];
        const next = [...prev];
        next[idx] = evt;
        return next;
      });
      if (evt.state === 'completed') refreshStorage().catch(() => {});
    });
    return () => sub.remove();
  }, [refreshStorage]);

  useEffect(() => {
    const hasActive = items.some((item) =>
      item.state === 'downloading' || item.state === 'queued' || item.state === 'restarting',
    );
    if (hasActive && !pollRef.current) {
      pollRef.current = setInterval(async () => {
        const updated = await IcareOfflineDrm.listDownloads();
        // Authoritative reconciliation: items removed from Media3 must disappear
        // from React state instead of being retained by the old merge algorithm.
        setItems(updated);
        const stillActive = updated.some((item) =>
          item.state === 'downloading' || item.state === 'queued' || item.state === 'restarting',
        );
        if (!stillActive && pollRef.current) {
          clearInterval(pollRef.current);
          pollRef.current = null;
          refreshStorage().catch(() => {});
        }
      }, 2500);
    }
    if (!hasActive && pollRef.current) {
      clearInterval(pollRef.current);
      pollRef.current = null;
    }
    return () => {
      if (pollRef.current) {
        clearInterval(pollRef.current);
        pollRef.current = null;
      }
    };
  }, [items, refreshStorage]);

  const needsResolutionKey = useMemo(() =>
    items
      .filter((item) => !resolvedTitlesRef.current[item.id] && (!item.title || isRawId(item.title)))
      .map((item) => item.id)
      .sort()
      .join(','),
  [items]);

  useEffect(() => {
    if (!needsResolutionKey) return;
    let cancelled = false;
    (async () => {
      const updates: Record<string, string> = {};
      for (const id of needsResolutionKey.split(',').filter(Boolean)) {
        try {
          const { data } = await fetchChapter(id);
          if (data?.title) updates[id] = data.title;
        } catch { /* keep fallback */ }
      }
      if (!cancelled && Object.keys(updates).length) {
        resolvedTitlesRef.current = { ...resolvedTitlesRef.current, ...updates };
        setResolvedTitles({ ...resolvedTitlesRef.current });
      }
    })();
    return () => { cancelled = true; };
  }, [needsResolutionKey]);

  const needsHierarchyKey = useMemo(() =>
    items
      .filter((item) => item.state === 'completed' && !resolvedHierarchyRef.current[item.id])
      .map((item) => item.id)
      .sort()
      .join(','),
  [items]);

  useEffect(() => {
    if (!needsHierarchyKey) return;
    let cancelled = false;
    (async () => {
      const courseCache: Record<string, string> = {};
      const moduleCache: Record<string, string> = {};
      const updates: Record<string, { courseName: string; moduleName: string }> = {};
      for (const id of needsHierarchyKey.split(',').filter(Boolean)) {
        try {
          const { data: chapter } = await fetchChapter(id);
          if (!chapter?.courseId || !chapter?.moduleId) continue;
          if (!(chapter.courseId in courseCache)) {
            try {
              const { data } = await fetchCourse(chapter.courseId);
              courseCache[chapter.courseId] = data?.title ?? '';
            } catch { courseCache[chapter.courseId] = ''; }
          }
          if (!(chapter.moduleId in moduleCache)) {
            try {
              const { data } = await fetchModule(chapter.moduleId);
              moduleCache[chapter.moduleId] = data?.title ?? '';
            } catch { moduleCache[chapter.moduleId] = ''; }
          }
          updates[id] = {
            courseName: courseCache[chapter.courseId] || '',
            moduleName: moduleCache[chapter.moduleId] || '',
          };
        } catch { /* fallback grouping */ }
      }
      if (!cancelled && Object.keys(updates).length) {
        resolvedHierarchyRef.current = { ...resolvedHierarchyRef.current, ...updates };
        setResolvedHierarchy({ ...resolvedHierarchyRef.current });
      }
    })();
    return () => { cancelled = true; };
  }, [needsHierarchyKey]);

  const navigateToPlayer = useCallback((id: string) => {
    router.push({ pathname: '/player/[chapterId]', params: { chapterId: id } } as unknown as Href);
  }, [router]);

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
            try {
              await IcareOfflineDrm.removeDownload(item.id);
              setItems((prev) => prev.filter((entry) => entry.id !== item.id));
              setEntitlementMap((prev) => {
                const next = { ...prev };
                delete next[item.id];
                return next;
              });
              await refreshStorage();
            } catch (error: any) {
              Alert.alert('Could not delete download', error?.message ?? String(error));
              load().catch(() => {});
            }
          },
        },
      ],
    );
  }, [load, refreshStorage]);

  const enriched = useMemo<EnrichedDownload[]>(() =>
    items.map((item) => {
      const entitlement = entitlementMap[item.id] ?? null;
      return {
        ...item,
        title: resolvedTitles[item.id] ?? (isRawId(item.title) ? null : item.title) ?? null,
        progress: progressMap[item.id] ?? null,
        entitlement,
        accessStatus: accessState(entitlement?.accessExpiresAt),
        courseName: resolvedHierarchy[item.id]?.courseName ?? null,
        moduleName: resolvedHierarchy[item.id]?.moduleName ?? null,
      };
    }),
  [items, entitlementMap, resolvedTitles, progressMap, resolvedHierarchy]);

  const sections = useMemo<Section[]>(() => {
    if (!enriched.length) return [{ type: 'storage' }, { type: 'empty' }];
    const completed = enriched.filter((item) => item.state === 'completed');
    const active = enriched.filter((item) => item.state !== 'completed' && item.state !== 'removing');
    const result: Section[] = [{ type: 'storage' }];

    const continueItems = completed
      .filter((item) => {
        const pct = item.progress?.percentWatched ?? 0;
        return item.accessStatus !== 'expired' && pct > 1 && pct < 95;
      })
      .sort((a, b) => (b.progress?.lastWatchedAt ?? '').localeCompare(a.progress?.lastWatchedAt ?? ''))
      .slice(0, 10);
    if (continueItems.length) result.push({ type: 'continue', items: continueItems });
    if (active.length) result.push({ type: 'active', items: active });

    const courseMap = new Map<string, Map<string, EnrichedDownload[]>>();
    for (const item of completed) {
      const courseName = item.courseName || courseKey(item.title);
      const moduleName = item.moduleName || '';
      if (!courseMap.has(courseName)) courseMap.set(courseName, new Map());
      const moduleMap = courseMap.get(courseName)!;
      const arr = moduleMap.get(moduleName) ?? [];
      arr.push(item);
      moduleMap.set(moduleName, arr);
    }
    for (const [courseName, moduleMap] of courseMap) {
      result.push({
        type: 'course',
        courseName,
        modules: Array.from(moduleMap.entries()).map(([moduleName, moduleItems]) => ({
          moduleName,
          items: moduleItems,
        })),
      });
    }
    return result;
  }, [enriched]);

  const renderSection = useCallback((section: Section) => {
    switch (section.type) {
      case 'storage':
        return (
          <StorageSummary
            key="storage"
            device={deviceStorage}
            offlineBytes={offlineBytes}
            count={enriched.filter((item) => item.state === 'completed').length}
          />
        );
      case 'continue':
        return (
          <View key="continue">
            <SectionHeader title="Continue Watching" count={section.items.length} />
            <ScrollView horizontal showsHorizontalScrollIndicator={false} contentContainerStyle={styles.horizontalContent}>
              {section.items.map((item) => (
                <ContinueWatchingCard key={item.id} item={item} onPress={() => navigateToPlayer(item.id)} />
              ))}
            </ScrollView>
          </View>
        );
      case 'active':
        return (
          <View key="active" style={styles.activeSection}>
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
        const title = section.courseName === '__ungrouped__' ? 'Downloaded Videos' : section.courseName;
        const count = section.modules.reduce((sum, module) => sum + module.items.length, 0);
        return (
          <View key={`course-${section.courseName}`}>
            <SectionHeader title={title} count={count} />
            {section.modules.map((module) => (
              <View key={`${section.courseName}-${module.moduleName || '_default'}`}>
                {module.moduleName ? <ModuleHeader title={module.moduleName} count={module.items.length} /> : null}
                <ScrollView horizontal showsHorizontalScrollIndicator={false} contentContainerStyle={styles.horizontalContent}>
                  {module.items.map((item) => (
                    <ContentCard
                      key={item.id}
                      item={item}
                      onPress={() => item.accessStatus === 'expired' ? setModalItem(item) : navigateToPlayer(item.id)}
                      onMorePress={() => setModalItem(item)}
                    />
                  ))}
                </ScrollView>
              </View>
            ))}
          </View>
        );
      }
      case 'empty':
        return <EmptyState key="empty" />;
      default:
        return null;
    }
  }, [deviceStorage, enriched, handleDelete, navigateToPlayer, offlineBytes]);

  if (loading) {
    return (
      <View style={styles.loading}>
        <ActivityIndicator size="large" color={ACCENT} />
      </View>
    );
  }

  return (
    <View style={styles.screen}>
      <View style={styles.header}>
        <Pressable
          style={styles.backButton}
          onPress={() => router.navigate('/(tabs)/explore' as any)}
          accessibilityLabel="Back to Learn"
        >
          <Text style={styles.backIcon}>←</Text>
        </Pressable>
        <View style={{ flex: 1 }}>
          <Text style={styles.headerTitle}>My Downloads</Text>
          <Text style={styles.headerSub}>Offline Learning Manager</Text>
        </View>
      </View>

      <ScrollView
        style={{ flex: 1 }}
        contentContainerStyle={enriched.length ? styles.scrollContent : styles.scrollEmpty}
        refreshControl={
          <RefreshControl
            refreshing={refreshing}
            tintColor={ACCENT}
            colors={[ACCENT]}
            onRefresh={() => { setRefreshing(true); load(); }}
          />
        }
      >
        {sections.map(renderSection)}
        <View style={{ height: 28 }} />
      </ScrollView>

      <ManageModal
        item={modalItem}
        visible={modalItem !== null}
        onClose={() => setModalItem(null)}
        onDismiss={onModalDismiss}
        onDelete={(item) => { setModalItem(null); handleDelete(item); }}
        onPlay={(item) => {
          pendingNavId.current = item.id;
          setModalItem(null);
        }}
      />
    </View>
  );
}

const styles = StyleSheet.create({
  screen: { flex: 1, backgroundColor: BG, paddingTop: 80 },
  loading: { flex: 1, backgroundColor: BG, alignItems: 'center', justifyContent: 'center' },
  header: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 12,
    paddingHorizontal: 16,
    paddingBottom: 14,
    borderBottomWidth: StyleSheet.hairlineWidth,
    borderBottomColor: 'rgba(255,255,255,0.06)',
  },
  backButton: {
    width: 38,
    height: 38,
    borderRadius: 19,
    backgroundColor: 'rgba(255,255,255,0.07)',
    alignItems: 'center',
    justifyContent: 'center',
  },
  backIcon: { color: TEXT, fontSize: 20 },
  headerTitle: { color: TEXT, fontSize: 23, fontWeight: '800', letterSpacing: -0.4 },
  headerSub: { color: TEXT_MUTED, fontSize: 11, marginTop: 2 },
  scrollContent: { paddingBottom: 40 },
  scrollEmpty: { flexGrow: 1, paddingBottom: 40 },

  eyebrow: { color: TEXT_MUTED, fontSize: 10, fontWeight: '700', letterSpacing: 0.8 },
  storageCard: {
    marginHorizontal: 16,
    marginTop: 16,
    padding: 16,
    backgroundColor: CARD_BG,
    borderRadius: 14,
    borderWidth: StyleSheet.hairlineWidth,
    borderColor: 'rgba(255,255,255,0.08)',
  },
  storageTopRow: { flexDirection: 'row', justifyContent: 'space-between', gap: 12, alignItems: 'flex-start' },
  storageHeadline: { color: TEXT, fontSize: 20, fontWeight: '800', marginTop: 4 },
  storageTotal: { color: TEXT_MUTED, fontSize: 11, marginTop: 2 },
  storageTrack: { height: 7, backgroundColor: SURFACE, borderRadius: 4, overflow: 'hidden', marginTop: 14 },
  storageFill: { height: 7, backgroundColor: ACCENT, borderRadius: 4 },
  storageMetaRow: { flexDirection: 'row', justifyContent: 'space-between', flexWrap: 'wrap', gap: 8, marginTop: 10 },
  storageMeta: { color: TEXT_MUTED, fontSize: 11 },
  storageWarning: { color: WARN, fontSize: 11, marginTop: 8, lineHeight: 16 },

  sectionHeader: { flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center', paddingHorizontal: 16, paddingTop: 20, paddingBottom: 8 },
  sectionTitle: { color: TEXT, fontSize: 15, fontWeight: '700', flex: 1 },
  sectionCount: { color: TEXT_MUTED, fontSize: 11 },
  moduleHeader: { flexDirection: 'row', alignItems: 'center', gap: 8, paddingHorizontal: 20, paddingTop: 8, paddingBottom: 4 },
  moduleAccent: { width: 3, height: 14, borderRadius: 2, backgroundColor: ACCENT },
  moduleTitle: { color: TEXT_MUTED, fontSize: 12, fontWeight: '600', flex: 1 },
  horizontalContent: { paddingHorizontal: 16, paddingBottom: 12 },

  thumb: { backgroundColor: SURFACE, borderRadius: 8, overflow: 'hidden', alignItems: 'center', justifyContent: 'center' },
  thumbIcon: { fontSize: 28 },
  playBadge: { position: 'absolute', right: 6, bottom: 6, width: 24, height: 24, borderRadius: 12, backgroundColor: ACCENT, alignItems: 'center', justifyContent: 'center' },
  playBadgeText: { color: '#000', fontSize: 10, fontWeight: '900' },
  continueCard: { width: 160, marginRight: 12 },
  contentCard: { width: 150, marginRight: 12 },
  compactTitle: { color: TEXT, fontSize: 12, fontWeight: '600', lineHeight: 16, marginTop: 6 },
  smallMeta: { color: TEXT_MUTED, fontSize: 10, marginTop: 3 },
  metaWrap: { gap: 1 },
  watchTrack: { height: 3, backgroundColor: 'rgba(255,255,255,0.12)' },
  watchFill: { height: 3, backgroundColor: ACCENT },
  accessBadge: { position: 'absolute', top: 6, left: 6, borderRadius: 4, paddingHorizontal: 6, paddingVertical: 3 },
  accessBadgeText: { color: '#fff', fontSize: 9, fontWeight: '700' },
  moreButton: { alignSelf: 'flex-start', paddingHorizontal: 4, paddingVertical: 4 },
  moreText: { color: TEXT_MUTED, fontSize: 14, fontWeight: '900', letterSpacing: 1 },

  activeSection: { paddingHorizontal: 16 },
  activeCard: { flexDirection: 'row', gap: 12, padding: 12, backgroundColor: CARD_BG, borderRadius: 12, marginBottom: 8 },
  activeTitle: { color: TEXT, fontSize: 13, fontWeight: '600', lineHeight: 18 },
  progressRow: { flexDirection: 'row', alignItems: 'center', gap: 8, marginTop: 8 },
  downloadTrack: { flex: 1, height: 5, backgroundColor: SURFACE, borderRadius: 3, overflow: 'hidden' },
  downloadFill: { height: 5, backgroundColor: ACCENT },
  progressPct: { color: ACCENT, fontSize: 11, fontWeight: '700', minWidth: 32 },
  actionRow: { flexDirection: 'row', gap: 8, marginTop: 8 },
  actionButton: { backgroundColor: SURFACE, paddingHorizontal: 10, paddingVertical: 6, borderRadius: 6 },
  cancelButton: { paddingHorizontal: 10, paddingVertical: 6 },
  actionText: { color: TEXT, fontSize: 11, fontWeight: '600' },

  empty: { flex: 1, minHeight: 380, alignItems: 'center', justifyContent: 'center', paddingHorizontal: 36 },
  emptyIconWrap: { width: 72, height: 72, borderRadius: 36, backgroundColor: 'rgba(79,195,247,0.12)', alignItems: 'center', justifyContent: 'center' },
  emptyIcon: { fontSize: 32 },
  emptyTitle: { color: TEXT, fontSize: 21, fontWeight: '800', marginTop: 18 },
  emptyCopy: { color: TEXT_MUTED, fontSize: 14, textAlign: 'center', lineHeight: 21, marginTop: 10 },

  modalOverlay: { flex: 1, backgroundColor: 'rgba(0,0,0,0.62)' },
  modalSheet: { backgroundColor: CARD_BG, borderTopLeftRadius: 20, borderTopRightRadius: 20, paddingHorizontal: 20, paddingTop: 12, paddingBottom: Platform.OS === 'android' ? 24 : 36 },
  modalHandle: { width: 40, height: 4, borderRadius: 2, backgroundColor: SURFACE, alignSelf: 'center', marginBottom: 16 },
  modalTitle: { color: TEXT, fontSize: 16, fontWeight: '700' },
  modalSub: { color: TEXT_MUTED, fontSize: 12, marginTop: 4 },
  modalDivider: { height: StyleSheet.hairlineWidth, backgroundColor: SURFACE, marginVertical: 12 },
  modalRow: { flexDirection: 'row', alignItems: 'center', gap: 14, paddingVertical: 14 },
  modalIcon: { color: TEXT, fontSize: 18, width: 24, textAlign: 'center' },
  modalLabel: { color: TEXT, fontSize: 15 },
  modalCancel: { paddingVertical: 14, alignItems: 'center' },
  modalCancelText: { color: TEXT_MUTED, fontSize: 15 },
  expiredMessage: { paddingVertical: 12, paddingHorizontal: 12, backgroundColor: 'rgba(239,83,80,0.10)', borderRadius: 8 },
  expiredText: { color: DANGER, fontSize: 12, lineHeight: 18 },
});
