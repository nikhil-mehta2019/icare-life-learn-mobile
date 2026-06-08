// SECURITY NOTE: API_KEY is bundled into the APK. Before production release,
// move this to a runtime config fetched after auth, or use per-user signed
// tokens served by a Base44 backend function.
//
// API_KEY and BASE_URL are exported so explore.tsx can inject them into the
// WebView at runtime (via injectJavaScript) rather than embedding them in the
// static injectedJavaScriptBeforeContentLoaded string.  This keeps them out of
// the easily-readable static bundle text in the APK, though they remain in the
// compiled JS bundle — a proper secrets-management solution (env var at build
// time, or a post-auth token endpoint) is the long-term fix.

export const BASE_URL = 'https://icare-life-learn.base44.app/api';
export const API_KEY = '6af260f41e2140b9950788621360c5cf';

const defaultHeaders: Record<string, string> = {
  'Content-Type': 'application/json',
  'api_key': API_KEY,
};

// ─── Entity Types ──────────────────────────────────────────────────────────────

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
  // ─ Playback IDs — use selectMuxPlaybackId() to choose the right one ─
  muxPlaybackId?: string;           // public (unsigned)
  muxSignedPlaybackId?: string;     // signed/token-protected streams
  muxDrmPlaybackId?: string;        // Widevine DRM streams
  muxSignedPlaybackRequired?: boolean;
  muxDrmProtected?: boolean;
  videoPosterUrl?: string;
  ispringUrl?: string;
  ispringUrlsJson?: string;         // JSON string: [{language, url}]
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

export interface StudentAccessResponse {
  hasCourseAccess: boolean;
  courseAccessReason?: string;
  courseAccessExpiresAt?: string;
  isOnTrial?: boolean;
}

// ─── Internal HTTP helpers ─────────────────────────────────────────────────────

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

// ─── Course ────────────────────────────────────────────────────────────────────

/** Fetch published courses visible in the catalog. */
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

// ─── Module ────────────────────────────────────────────────────────────────────

export async function fetchModules(courseId: string): Promise<Module[]> {
  const q = encodeURIComponent(JSON.stringify({ courseId, status: 'published' }));
  const { data } = await apiGet<Module[]>(
    `/entities/Module?q=${q}&sort_by=sortOrder`
  );
  return Array.isArray(data) ? data : [];
}

// ─── Chapter ───────────────────────────────────────────────────────────────────

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

/**
 * Pick the correct Mux playback ID for token generation.
 *
 * Priority:  DRM playback ID  >  Signed playback ID  >  Public playback ID
 *
 * This matters because getMuxToken() issues different tokens based on the
 * type of playback ID passed. Passing the wrong ID will result in either
 * an unsigned stream or a failed DRM license acquisition.
 */
export function selectMuxPlaybackId(chapter: Chapter): string | null {
  if (chapter.muxDrmProtected && chapter.muxDrmPlaybackId) {
    return chapter.muxDrmPlaybackId;
  }
  if (chapter.muxSignedPlaybackRequired && chapter.muxSignedPlaybackId) {
    return chapter.muxSignedPlaybackId;
  }
  return chapter.muxPlaybackId ?? null;
}

// ─── Backend Functions ─────────────────────────────────────────────────────────

/**
 * Get Mux signed tokens for playback.
 * Always call selectMuxPlaybackId() first to pick the right playback ID.
 * Returns: { token, drmToken, drmLicenseUrl, secureStreamUrl }
 */
export async function getMuxToken(playbackId: string): Promise<MuxTokenResponse> {
  return apiPost<MuxTokenResponse>('/functions/getMuxToken', { playbackId }, true);
}

/**
 * Get Mux tokens using an explicit auth JWT (bypasses WebView session cookies).
 * Used when the WebView is backgrounded and postMessage is suppressed by Android.
 */
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

/**
 * Resolve whether the authenticated student has access to a course.
 * Requires the student to be logged in via the WebView session cookie.
 */
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

// ─── Dev / connection test ──────────────────────────────────────────────────────

/** Used only during development to verify connectivity. */
export async function testConnection(): Promise<{ status: number; data: unknown }> {
  return apiGet('/entities/Course?limit=1');
}
