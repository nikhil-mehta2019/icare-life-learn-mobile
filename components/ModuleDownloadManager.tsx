import { useCallback, useMemo, useState } from 'react';
import {
  ActivityIndicator,
  Alert,
  Modal,
  Pressable,
  ScrollView,
  StyleSheet,
  Text,
  View,
} from 'react-native';
import { fetchChapters, type Chapter } from '../api/base44Client';
import IcareOfflineDrm, { type DeviceStorageStats, type DownloadInfo } from '../modules/icare-offline-drm';
import {
  estimateChapterDownloadBytes,
  formatDownloadBytes,
  queueChapterForOffline,
} from '../utils/offlineDownload';

const BG = '#0F1923';
const CARD = '#1C2B35';
const SURFACE = '#243344';
const TEXT = '#F0F4F8';
const MUTED = '#8A9BB0';
const ACCENT = '#4FC3F7';
const SUCCESS = '#66BB6A';
const WARN = '#FFA726';
const RESERVE_BYTES = 1024 * 1024 * 1024;

const EMPTY_STORAGE: DeviceStorageStats = { totalBytes: 0, usedBytes: 0, freeBytes: 0 };

export default function ModuleDownloadManager({
  chapter,
  jwt,
}: {
  chapter: Chapter | null;
  jwt: string | null;
}) {
  const [visible, setVisible] = useState(false);
  const [loading, setLoading] = useState(false);
  const [queueing, setQueueing] = useState(false);
  const [chapters, setChapters] = useState<Chapter[]>([]);
  const [downloads, setDownloads] = useState<Record<string, DownloadInfo>>({});
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [storage, setStorage] = useState<DeviceStorageStats>(EMPTY_STORAGE);

  const downloadable = useMemo(
    () => chapters.filter((item) => item.contentType === 'video' && Boolean(item.muxDrmPlaybackId || item.muxSignedPlaybackId || item.muxPlaybackId)),
    [chapters],
  );

  const selectable = useMemo(
    () => downloadable.filter((item) => !downloads[item.id] || downloads[item.id].state === 'failed'),
    [downloadable, downloads],
  );

  const selectedChapters = useMemo(
    () => selectable.filter((item) => selected.has(item.id)),
    [selectable, selected],
  );

  const estimatedBytes = useMemo(
    () => selectedChapters.reduce((sum, item) => sum + estimateChapterDownloadBytes(item), 0),
    [selectedChapters],
  );

  const freeAfter = Math.max(0, storage.freeBytes - estimatedBytes);
  const enoughStorage = storage.freeBytes <= 0 || freeAfter >= RESERVE_BYTES;

  const open = useCallback(async () => {
    if (!chapter?.moduleId) {
      Alert.alert('Downloads unavailable', 'This lesson is not linked to a course module.');
      return;
    }
    if (!jwt) {
      Alert.alert('Reconnect required', 'Please return to Learn while online, then try again.');
      return;
    }

    setVisible(true);
    setLoading(true);
    setSelected(new Set());
    try {
      const [moduleChapters, existing, device] = await Promise.all([
        fetchChapters(chapter.moduleId),
        IcareOfflineDrm.listDownloads(),
        IcareOfflineDrm.getDeviceStorageStats().catch(() => EMPTY_STORAGE),
      ]);
      const byId: Record<string, DownloadInfo> = {};
      for (const item of existing) byId[item.id] = item;
      setDownloads(byId);
      setStorage(device);
      setChapters(moduleChapters);
    } catch (error: any) {
      Alert.alert('Could not load module', error?.message ?? String(error));
      setVisible(false);
    } finally {
      setLoading(false);
    }
  }, [chapter?.moduleId, jwt]);

  const toggle = (id: string) => {
    setSelected((current) => {
      const next = new Set(current);
      if (next.has(id)) next.delete(id); else next.add(id);
      return next;
    });
  };

  const selectAll = () => {
    if (selected.size === selectable.length && selectable.length > 0) setSelected(new Set());
    else setSelected(new Set(selectable.map((item) => item.id)));
  };

  const startBatch = useCallback(async () => {
    if (!jwt || !selectedChapters.length || queueing) return;
    if (!enoughStorage) {
      Alert.alert(
        'Not enough storage',
        `These videos need approximately ${formatDownloadBytes(estimatedBytes)}. Keep at least 1 GB free after downloading.`,
      );
      return;
    }

    setQueueing(true);
    let queued = 0;
    const failures: string[] = [];
    for (const item of selectedChapters) {
      try {
        await queueChapterForOffline(item, jwt);
        queued += 1;
      } catch (error: any) {
        failures.push(`${item.title}: ${error?.message ?? 'failed'}`);
      }
    }
    setQueueing(false);

    if (queued > 0) {
      setVisible(false);
      Alert.alert(
        'Downloads queued',
        `${queued} ${queued === 1 ? 'video' : 'videos'} added to My Downloads.${failures.length ? `\n\n${failures.length} could not be queued.` : ''}`,
      );
    } else {
      Alert.alert('Nothing queued', failures[0] ?? 'Please try again.');
    }
  }, [jwt, selectedChapters, queueing, enoughStorage, estimatedBytes]);

  if (!chapter?.moduleId) return null;

  return (
    <>
      <Pressable style={styles.openButton} onPress={open}>
        <Text style={styles.openButtonText}>☑ Select Multiple Videos</Text>
      </Pressable>

      <Modal visible={visible} animationType="slide" onRequestClose={() => !queueing && setVisible(false)}>
        <View style={styles.screen}>
          <View style={styles.header}>
            <Pressable disabled={queueing} onPress={() => setVisible(false)} hitSlop={12}>
              <Text style={styles.headerAction}>‹ Back</Text>
            </Pressable>
            <View style={{ flex: 1 }}>
              <Text style={styles.headerTitle}>Download Module</Text>
              <Text style={styles.headerSub}>Select multiple videos for offline learning</Text>
            </View>
          </View>

          {loading ? (
            <View style={styles.center}><ActivityIndicator color={ACCENT} /><Text style={styles.muted}>Loading module videos…</Text></View>
          ) : (
            <>
              <View style={styles.summaryCard}>
                <View style={styles.summaryRow}>
                  <View><Text style={styles.eyebrow}>AVAILABLE STORAGE</Text><Text style={styles.summaryBig}>{storage.freeBytes > 0 ? formatDownloadBytes(storage.freeBytes) : 'Unavailable'}</Text></View>
                  <View style={{ alignItems: 'flex-end' }}><Text style={styles.eyebrow}>SELECTED</Text><Text style={styles.summaryBig}>{selectedChapters.length} video{selectedChapters.length === 1 ? '' : 's'}</Text></View>
                </View>
                <View style={styles.divider} />
                <View style={styles.summaryRow}>
                  <Text style={styles.muted}>Estimated download size</Text><Text style={styles.summaryValue}>~{formatDownloadBytes(estimatedBytes)}</Text>
                </View>
                <View style={styles.summaryRow}>
                  <Text style={styles.muted}>Estimated free after download</Text><Text style={[styles.summaryValue, !enoughStorage && { color: WARN }]}>{storage.freeBytes > 0 ? formatDownloadBytes(freeAfter) : '—'}</Text>
                </View>
                <Text style={styles.estimateNote}>Size is estimated from lesson duration; final HLS storage may vary.</Text>
                {!enoughStorage && <Text style={styles.warning}>⚠ Select fewer videos or free device storage. iCare keeps a 1 GB safety reserve.</Text>}
              </View>

              <View style={styles.listHeader}>
                <Text style={styles.listTitle}>Module videos</Text>
                <Pressable onPress={selectAll} disabled={!selectable.length}>
                  <Text style={styles.selectAll}>{selected.size === selectable.length && selectable.length > 0 ? 'Clear all' : 'Select all'}</Text>
                </Pressable>
              </View>

              <ScrollView style={{ flex: 1 }} contentContainerStyle={styles.listContent}>
                {downloadable.map((item, index) => {
                  const existing = downloads[item.id];
                  const unavailable = existing && existing.state !== 'failed';
                  const checked = selected.has(item.id);
                  const status = existing?.state === 'completed' ? 'Downloaded' : existing ? existing.state === 'downloading' ? 'Downloading' : existing.state === 'queued' ? 'Queued' : existing.state === 'stopped' ? 'Paused' : null : null;
                  return (
                    <Pressable key={item.id} disabled={Boolean(unavailable)} onPress={() => toggle(item.id)} style={[styles.lessonRow, unavailable && styles.lessonDisabled]}>
                      <View style={[styles.checkbox, checked && styles.checkboxChecked, unavailable && styles.checkboxUnavailable]}><Text style={styles.checkText}>{checked ? '✓' : unavailable ? '✓' : ''}</Text></View>
                      <View style={{ flex: 1 }}>
                        <Text style={styles.lessonTitle} numberOfLines={2}>{index + 1}. {item.title}</Text>
                        <Text style={styles.lessonMeta}>{item.estimatedMinutes ? `${item.estimatedMinutes} min · ` : ''}~{formatDownloadBytes(estimateChapterDownloadBytes(item))}</Text>
                      </View>
                      {status && <Text style={styles.statusText}>{status}</Text>}
                    </Pressable>
                  );
                })}
                {!downloadable.length && <Text style={styles.emptyText}>No downloadable video lessons are available in this module.</Text>}
              </ScrollView>

              <View style={styles.footer}>
                <View><Text style={styles.footerCount}>{selectedChapters.length} selected</Text><Text style={styles.footerSize}>~{formatDownloadBytes(estimatedBytes)}</Text></View>
                <Pressable disabled={!selectedChapters.length || queueing || !enoughStorage} onPress={startBatch} style={[styles.downloadButton, (!selectedChapters.length || queueing || !enoughStorage) && styles.disabledButton]}>
                  {queueing ? <ActivityIndicator color="#07141C" /> : <Text style={styles.downloadButtonText}>Download {selectedChapters.length || ''}</Text>}
                </Pressable>
              </View>
            </>
          )}
        </View>
      </Modal>
    </>
  );
}

