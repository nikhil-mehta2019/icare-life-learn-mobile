// SECURITY NOTE: API_KEY is bundled into the APK. Before production release,
// move this to a runtime config fetched after auth, or use per-user signed
// tokens served by a Base44 backend function.

import IcareOfflineDrm from '../modules/icare-offline-drm';

export const BASE_URL = 'https://icare-life-learn.base44.app/api';
export const API_KEY = '6af260f41e2140b9950788621360c5cf';

const ICARE_VIDEO_API_BASE = 'http://35.154.164.178:8000';
const ICARE_VIDEO_API_KEY = 'sk_icare_1b75de18308eb135e2df9ef29aef825266eea22041f8e4a9';

const defaultHeaders: Record<string, string> = {
  'Content-Type': 'application/json',
  'api_key': API_KEY,
};

export interface Course {
  id: string;
  title: string;
  slug?: string;
  shortDescription?: string;
  fullDescription?: string;
  thumbnailUrl?: string;
  bannerImageUrl?: string;
  category?: string;
  language?: 'english' | 'hindi' | 'tamil' | 'telugu' | 'kannada' | 'malayalam' | 'other';
  audienceType?: 'agency_only' | 'public_catalog';
  agencyId?: string;
  status?: 'draft' | 'published' | 'archived';
  sortOrder?: number;
  totalModules?: number;
  totalChapters?: number;
  totalDurationMinutes?: number;
  showInCatalog?: boolean;
  isSample?: boolean;
  muxPlaybackMode?: 'public' | 'signed' | 'drm';
  courseAccessType?: 'free' | 'paid' | 'subscription' | 'hidden';
  priceINR?: number;
  priceUSD?: number;
  compareAtPriceINR?: number;
  compareAtPriceUSD?: number;
  pricingEnabled?: boolean;
  purchaseEnabled?: boolean;
  trialAllowed?: boolean;
  defaultTrialDays?: number;
  includedInOTTSubscription?: boolean;
  created_date?: string;
  updated_date?: string;
}

export interface Module {
  id: string;
  courseId: string;
  title: string;
  description?: string;
  sortOrder?: number;
  status?: 'draft' | 'published' | 'archived';
  totalChapters?: number;
  totalDurationMinutes?: number;
  legacyModuleCode?: string;
  created_date?: string;
  updated_date?: string;
}

export interface Chapter {
  id: string;
  courseId: string;
  moduleId: string;
  title: string;
  description?: string;
  contentType?: 'video' | 'ispring' | 'pdf' | 'resource';
  muxAssetId?: string;
  muxPlaybackId?: string;
  muxSignedPlaybackId?: string;
  muxDrmPlaybackId?: string;
  muxSignedPlaybackRequired?: boolean;
  muxDrmProtected?: boolean;
  videoPosterUrl?: string;
  ispringUrl?: string;
  ispringUrlsJson?: string;
  slidesUrl?: string;
  resourceUrl?: string;
  textContent?: string;
  estimatedMinutes?: number;
  isFreePreview?: boolean;
  sortOrder?: number;
  status?: 'draft' | 'published' | 'archived';
  legacyChapterCode?: string;
  created_date?: string;
  updated_date?: string;
}

export interface MuxTokenResponse {
  token: string;
  drmToken: string;
  drmLicenseUrl: string;
  secureStreamUrl: string;
}

export interface MuxDownloadTokenResponse {
  drmEnabled: boolean;
  manifestUrl: string;
  drmToken: string | null;
  widevineLicenseUrl: string | null;
  audioLanguages: string[];
  captionLanguages: string[];
}

export interface UserPreferences {
  preferredLanguages: string[];
  primaryLanguage: string | null;
  preferredLanguage: string | null;
  isComplete: boolean;
}

export interface StudentAccessResponse {
  hasCourseAccess: boolean;
  courseAccessReason?: string;
  courseAccessExpiresAt?: string;
  isOnTrial?: boolean;
}

async function apiGet<T>(path: string): Promise<{ status: number; data: T }> {
  const response = await fetch(`${BASE_URL}${path}`, { headers: defaultHeaders });
  const data = await response.json();
  return { status: response.status, data };
}

async function apiPost<T>(
  path: string,
  body: object,
  withCredentials = false
): Promise<T> {
  const response = await fetch(`${BASE_URL}${path}`, {
    method: 'POST',
    headers: defaultHeaders,
    ...(withCredentials ? { credentials: 'include' as RequestCredentials } : {}),
    body: JSON.stringify(body),
  });
  const data = await response.json();
  if (!response.ok) {
    throw new Error((data as any)?.error ?? `Request failed (${response.status})`);
  }
  return data as T;
}

export async function fetchCourses(
  filter?: object,
  limit = 50
): Promise<Course[]> {
  const q = filter ? `&q=${encodeURIComponent(JSON.stringify(filter))}` : '';
  const { data } = await apiGet<Course[]>(
    `/entities/Course?limit=${limit}&sort_by=sortOrder${q}`
  );
  return Array.isArray(data) ? data : [];
}

export async function fetchCourse(
  courseId: string
): Promise<{ status: number; data: Course }> {
  return apiGet<Course>(`/entities/Course/${courseId}`);
}

export async function fetchModules(courseId: string): Promise<Module[]> {
  const q = encodeURIComponent(JSON.stringify({ courseId, status: 'published' }));
  const { data } = await apiGet<Module[]>(
    `/entities/Module?q=${q}&sort_by=sortOrder`
  );
  return Array.isArray(data) ? data : [];
}

