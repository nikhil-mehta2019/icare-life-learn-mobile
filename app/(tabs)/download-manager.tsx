import { useCallback, useEffect, useMemo, useState } from 'react';
import {
  ActivityIndicator,
  Alert,
  Pressable,
  RefreshControl,
  ScrollView,
  StyleSheet,
  Text,
  View,
} from 'react-native';
import { useRouter } from 'expo-router';
import {
  fetchChapters,
  fetchCourses,
  fetchModules,
  resolveStudentAccessWithJwt,
  type Chapter,
  type Course,
  type Module,
} from '../../api/base44Client';
import { getAuthJwt } from './explore';
import IcareOfflineDrm, { type DeviceStorageStats, type DownloadInfo } from '../../modules/icare-offline-drm';
import {
  estimateChapterDownloadBytes,
  formatDownloadBytes,
  queueChapterForOffline,
} from '../../utils/offlineDownload';

const BG = '#0F1923';
const CARD = '#1C2B35';
const SURFACE = '#243344';
const TEXT = '#F0F4F8';
const MUTED = '#8A9BB0';
const ACCENT = '#4FC3F7';
const SUCCESS = '#66BB6A';
const WARN = '#FFA726';
const DANGER = '#EF5350';
const RESERVE_BYTES = 1024 * 1024 * 1024;
const ZERO_STORAGE: DeviceStorageStats = { totalBytes: 0, usedBytes: 0, freeBytes: 0 };

type ModuleBundle = { module: Module; chapters: Chapter[] };
type CourseBundle = { course: Course; modules: ModuleBundle[] };

function existingStatus(download?: DownloadInfo): string | null {
  if (!download) return null;
  if (download.state === 'completed') return 'Downloaded';
  if (download.state === 'downloading') return 'Downloading';
  if (download.state === 'queued' || download.state === 'restarting') return 'Queued';
  if (download.state === 'stopped') return 'Paused';
  if (download.state === 'removing') return 'Removing';
  return null;
}

function isDownloadableVideo(chapter: Chapter) {
  return chapter.contentType === 'video' && Boolean(
    chapter.muxDrmPlaybackId || chapter.muxSignedPlaybackId || chapter.muxPlaybackId,
  );
}

