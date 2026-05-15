// SECURITY: API_KEY is currently bundled into the APK. Anyone decompiling the
// APK can extract it. Before production, move this to a runtime config fetched
// after auth (or per-user signed tokens served by a Base44 backend function).
const BASE_URL = 'https://base44.app/api';
const APP_ID = '69e27cfb0f37443a073af5db';
const API_KEY = 'c346575bc64b432ba9f0c78790cd631d';

const headers = {
  'Content-Type': 'application/json',
  'api_key': API_KEY,
};

export async function fetchEntities(entityName) {
  const response = await fetch(`${BASE_URL}/apps/${APP_ID}/entities/${entityName}`, { headers });
  const data = await response.json();
  return { status: response.status, data };
}

export async function testConnection() {
  const response = await fetch(`${BASE_URL}/apps/${APP_ID}/entities/Course`, { headers });
  const data = await response.json();
  return { status: response.status, data };
}

/**
 * Fetch a single Chapter by ID. Returns the row including muxPlaybackId,
 * muxDrmProtected, muxSignedPlaybackRequired, videoPosterUrl.
 */
export async function fetchChapter(chapterId) {
  const response = await fetch(
    `${BASE_URL}/apps/${APP_ID}/entities/Chapter/${chapterId}`,
    { headers }
  );
  const data = await response.json();
  return { status: response.status, data };
}

/**
 * Call the getMuxToken backend function. Requires the user to be authenticated
 * with Base44 (the function uses createClientFromRequest + base44.auth.me).
 * For the WebView-driven flow, the auth cookie is already shared because we
 * proxy through https://base44.app domain.
 *
 * Returns: { token, drmToken, drmLicenseUrl, secureStreamUrl }
 *  - token            : Mux signed playback JWT
 *  - drmToken         : Widevine/FairPlay license token
 *  - drmLicenseUrl    : URL to acquire the license from
 *  - secureStreamUrl  : Pre-signed HLS manifest URL
 */
export async function getMuxToken(playbackId) {
  const response = await fetch(
    `${BASE_URL}/apps/${APP_ID}/functions/getMuxToken`,
    {
      method: 'POST',
      headers,
      credentials: 'include',
      body: JSON.stringify({ playbackId }),
    }
  );
  const data = await response.json();
  if (!response.ok) {
    throw new Error(data?.error || `getMuxToken failed (${response.status})`);
  }
  return data;
}

/**
 * Resolve student access for a course. Returns the access flags + expiry
 * (hasCourseAccess, courseAccessReason, courseAccessExpiresAt, isOnTrial).
 */
export async function resolveStudentAccess(courseId) {
  const response = await fetch(
    `${BASE_URL}/apps/${APP_ID}/functions/resolveStudentAccess`,
    {
      method: 'POST',
      headers,
      credentials: 'include',
      body: JSON.stringify({ courseId }),
    }
  );
  const data = await response.json();
  return { status: response.status, data };
}
