/**
 * Audio / subtitle choice logic for the offline player. Mirrors Android's
 * OfflinePlayerActivity: one entry per language, limited to and ordered by the learner's
 * preferred languages (up to three), first preferred audio as default, first preferred
 * caption as default (otherwise captions off).
 */

export interface RawTrack {
  index: number;
  title?: string;
  language?: string;
}

export interface TrackChoice {
  /** Normalised base language code, e.g. "en". */
  key: string;
  label: string;
  /** Index to hand to react-native-video's selectedAudioTrack / selectedTextTrack. */
  index: number;
}

const ALIASES: Record<string, string> = {
  eng: 'en', spa: 'es', swa: 'sw', hin: 'hi', mar: 'mr', guj: 'gu', tam: 'ta', tel: 'te',
  kan: 'kn', mal: 'ml', ben: 'bn', pan: 'pa', urd: 'ur', deu: 'de', ger: 'de', ell: 'el',
  gre: 'el', fra: 'fr', fre: 'fr',
};

export function normalizeLanguage(code?: string | null): string {
  const raw = String(code ?? '').trim().toLowerCase().replace('_', '-');
  if (!raw) return '';
  const base = raw.split('-')[0];
  return base.length === 2 ? base : (ALIASES[base] ?? base.slice(0, 2));
}

export function languageLabel(key: string, fallback?: string): string {
  try {
    const names = new (Intl as any).DisplayNames(['en'], { type: 'language' });
    const name = names.of(key);
    if (name && name !== key) return name;
  } catch {
    /* Intl.DisplayNames unavailable */
  }
  return fallback && fallback.trim() ? fallback : key.toUpperCase();
}

export function buildChoices(tracks: RawTrack[] | undefined, preferred: string[]): TrackChoice[] {
  const byLanguage = new Map<string, TrackChoice>();
  for (const t of tracks ?? []) {
    const key = normalizeLanguage(t.language) || normalizeLanguage(t.title);
    if (!key || byLanguage.has(key)) continue;
    byLanguage.set(key, { key, label: languageLabel(key, t.title), index: t.index });
  }
  const all = Array.from(byLanguage.values());
  if (!preferred.length) return all;
  const ordered: TrackChoice[] = [];
  for (const code of preferred) {
    const hit = byLanguage.get(normalizeLanguage(code));
    if (hit && !ordered.includes(hit)) ordered.push(hit);
  }
  // None of the learner's languages exist in this download: show everything rather
  // than leaving the learner without a choice.
  return ordered.length ? ordered : all;
}

export const PLAYBACK_RATES = [0.5, 0.75, 1, 1.25, 1.5, 2];
export function rateLabel(rate: number): string {
  return rate === 1 ? 'Normal' : `${rate}x`;
}