const styles = StyleSheet.create({
  screen: { flex: 1, backgroundColor: BG, paddingTop: 48 },
  header: { flexDirection: 'row', alignItems: 'center', gap: 14, paddingHorizontal: 18, paddingBottom: 16, borderBottomWidth: 1, borderBottomColor: 'rgba(255,255,255,0.08)' },
  headerAction: { color: ACCENT, fontSize: 16, fontWeight: '700' },
  headerTitle: { color: TEXT, fontSize: 19, fontWeight: '800' },
  headerSub: { color: MUTED, fontSize: 12, marginTop: 2 },
  center: { flex: 1, alignItems: 'center', justifyContent: 'center', gap: 10 },
  muted: { color: MUTED, fontSize: 12 },
  summaryCard: { margin: 16, marginBottom: 8, padding: 16, borderRadius: 14, backgroundColor: CARD, borderWidth: 1, borderColor: 'rgba(79,195,247,0.15)', gap: 8 },
  summaryRow: { flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center', gap: 12 },
  eyebrow: { color: MUTED, fontSize: 10, fontWeight: '800', letterSpacing: 0.8 },
  summaryBig: { color: TEXT, fontSize: 18, fontWeight: '800', marginTop: 3 },
  summaryValue: { color: TEXT, fontSize: 12, fontWeight: '700' },
  divider: { height: 1, backgroundColor: 'rgba(255,255,255,0.08)', marginVertical: 4 },
  estimateNote: { color: MUTED, fontSize: 10, lineHeight: 14, marginTop: 2 },
  warning: { color: WARN, fontSize: 11, lineHeight: 15, marginTop: 3 },
  listHeader: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', paddingHorizontal: 18, paddingVertical: 12 },
  listTitle: { color: TEXT, fontSize: 15, fontWeight: '800' },
  selectAll: { color: ACCENT, fontSize: 13, fontWeight: '700' },
  listContent: { paddingHorizontal: 16, paddingBottom: 140, gap: 8 },
  lessonRow: { flexDirection: 'row', alignItems: 'center', minHeight: 64, padding: 12, borderRadius: 12, backgroundColor: CARD, borderWidth: 1, borderColor: 'rgba(255,255,255,0.07)', gap: 12 },
  lessonDisabled: { opacity: 0.58 },
  checkbox: { width: 24, height: 24, borderRadius: 7, borderWidth: 1.5, borderColor: MUTED, alignItems: 'center', justifyContent: 'center' },
  checkboxChecked: { backgroundColor: ACCENT, borderColor: ACCENT },
  checkboxUnavailable: { backgroundColor: SUCCESS, borderColor: SUCCESS },
  checkText: { color: '#07141C', fontSize: 14, fontWeight: '900' },
  lessonTitle: { color: TEXT, fontSize: 13, fontWeight: '700' },
  lessonMeta: { color: MUTED, fontSize: 11, marginTop: 3 },
  statusText: { color: SUCCESS, fontSize: 10, fontWeight: '800' },
  emptyText: { color: MUTED, textAlign: 'center', paddingVertical: 32 },
  footer: { position: 'absolute', left: 0, right: 0, bottom: 0, minHeight: 84, paddingHorizontal: 18, paddingVertical: 14, backgroundColor: SURFACE, borderTopWidth: 1, borderTopColor: 'rgba(255,255,255,0.1)', flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between' },
  footerCount: { color: TEXT, fontSize: 13, fontWeight: '800' },
  footerSize: { color: MUTED, fontSize: 11, marginTop: 2 },
  downloadButton: { minWidth: 130, minHeight: 48, borderRadius: 10, backgroundColor: ACCENT, alignItems: 'center', justifyContent: 'center', paddingHorizontal: 18 },
  disabledButton: { opacity: 0.4 },
  downloadButtonText: { color: '#07141C', fontWeight: '900', fontSize: 13 },
  openButton: { marginHorizontal: 12, marginTop: 2, minHeight: 44, borderRadius: 9, borderWidth: 1, borderColor: 'rgba(79,195,247,0.35)', backgroundColor: 'rgba(79,195,247,0.08)', alignItems: 'center', justifyContent: 'center', paddingHorizontal: 14 },
  openButtonText: { color: ACCENT, fontSize: 13, fontWeight: '800' },
});
