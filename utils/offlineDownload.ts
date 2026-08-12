import type { Chapter } from '../api/base44Client';
import { fetchUserPreferences, getMuxDownloadToken, selectMuxPlaybackId } from '../api/base44Client';
import IcareOfflineDrm from '../modules/icare-offline-drm';

const MB = 1024 * 1024;

/**
 * Planning estimate only. HLS is adaptive and the final Media3 cache size can
 * vary by rendition/segment. 18 MB/min is intentionally conservative for the
 * current iCare offline profile and is always labelled "estimated" in UI.
 */
export function estimateChapterDownloadBytes(chapter: Chapter): number {
  const minutes = Math.max(1, Number(chapter.estimatedMinutes || 1));
  return Math.max(20 * MB, Math.round(minutes * 18 * MB));
}

export function formatDownloadBytes(bytes: number): string {
  if (!Number.isFinite(bytes) || bytes <= 0) return '0 B';
  if (bytes < 1024 * 1024) return `${Math.round(bytes / 1024)} KB`;
  if (bytes < 1024 * 1024 * 1024) return `${(bytes / MB).toFixed(0)} MB`;
  return `${(bytes / (1024 * MB)).toFixed(2)} GB`;
}

function normalizeBase(code: string): string {
  const raw = String(code || '').trim().toLowerCase().replace('_', '-');
  const base = raw.split('-')[0];
  const aliases: Record<string, string> = {
    eng: 'en', spa: 'es', swa: 'sw', hin: 'hi', mar: 'mr', guj: 'gu',
    tam: 'ta', tel: 'te', kan: 'kn', mal: 'ml', ben: 'bn', pan: 'pa', urd: 'ur',
  };
  return base.length === 2 ? base : (aliases[base] ?? base.slice(0, 2));
}

function selectAvailableLanguages(available: string[], preferred: string[]): string[] | undefined {
  const wanted = new Set(preferred.map(normalizeBase).filter(Boolean));
  if (!wanted.size) return undefined;
  if (!available.length) return Array.from(wanted);
  const matched = available.filter((code) => wanted.has(normalizeBase(code)));
  return matched.length ? matched : undefined;
}

export async function queueChapterForOffline(chapter: Chapter, jwt: string): Promise<void> {
  const playbackId = selectMuxPlaybackId(chapter);
  if (!playbackId) throw new Error(`${chapter.title} has no downloadable video.`);

  const [tokens, preferences] = await Promise.all([
    getMuxDownloadToken(playbackId, jwt, chapter.courseId),
    fetchUserPreferences(jwt).catch(() => null),
  ]);

  if (!tokens.manifestUrl) throw new Error(`Could not prepare ${chapter.title} for download.`);

  const preferred = preferences?.preferredLanguages?.length
    ? preferences.preferredLanguages.slice(0, 3)
    : preferences?.primaryLanguage
      ? [preferences.primaryLanguage]
      : [];

  await IcareOfflineDrm.startDownload({
    id: chapter.id,
    manifestUrl: tokens.manifestUrl,
    drmLicenseUrl: tokens.widevineLicenseUrl ?? '',
    drmToken: tokens.drmToken ?? '',
    title: chapter.title,
    thumbnailUrl: chapter.videoPosterUrl ?? undefined,
    durationSeconds: chapter.estimatedMinutes
      ? Math.round(chapter.estimatedMinutes * 60)
      : undefined,
    audioLanguages: selectAvailableLanguages(tokens.audioLanguages ?? [], preferred),
    captionLanguages: selectAvailableLanguages(tokens.captionLanguages ?? [], preferred),
  });
}