export async function fetchModule(
  moduleId: string
): Promise<{ status: number; data: Module }> {
  return apiGet<Module>(`/entities/Module/${moduleId}`);
}

export async function fetchChapters(moduleId: string): Promise<Chapter[]> {
  const q = encodeURIComponent(JSON.stringify({ moduleId, status: 'published' }));
  const { data } = await apiGet<Chapter[]>(
    `/entities/Chapter?q=${q}&sort_by=sortOrder`
  );
  return Array.isArray(data) ? data : [];
}

export async function fetchChapter(
  chapterId: string
): Promise<{ status: number; data: Chapter }> {
  return apiGet<Chapter>(`/entities/Chapter/${chapterId}`);
}

export function selectMuxPlaybackId(chapter: Chapter): string | null {
  if (chapter.muxDrmProtected && chapter.muxDrmPlaybackId) {
    return chapter.muxDrmPlaybackId;
  }
  if (chapter.muxSignedPlaybackRequired && chapter.muxSignedPlaybackId) {
    return chapter.muxSignedPlaybackId;
  }
  return chapter.muxPlaybackId ?? null;
}

export async function getMuxToken(playbackId: string): Promise<MuxTokenResponse> {
  return apiPost<MuxTokenResponse>('/functions/getMuxToken', { playbackId }, true);
}

export async function getMuxDownloadToken(
  playbackId: string,
  _jwt?: string
): Promise<MuxDownloadTokenResponse> {
  const response = await fetch(
    `${ICARE_VIDEO_API_BASE}/videos/by-mux-id/${encodeURIComponent(playbackId)}/download`,
    { headers: { 'X-API-Key': ICARE_VIDEO_API_KEY } }
  );
  const data = await response.json();
  if (!response.ok) {
    throw new Error((data as any)?.detail ?? `Download token fetch failed (${response.status})`);
  }
  const offline = (data as any).offline ?? {};
  return {
    drmEnabled: !!(data as any).drm_enabled,
    manifestUrl: offline.manifest_url ?? (data as any).download_url ?? '',
    drmToken: offline.drm_token ?? '',
    widevineLicenseUrl: offline.widevine_license_url ?? '',
    audioLanguages: (data as any).audio_languages ?? [],
    captionLanguages: (data as any).caption_languages ?? [],
  };
}

function normalizePreferenceCodes(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  const seen = new Set<string>();
  const out: string[] = [];
  for (const item of value) {
    const code = String(item || '').trim().toLowerCase();
    if (!code || seen.has(code)) continue;
    seen.add(code);
    out.push(code);
    if (out.length === 3) break;
  }
  return out;
}

/**
 * Get the authenticated learner's ordered three-language contract.
 * The primary/legacy preferredLanguage remains available for old call sites.
 * On Android the full trio is also persisted into the native module so the
 * offline player can apply the same visibility/order/default rules without
 * performing its own Base44 authentication.
 */
export async function fetchUserPreferences(jwt: string): Promise<UserPreferences> {
  const response = await fetch(`${BASE_URL}/functions/getMyPreferences`, {
    method: 'POST',
    headers: { ...defaultHeaders, Authorization: `Bearer ${jwt}` },
    body: JSON.stringify({}),
  });
  const data = await response.json().catch(() => ({} as any));
  if (!response.ok) {
    throw new Error((data as any)?.error ?? `getMyPreferences failed (${response.status})`);
  }

  const d = data as any;
  const rawOrdered =
    d?.preferredLanguages ?? d?.data?.preferredLanguages ?? d?.user?.preferredLanguages ?? [];
  let preferredLanguages = normalizePreferenceCodes(rawOrdered);
  const legacy =
    d?.primaryLanguage ?? d?.preferredLanguage ?? d?.preferred_language ??
    d?.data?.preferredLanguage ?? d?.user?.preferredLanguage ?? null;
  const primaryLanguage = preferredLanguages[0] ?? (legacy ? String(legacy).toLowerCase() : null);
  if (!preferredLanguages.length && primaryLanguage) preferredLanguages = [primaryLanguage];

  try {
    await IcareOfflineDrm.setPreferredLanguages(preferredLanguages);
  } catch (error) {
    console.warn('[base44Client] Could not persist native language preferences', error);
  }

  return {
    preferredLanguages,
    primaryLanguage,
    preferredLanguage: primaryLanguage,
    isComplete: preferredLanguages.length === 3,
  };
}

export async function getMuxTokenWithJwt(
  playbackId: string,
  jwt: string
): Promise<MuxTokenResponse> {
  const response = await fetch(`${BASE_URL}/functions/getMuxToken`, {
    method: 'POST',
    headers: {
      ...defaultHeaders,
      'Authorization': `Bearer ${jwt}`,
    },
    body: JSON.stringify({ playbackId }),
  });
  const data = await response.json();
  if (!response.ok) {
    throw new Error((data as any)?.error ?? `getMuxToken failed (${response.status})`);
  }
  return data as MuxTokenResponse;
}

export async function resolveStudentAccess(
  courseId: string
): Promise<{ status: number; data: StudentAccessResponse }> {
  const response = await fetch(`${BASE_URL}/functions/resolveStudentAccess`, {
    method: 'POST',
    headers: defaultHeaders,
    credentials: 'include',
    body: JSON.stringify({ courseId }),
  });
  const data = await response.json();
  return { status: response.status, data };
}

export async function testConnection(): Promise<{ status: number; data: unknown }> {
  return apiGet('/entities/Course?limit=1');
}