export default function DownloadManagerScreen() {
  const router = useRouter();
  const [bundles, setBundles] = useState<CourseBundle[]>([]);
  const [downloads, setDownloads] = useState<Record<string, DownloadInfo>>({});
  const [storage, setStorage] = useState<DeviceStorageStats>(ZERO_STORAGE);
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [expandedCourses, setExpandedCourses] = useState<Set<string>>(new Set());
  const [expandedModules, setExpandedModules] = useState<Set<string>>(new Set());
  const [loading, setLoading] = useState(true);
  const [refreshing, setRefreshing] = useState(false);
  const [queueing, setQueueing] = useState(false);
  const [queueProgress, setQueueProgress] = useState({ done: 0, total: 0 });

  const load = useCallback(async () => {
    try {
      const [courses, existing, device] = await Promise.all([
        fetchCourses({ status: 'published' }, 100),
        IcareOfflineDrm.listDownloads(),
        IcareOfflineDrm.getDeviceStorageStats().catch(() => ZERO_STORAGE),
      ]);

      const byId: Record<string, DownloadInfo> = {};
      for (const item of existing) byId[item.id] = item;
      setDownloads(byId);
      setStorage(device);

      const jwt = getAuthJwt();
      const courseBundles: CourseBundle[] = [];
      for (const course of courses.filter((item) => item.status !== 'archived')) {
        try {
          if (jwt) {
            const access = await resolveStudentAccessWithJwt(course.id, jwt);
            if (!access.data?.hasCourseAccess) continue;
          }
          const modules = await fetchModules(course.id);
          const moduleBundles: ModuleBundle[] = [];
          for (const module of modules) {
            try {
              const chapters = (await fetchChapters(module.id)).filter(isDownloadableVideo);
              if (chapters.length) moduleBundles.push({ module, chapters });
            } catch { /* keep other modules */ }
          }
          if (moduleBundles.length) courseBundles.push({ course, modules: moduleBundles });
        } catch { /* keep other courses */ }
      }
      setBundles(courseBundles);
      setExpandedCourses((current) => current.size ? current : new Set(courseBundles.slice(0, 1).map((item) => item.course.id)));
    } catch (error: any) {
      Alert.alert('Could not load downloads', error?.message ?? String(error));
    } finally {
      setLoading(false);
      setRefreshing(false);
    }
  }, []);

  useEffect(() => { load(); }, [load]);

  const allSelectable = useMemo(() =>
    bundles.flatMap((course) => course.modules.flatMap((module) => module.chapters))
      .filter((chapter) => !existingStatus(downloads[chapter.id])),
  [bundles, downloads]);

  const selectedChapters = useMemo(() => {
    const map = new Map(allSelectable.map((chapter) => [chapter.id, chapter]));
    return Array.from(selected).map((id) => map.get(id)).filter(Boolean) as Chapter[];
  }, [allSelectable, selected]);

  const estimatedBytes = useMemo(
    () => selectedChapters.reduce((sum, chapter) => sum + estimateChapterDownloadBytes(chapter), 0),
    [selectedChapters],
  );
  const freeAfter = Math.max(0, storage.freeBytes - estimatedBytes);
  const enoughStorage = storage.freeBytes <= 0 || freeAfter >= RESERVE_BYTES;

  const toggleSelected = (id: string) => {
    setSelected((current) => {
      const next = new Set(current);
      if (next.has(id)) next.delete(id); else next.add(id);
      return next;
    });
  };

  const toggleExpanded = (setter: typeof setExpandedCourses, id: string) => {
    setter((current) => {
      const next = new Set(current);
      if (next.has(id)) next.delete(id); else next.add(id);
      return next;
    });
  };

  const toggleModuleSelection = (chapters: Chapter[]) => {
    const selectable = chapters.filter((chapter) => !existingStatus(downloads[chapter.id]));
    const allSelected = selectable.length > 0 && selectable.every((chapter) => selected.has(chapter.id));
    setSelected((current) => {
      const next = new Set(current);
      for (const chapter of selectable) {
        if (allSelected) next.delete(chapter.id); else next.add(chapter.id);
      }
      return next;
    });
  };

  const startSelected = useCallback(async () => {
    if (!selectedChapters.length || queueing) return;
    const jwt = getAuthJwt();
    if (!jwt) {
      Alert.alert('Reconnect required', 'Open Learn while online to refresh your session, then return here.');
      return;
    }
    if (!enoughStorage) {
      Alert.alert(
        'Not enough storage',
        `Your selection is approximately ${formatDownloadBytes(estimatedBytes)}. Reduce the selection or free storage so at least 1 GB remains after download.`,
      );
      return;
    }

    setQueueing(true);
    setQueueProgress({ done: 0, total: selectedChapters.length });
    let queued = 0;
    const failures: string[] = [];

    for (let index = 0; index < selectedChapters.length; index += 1) {
      const chapter = selectedChapters[index];
      try {
        await queueChapterForOffline(chapter, jwt);
        queued += 1;
      } catch (error: any) {
        failures.push(`${chapter.title}: ${error?.message ?? 'Could not authorize download'}`);
      }
      setQueueProgress({ done: index + 1, total: selectedChapters.length });
    }

    setQueueing(false);
    setSelected(new Set());
    await load();

    if (queued > 0) {
      Alert.alert(
        'Downloads queued',
        `${queued} ${queued === 1 ? 'video' : 'videos'} added to My Downloads.${failures.length ? `\n\n${failures.length} item${failures.length === 1 ? '' : 's'} could not be added because access/download authorization failed.` : ''}`,
        [{ text: 'View Downloads', onPress: () => router.replace('/(tabs)/downloads' as any) }],
      );
    } else {
      Alert.alert('Nothing queued', failures[0] ?? 'Please try again.');
    }
  }, [selectedChapters, queueing, enoughStorage, estimatedBytes, load, router]);

  if (loading) {
    return <View style={styles.center}><ActivityIndicator size="large" color={ACCENT} /><Text style={styles.muted}>Loading downloadable lessons…</Text></View>;
  }

  return (
    <View style={styles.screen}>
      <ScrollView
        contentContainerStyle={styles.content}
        refreshControl={<RefreshControl refreshing={refreshing} onRefresh={() => { setRefreshing(true); load(); }} tintColor={ACCENT} />}
      >
        <View style={styles.header}>
          <Text style={styles.eyebrow}>OFFLINE LEARNING</Text>
          <Text style={styles.title}>Add Downloads</Text>
          <Text style={styles.subtitle}>Select several videos or a whole module. Access is verified securely for every video before it is queued.</Text>
        </View>

        <View style={styles.storageCard}>
          <View style={styles.summaryRow}>
            <View><Text style={styles.eyebrow}>AVAILABLE STORAGE</Text><Text style={styles.summaryBig}>{storage.freeBytes > 0 ? formatDownloadBytes(storage.freeBytes) : 'Unavailable'}</Text></View>
            <View style={{ alignItems: 'flex-end' }}><Text style={styles.eyebrow}>SELECTED</Text><Text style={styles.summaryBig}>{selectedChapters.length} video{selectedChapters.length === 1 ? '' : 's'}</Text></View>
          </View>
          <View style={styles.divider} />
          <View style={styles.summaryRow}><Text style={styles.meta}>Estimated download size</Text><Text style={styles.value}>~{formatDownloadBytes(estimatedBytes)}</Text></View>
          <View style={styles.summaryRow}><Text style={styles.meta}>Estimated free after download</Text><Text style={[styles.value, !enoughStorage && { color: WARN }]}>{storage.freeBytes > 0 ? formatDownloadBytes(freeAfter) : '—'}</Text></View>
          <Text style={styles.estimateNote}>Estimated from lesson duration. Final HLS/DRM cache size can vary slightly by rendition and language tracks.</Text>
          {!enoughStorage && <Text style={styles.warning}>⚠ Reduce the selection or free storage. iCare keeps a 1 GB device safety reserve.</Text>}
        </View>

        {bundles.map(({ course, modules }) => {
          const courseOpen = expandedCourses.has(course.id);
          return (
            <View key={course.id} style={styles.courseCard}>
              <Pressable style={styles.courseHeader} onPress={() => toggleExpanded(setExpandedCourses, course.id)}>
                <View style={{ flex: 1 }}><Text style={styles.courseTitle}>{course.title}</Text><Text style={styles.courseMeta}>{modules.length} downloadable module{modules.length === 1 ? '' : 's'}</Text></View>
                <Text style={styles.chevron}>{courseOpen ? '⌃' : '⌄'}</Text>
              </Pressable>

              {courseOpen && modules.map(({ module, chapters }) => {
                const moduleOpen = expandedModules.has(module.id);
                const selectable = chapters.filter((chapter) => !existingStatus(downloads[chapter.id]));
                const allSelected = selectable.length > 0 && selectable.every((chapter) => selected.has(chapter.id));
                const moduleEstimate = selectable.reduce((sum, chapter) => sum + estimateChapterDownloadBytes(chapter), 0);
                return (
                  <View key={module.id} style={styles.moduleBlock}>
                    <View style={styles.moduleHeader}>
                      <Pressable style={{ flex: 1 }} onPress={() => toggleExpanded(setExpandedModules, module.id)}>
                        <Text style={styles.moduleTitle}>{module.title}</Text>
                        <Text style={styles.moduleMeta}>{chapters.length} video{chapters.length === 1 ? '' : 's'} · ~{formatDownloadBytes(moduleEstimate)}</Text>
                      </Pressable>
                      {selectable.length > 0 && (
                        <Pressable onPress={() => toggleModuleSelection(chapters)} style={[styles.moduleSelect, allSelected && styles.moduleSelectActive]}>
                          <Text style={[styles.moduleSelectText, allSelected && styles.moduleSelectTextActive]}>{allSelected ? 'Selected' : 'Select module'}</Text>
                        </Pressable>
                      )}
                      <Pressable onPress={() => toggleExpanded(setExpandedModules, module.id)} hitSlop={10}><Text style={styles.chevron}>{moduleOpen ? '⌃' : '⌄'}</Text></Pressable>
                    </View>

                    {moduleOpen && chapters.map((chapter, index) => {
                      const status = existingStatus(downloads[chapter.id]);
                      const disabled = Boolean(status);
                      const checked = selected.has(chapter.id);
                      return (
                        <Pressable key={chapter.id} disabled={disabled} onPress={() => toggleSelected(chapter.id)} style={[styles.chapterRow, disabled && styles.chapterDisabled]}>
                          <View style={[styles.checkbox, checked && styles.checkboxChecked, disabled && styles.checkboxDone]}><Text style={styles.check}>{checked || disabled ? '✓' : ''}</Text></View>
                          <View style={{ flex: 1 }}><Text style={styles.chapterTitle} numberOfLines={2}>{index + 1}. {chapter.title}</Text><Text style={styles.chapterMeta}>{chapter.estimatedMinutes ? `${chapter.estimatedMinutes} min · ` : ''}~{formatDownloadBytes(estimateChapterDownloadBytes(chapter))}</Text></View>
                          {status && <Text style={styles.status}>{status}</Text>}
                        </Pressable>
                      );
                    })}
                  </View>
                );
              })}
            </View>
          );
        })}

        {!bundles.length && <View style={styles.empty}><Text style={styles.emptyTitle}>No downloadable videos found</Text><Text style={styles.meta}>Pull to refresh after opening your course in Learn.</Text></View>}
      </ScrollView>

      <View style={styles.footer}>
        <View><Text style={styles.footerCount}>{queueing ? `Preparing ${queueProgress.done}/${queueProgress.total}` : `${selectedChapters.length} selected`}</Text><Text style={styles.footerSize}>~{formatDownloadBytes(estimatedBytes)}</Text></View>
        <Pressable disabled={!selectedChapters.length || queueing || !enoughStorage} onPress={startSelected} style={[styles.downloadButton, (!selectedChapters.length || queueing || !enoughStorage) && styles.downloadDisabled]}>
          {queueing ? <ActivityIndicator color="#07141C" /> : <Text style={styles.downloadText}>Download {selectedChapters.length || ''}</Text>}
        </Pressable>
      </View>
    </View>
  );
}

const styles = StyleSheet.create({
  screen: { flex: 1, backgroundColor: BG },
  center: { flex: 1, alignItems: 'center', justifyContent: 'center', backgroundColor: BG, gap: 10 },
  content: { padding: 16, paddingBottom: 130 },
  header: { marginBottom: 16 },
  eyebrow: { color: MUTED, fontSize: 10, fontWeight: '800', letterSpacing: 0.9 },
  title: { color: TEXT, fontSize: 26, fontWeight: '900', marginTop: 3 },
  subtitle: { color: MUTED, fontSize: 12, lineHeight: 18, marginTop: 6 },
  storageCard: { padding: 16, borderRadius: 15, backgroundColor: CARD, borderWidth: 1, borderColor: 'rgba(79,195,247,0.17)', gap: 8, marginBottom: 16 },
  summaryRow: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', gap: 12 },
  summaryBig: { color: TEXT, fontSize: 18, fontWeight: '900', marginTop: 3 },
  divider: { height: 1, backgroundColor: 'rgba(255,255,255,0.08)', marginVertical: 4 },
  meta: { color: MUTED, fontSize: 11 },
  value: { color: TEXT, fontSize: 12, fontWeight: '800' },
  estimateNote: { color: MUTED, fontSize: 10, lineHeight: 14 },
  warning: { color: WARN, fontSize: 11, lineHeight: 15 },
  courseCard: { backgroundColor: CARD, borderRadius: 14, borderWidth: 1, borderColor: 'rgba(255,255,255,0.07)', marginBottom: 12, overflow: 'hidden' },
  courseHeader: { minHeight: 66, flexDirection: 'row', alignItems: 'center', paddingHorizontal: 14, paddingVertical: 12, gap: 12 },
  courseTitle: { color: TEXT, fontSize: 15, fontWeight: '900' },
  courseMeta: { color: MUTED, fontSize: 11, marginTop: 3 },
  chevron: { color: MUTED, fontSize: 20, paddingHorizontal: 4 },
  moduleBlock: { borderTopWidth: 1, borderTopColor: 'rgba(255,255,255,0.07)', backgroundColor: 'rgba(0,0,0,0.08)' },
  moduleHeader: { minHeight: 62, flexDirection: 'row', alignItems: 'center', gap: 8, paddingHorizontal: 14, paddingVertical: 10 },
  moduleTitle: { color: TEXT, fontSize: 13, fontWeight: '800' },
  moduleMeta: { color: MUTED, fontSize: 10, marginTop: 3 },
  moduleSelect: { borderWidth: 1, borderColor: 'rgba(79,195,247,0.4)', borderRadius: 8, paddingHorizontal: 9, paddingVertical: 7 },
  moduleSelectActive: { backgroundColor: ACCENT, borderColor: ACCENT },
  moduleSelectText: { color: ACCENT, fontSize: 10, fontWeight: '800' },
  moduleSelectTextActive: { color: '#07141C' },
  chapterRow: { minHeight: 62, flexDirection: 'row', alignItems: 'center', gap: 11, paddingHorizontal: 14, paddingVertical: 10, borderTopWidth: StyleSheet.hairlineWidth, borderTopColor: 'rgba(255,255,255,0.06)' },
  chapterDisabled: { opacity: 0.55 },
  checkbox: { width: 24, height: 24, borderRadius: 7, borderWidth: 1.5, borderColor: MUTED, alignItems: 'center', justifyContent: 'center' },
  checkboxChecked: { backgroundColor: ACCENT, borderColor: ACCENT },
  checkboxDone: { backgroundColor: SUCCESS, borderColor: SUCCESS },
  check: { color: '#07141C', fontWeight: '900' },
  chapterTitle: { color: TEXT, fontSize: 12, fontWeight: '700' },
  chapterMeta: { color: MUTED, fontSize: 10, marginTop: 3 },
  status: { color: SUCCESS, fontSize: 10, fontWeight: '800' },
  empty: { alignItems: 'center', paddingVertical: 40 },
  emptyTitle: { color: TEXT, fontWeight: '800', marginBottom: 5 },
  muted: { color: MUTED, fontSize: 12 },
  footer: { position: 'absolute', left: 0, right: 0, bottom: 0, minHeight: 82, backgroundColor: SURFACE, borderTopWidth: 1, borderTopColor: 'rgba(255,255,255,0.10)', paddingHorizontal: 18, paddingVertical: 13, flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between' },
  footerCount: { color: TEXT, fontSize: 13, fontWeight: '900' },
  footerSize: { color: MUTED, fontSize: 11, marginTop: 2 },
  downloadButton: { minWidth: 130, minHeight: 48, backgroundColor: ACCENT, borderRadius: 10, alignItems: 'center', justifyContent: 'center', paddingHorizontal: 16 },
  downloadDisabled: { opacity: 0.4 },
  downloadText: { color: '#07141C', fontSize: 13, fontWeight: '900' },
});
