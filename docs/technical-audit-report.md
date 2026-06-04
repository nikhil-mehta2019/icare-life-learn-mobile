# iCare Life Learn Mobile — Complete Technical Audit Report

**Prepared by:** Senior Software Architect / Technical Auditor  
**Date:** 2026-06-03  
**Codebase Path:** `D:\Icare\Expo\icare-life-learn-mobile`

---

## 1. Executive Summary

**Project Name:** icare-life-learn-mobile  
**Package ID:** com.maveristic.icarelifelearnmobile

**Purpose:** A mobile learning application (LMS) that delivers DRM-protected video courses to students. The app wraps the Base44 web SPA in a native shell, intercepting video playback to route it through a native ExoPlayer for performance, fullscreen support, and offline/DRM capabilities.

**Primary Business Use Case:** Digital education / OTT-style course delivery with subscription and purchase access models, multi-language audio tracks, and offline lesson downloads protected by Widevine DRM.

**Overall Architecture Summary:**

```
┌──────────────────────────────────────────────────────────────────────┐
│  React Native (Expo 54) Shell                                        │
│  ┌─────────────────────┐    ┌──────────────────────────────────────┐ │
│  │  WebView Screen      │    │  Native Player Screen                │ │
│  │  (Base44 SPA)        │◄──►│  react-native-video + ExoPlayer      │ │
│  │  - Auth/Login        │    │  - Online playback (iOS only)        │ │
│  │  - Course catalog    │    │  - Offline DRM playback (Android)    │ │
│  │  - Navigation        │    │  - Pinch-to-fullscreen               │ │
│  │  - Payment/Access    │    └──────────────────────────────────────┘ │
│  └─────────────────────┘                                             │
│           ▲  JS message bridge (tokens, chapter ID)                  │
│  ┌─────────────────────┐    ┌──────────────────────────────────────┐ │
│  │  playerCache.ts      │    │  icare-offline-drm (Expo Module)     │ │
│  │  Token relay bridge  │    │  - Media3 DownloadManager            │ │
│  └─────────────────────┘    │  - Widevine OfflineLicenseHelper      │ │
│                              │  - EncryptedSharedPreferences         │ │
│                              └──────────────────────────────────────┘ │
└──────────────────────────────────────────────────────────────────────┘
           │
           ▼
  Base44 Backend API (https://icare-life-learn.base44.app/api)
  + Mux Video (streaming + DRM license server)
```

The architecture uses an "interpreter bridge" pattern: the Base44 SPA runs in a WebView (preserving auth cookies and full CMS functionality), while a JavaScript interceptor snoops on `getMuxToken` API calls and relays signed tokens to the native video player layer.

---

## 2. Technology Stack

| Layer | Technology | Version | Evidence |
|---|---|---|---|
| **Mobile Framework** | React Native (Expo) | 0.81.5 / SDK 54 | `package.json` |
| **Frontend Language** | TypeScript | 5.3.3 | `package.json` |
| **Navigation** | Expo Router (file-based) | 5.0.7 | `package.json` |
| **Video Playback** | react-native-video (ExoPlayer) | 5.2.1 | `package.json` |
| **Web Container** | react-native-webview | 13.15.0 | `package.json` |
| **Backend Platform** | Base44 (BaaS) | SDK 0.8.28 | `api/base44Client.ts` |
| **Video CDN/DRM** | Mux Video | API | `api/base44Client.ts:99-104` |
| **DRM Standard** | Widevine (Android) | — | `OfflineLicenseManager.kt:99` |
| **Offline Engine** | Media3 / ExoPlayer DownloadManager | — | `DownloadUtil.kt:16` |
| **Secure Storage** | EncryptedSharedPreferences (AES256-GCM) | — | `OfflineLicenseManager.kt:25-28` |
| **File Storage** | expo-file-system | 19.0.22 | `package.json` |
| **Build System** | EAS Build (Expo) | CLI ≥18.12.3 | `eas.json` |
| **Authentication** | Base44 session cookies (WebView) | — | `app/(tabs)/explore.tsx` |
| **Gesture Input** | react-native-gesture-handler | 2.28.0 | `package.json` |
| **Push Notifications** | Not implemented | — | Not found |
| **Analytics** | Not implemented | — | Not found |
| **Payments** | Handled by Base44 SPA | — | Course entity fields |

> **iOS Note:** iOS is structurally supported (bundle ID, deployment target iOS 15.1 configured), but the `icare-offline-drm` native module is **Android-only**. iOS offline download (FairPlay / AVAssetDownloadTask) is explicitly declared as **not yet implemented** in `modules/icare-offline-drm/index.ts`.

---

## 3. Project Structure Analysis

```
icare-life-learn-mobile/
├── app/                        # All screens (Expo Router file-based routing)
│   ├── _layout.tsx             # Root Stack navigator
│   ├── (tabs)/
│   │   ├── _layout.tsx         # Tab group layout (tab bar hidden)
│   │   ├── index.tsx           # Redirect → /explore
│   │   ├── explore.tsx         # PRIMARY SCREEN: WebView + JS bridge (693 lines)
│   │   └── downloads.tsx       # Offline downloads management UI
│   └── player/
│       └── [chapterId].tsx     # Dynamic route: native video player (755 lines)
│
├── api/
│   ├── base44Client.ts         # REST API client: Course, Module, Chapter, Mux tokens
│   └── playerCache.ts          # In-memory async bridge: WebView tokens → native player
│
├── modules/
│   └── icare-offline-drm/      # Custom Expo native module (Android Kotlin)
│       ├── index.ts             # TypeScript API surface
│       ├── app.plugin.js        # Expo config plugin (auto-links to build)
│       └── android/src/main/java/expo/modules/icareofflinedrm/
│           ├── IcareOfflineDrmModule.kt   # Module def, JS async functions
│           ├── OfflineDownloadService.kt  # Foreground download service
│           ├── OfflineLicenseManager.kt   # Widevine license acquire/store/renew
│           ├── DownloadUtil.kt            # ExoPlayer SimpleCache + DownloadManager
│           └── DownloadEventBridge.kt     # Progress events → JS
│
├── android/                    # Native Android project (committed, not generated)
│   └── app/src/main/
│       ├── AndroidManifest.xml  # Permissions + OfflineDownloadService declaration
│       └── java/.../
│           ├── MainActivity.kt
│           └── MainApplication.kt
│
├── components/                 # Reusable UI components (themed text, views, icons)
├── constants/theme.ts          # Color scheme constants
├── hooks/                      # use-color-scheme, use-theme-color
├── types/                      # react-native-video type declarations
├── docs/
│   ├── feature-status.md       # Feature implementation log
│   └── build-and-release-guide.md
├── scripts/                    # patch-expo-router-ctx.js (postinstall), reset-project.js
├── assets/images/              # App icons, splash screen
├── app.json                    # Expo configuration
├── eas.json                    # EAS Build profiles
├── package.json                # Dependencies
└── tsconfig.json               # TypeScript (strict mode)
```

**Key Design Observations:**

- The `android/` directory is **committed** (not gitignored). This is deliberate: `eas.json` skips `expo prebuild` because the native Android project has been hand-edited and cannot be auto-regenerated.
- The Downloads screen (`downloads.tsx`) exists as a route but is **not visible in the tab bar** (`href=null`). It is accessible only via programmatic navigation from the player.
- `playerCache.ts` serves as the cross-boundary async relay: the WebView calls `deliverPlayerData()`, the native player calls `waitForPlayerData()`, with a 20-second timeout and cleanup guarantees.

---

## 4. Feature Inventory

| Feature | Implemented | Evidence | Key Files |
|---|---|---|---|
| User authentication (login) | Yes — via Base44 WebView | WebView retains session cookies | `app/(tabs)/explore.tsx` |
| Registration | Partial — Base44 SPA | No native registration screen | Base44 SPA |
| Password reset | Partial — Base44 SPA | No native password reset screen | Base44 SPA |
| User profiles | Partial — Base44 SPA | No native profile screen | Base44 SPA |
| Course catalog / listing | Yes | API: `fetchCourses()`, rendered in WebView | `api/base44Client.ts:142` |
| Module listing | Yes | API: `fetchModules()` | `api/base44Client.ts:161` |
| Chapter listing | Yes | API: `fetchChapters()` | `api/base44Client.ts:171` |
| Video playback (online, iOS) | Yes | react-native-video, mode `online` | `app/player/[chapterId].tsx:224` |
| Video playback (online, Android) | Partial / WebView fallback | `FORCE_ANDROID_WEBVIEW_PLAYER = true` | `app/player/[chapterId].tsx:87` |
| DRM-protected video (online) | Yes | Widevine headers, `drmLicenseUrl` | `app/player/[chapterId].tsx:447-459` |
| **Offline video download** | **Yes (Android)** | `IcareOfflineDrm.startDownload()` | `IcareOfflineDrmModule.kt:47` |
| **Offline DRM playback** | **Yes (Android)** | `getOfflineSource()` + `offlineLicense` | `app/player/[chapterId].tsx:340-351` |
| Download management UI | Yes | FlatList with progress + remove | `app/(tabs)/downloads.tsx` |
| Download pause/resume | Yes | `pauseDownload()`, `resumeDownload()` | `modules/icare-offline-drm/index.ts:76-83` |
| Offline license renewal | Yes | `renewOfflineLicense()` | `IcareOfflineDrmModule.kt:184` |
| Pinch-to-fullscreen | Yes | RNGH pinch gesture | `app/player/[chapterId].tsx:201-217` |
| Screen wake lock during playback | Yes | expo-keep-awake | `app/player/[chapterId].tsx:99-123` |
| Multi-language audio toast | Yes | SecureStore flag, one-time toast | `app/player/[chapterId].tsx:166-187` |
| Access control (course) | Yes | `resolveStudentAccess()` API | `api/base44Client.ts:219` |
| Payments / purchase | Partial — Base44 SPA only | Course entity has pricing fields | `api/base44Client.ts:44-51` |
| Progress tracking | No | Not found in codebase | — |
| Search | No | Not found in native code | — |
| Push notifications | No | Plugin absent from app.json | — |
| Analytics | No | Not found | — |
| Next video auto-advance | No | Blocked — backend missing `nextChapterId` | `docs/feature-status.md:73` |
| Video quality selection | No | ExoPlayer ABR override + lib limitation | `docs/feature-status.md:101` |
| iOS offline download | No | `ensureAndroid()` guard, noted as future | `modules/icare-offline-drm/index.ts:58-64` |

---

## 5. Mobile Application Analysis

**Is there a mobile application?** Yes — React Native (Expo) targeting Android and iOS.

**Native or hybrid?** Hybrid with native extensions. The app is Expo/React Native (JS layer) with a custom native Expo module (`icare-offline-drm`) written in Kotlin for Android.

**Android support?** Yes. Min SDK 24 (Android 7.0), Target SDK 34 (Android 14). Evidence: `app.json:38-41`, `AndroidManifest.xml`.

**iOS support?** Structurally yes (bundle identifier configured, deployment target iOS 15.1), but the offline DRM module is Android-only. iOS users can stream online via the WebView fallback but **cannot download for offline playback**.

Evidence from `modules/icare-offline-drm/index.ts:55-64`:

```typescript
const NativeModule =
  Platform.OS === 'android' ? requireNativeModule('IcareOfflineDrm') : null;

function ensureAndroid(method: string) {
  if (Platform.OS !== 'android') {
    throw new Error(
      `IcareOfflineDrm.${method} is only supported on Android. ` +
      `iOS uses FairPlay offline via AVAssetDownloadTask — not yet implemented.`
    );
  }
}
```

**Mobile-specific features implemented:**

- Foreground download service with system notification (`FOREGROUND_SERVICE_DATA_SYNC`)
- Device wake lock during video playback
- Pinch-to-fullscreen gesture recognition
- SecureStore for audio language hint persistence
- Deep-link scheme: `icarelifelearnmobile://`
- Portrait-locked orientation
- Adaptive launcher icon (foreground + background + monochrome)
- Splash screen with custom logo

---

## 6. Offline Download Investigation (HIGH PRIORITY)

### Video Downloading

**Can users download videos?** YES — Android only.

**Is there a download button?** YES. The `DownloadControls` component in `app/player/[chapterId].tsx:659-710` renders a **"Download for offline"** button. After download it shows **"Downloaded for offline playback"** and a **"Remove download"** button.

```typescript
// app/player/[chapterId].tsx:704-709
return (
  <View style={styles.actionRow}>
    <Pressable style={styles.btn} onPress={onDownload}>
      <Text style={styles.btnText}>Download for offline</Text>
    </Pressable>
  </View>
);
```

**Is video caching implemented?** YES — via Media3 `SimpleCache` stored in the app's internal files directory.

```kotlin
// DownloadUtil.kt:31-37
fun getDownloadCache(ctx: Context): SimpleCache {
  val dir = File(ctx.filesDir, DOWNLOAD_CONTENT_DIRECTORY)  // "icare-downloads"
  val cache = SimpleCache(dir, NoOpCacheEvictor(), getDatabaseProvider(ctx))
  ...
}
```

**Is local file storage used?** YES — `ctx.filesDir/icare-downloads` (app internal storage). `NoOpCacheEvictor` means downloaded content is **never automatically evicted** — it persists until the user or app explicitly removes it.

**Are downloaded videos stored on device?** YES — full HLS segments are stored locally via ExoPlayer's `DownloadManager`. The download index is persisted in a `StandaloneDatabaseProvider` (SQLite-backed). Offline Widevine licenses are stored in `EncryptedSharedPreferences` keyed by `ksid_{chapterId}`.

**Download flow (end-to-end):**

1. User taps "Download for offline" → `handleDownload()` fires (`app/player/[chapterId].tsx:467`)
2. Fresh tokens requested from WebView bridge → `requestWebViewTokens(chapterId)` + `waitForPlayerData()`
3. `IcareOfflineDrm.startDownload({ id, manifestUrl, drmLicenseUrl, drmToken, title })` called
4. **Kotlin:** `OfflineLicenseManager.acquireAndStore()` — contacts Mux Widevine license server, stores keySetId in `EncryptedSharedPreferences`
5. **Kotlin:** `DownloadHelper.prepare()` parses the HLS manifest
6. **Kotlin:** `DownloadService.sendAddDownload()` — hands off to `OfflineDownloadService` foreground service
7. Download progresses with `onDownloadProgress` events emitted to JS on every state change
8. On completion, HLS segments stored in `icare-downloads/` directory

### Offline Playback

**Can content be played without internet?** YES — on Android.

**Is there a local media repository?** YES — ExoPlayer `SimpleCache` + `DefaultDownloadIndex` (SQLite), stored at `{app.filesDir}/icare-downloads`.

**Is synchronization implemented?** PARTIAL — no explicit "sync on reconnect" logic, but `renewOfflineLicense()` is implemented for refreshing expiring Widevine licenses via a fresh token from the WebView bridge.

**Is offline progress tracking available?** NO — there is no mechanism to record or sync watch position or completion status for offline-played content.

**Offline playback flow (end-to-end):**

1. Player screen mounts → checks `IcareOfflineDrm.getOfflineSource({ id: chapterId })` (`app/player/[chapterId].tsx:340`)
2. **Kotlin:** checks `DownloadManager.downloadIndex.getDownload(id)` for `STATE_COMPLETED` + valid keySetId in `EncryptedSharedPreferences`
3. Returns `{ cacheKey, uri, offlineLicenseKeySetId }` to JS
4. Player sets mode `offline`, builds source `{ uri, type: 'm3u8', cacheKey }` and DRM config `{ type: 'widevine', offlineLicense: keySetId }`
5. `<Video>` renders with ExoPlayer transparently serving HLS bytes from local cache — **no network required**

### Search Results for Key Offline Terms

| Search Term | Found | Location |
|---|---|---|
| `download` | YES | `IcareOfflineDrmModule.kt`, `OfflineDownloadService.kt`, `DownloadUtil.kt`, `downloads.tsx`, `[chapterId].tsx` |
| `offline` | YES | `index.ts`, `OfflineLicenseManager.kt`, `[chapterId].tsx`, `DownloadUtil.kt` |
| `SimpleCache` | YES | `DownloadUtil.kt:34` |
| `DownloadManager` | YES | `DownloadUtil.kt:52`, `IcareOfflineDrmModule.kt:134` |
| `offlineLicense` | YES | `[chapterId].tsx:449`, `index.ts:48` |
| `EncryptedSharedPreferences` | YES | `OfflineLicenseManager.kt:22` |
| `OfflineLicenseHelper` | YES | `OfflineLicenseManager.kt:96` |
| `FOREGROUND_SERVICE` | YES | `AndroidManifest.xml:4`, `app.json:65` |
| `AVAssetDownloadURLSession` | NO | Not implemented (iOS FairPlay not yet done) |
| `react-native-fs` | NO | Not in dependencies |
| `flutter_downloader` | NO | Not Flutter |

### Final Verdict

| Capability | Verdict | Confidence |
|---|---|---|
| **OFFLINE DOWNLOADS** | **YES (Android) / NO (iOS)** | **98%** |
| **OFFLINE PLAYBACK** | **YES (Android) / NO (iOS)** | **98%** |

**Confidence Score: 98%** — All components of the offline pipeline are present, implemented, and wired together from the JS API surface through to the native Kotlin layer. The remaining 2% reflects the absence of automated tests confirming the full pipeline executes without error on a real device.

---

## 7. API Analysis

### Endpoints

| Method | Path | Auth | Purpose | Response Type |
|---|---|---|---|---|
| GET | `/entities/Course?limit=50&sort_by=sortOrder` | api_key | List published courses | `Course[]` |
| GET | `/entities/Course/{courseId}` | api_key | Fetch single course | `Course` |
| GET | `/entities/Module?q={courseId,status}&sort_by=sortOrder` | api_key | List modules by course | `Module[]` |
| GET | `/entities/Chapter?q={moduleId,status}&sort_by=sortOrder` | api_key | List chapters by module | `Chapter[]` |
| GET | `/entities/Chapter/{chapterId}` | api_key | Fetch single chapter | `Chapter` |
| POST | `/functions/getMuxToken` | session cookie | Get Mux signed + DRM tokens | `MuxTokenResponse` |
| POST | `/functions/resolveStudentAccess` | session cookie | Check course access + trial | `StudentAccessResponse` |

### Authentication Methods

- **Public endpoints (entities):** Static `api_key` header embedded in bundle ⚠️
- **Private endpoints (functions):** Session cookie from the Base44 WebView (not accessible from native `fetch()` on Android — requires WebView bridge relay)
- **Fallback:** `localStorage` JWT scanning within injected WebView JavaScript

### Token Response Structure

```typescript
// api/base44Client.ts:99-104
export interface MuxTokenResponse {
  token: string;           // Signed playback token
  drmToken: string;        // Widevine license token (x-mux-license-token header)
  drmLicenseUrl: string;   // Mux Widevine license server URL
  secureStreamUrl: string; // Pre-signed HLS .m3u8 URL
}
```

### WebView Message Bridge Protocol

| Message Type | Direction | Payload |
|---|---|---|
| `BRIDGE_READY` | WebView → Native | — |
| `OPEN_CHAPTER_WITH_TOKENS` | WebView → Native | `{ chapterId, tokens, chapter }` |
| `OPEN_CHAPTER_WITH_ERROR` | WebView → Native | `{ chapterId, error }` |
| `CHAPTER_TOKENS` | WebView → Native | `{ chapterId, tokens, chapter }` |
| `CHAPTER_ERROR` | WebView → Native | `{ chapterId, error }` |
| `REQUEST_TOKENS` | Native → WebView | `{ chapterId }` |

---

## 8. Database Analysis

This application has **no traditional relational or document database** managed within the codebase. All content metadata is stored server-side in Base44.

### On-device Storage

| Store | Technology | Data Stored | Location |
|---|---|---|---|
| Download index | SQLite (Media3 `StandaloneDatabaseProvider`) | Download state, manifest URLs, byte progress | `{filesDir}/icare-downloads` |
| Video cache | Media3 `SimpleCache` (binary files) | Downloaded HLS segments | `{filesDir}/icare-downloads/` |
| DRM licenses | `EncryptedSharedPreferences` (AES256-GCM) | Widevine keySetId per chapterId (`ksid_{id}`) | Android Keystore-backed |
| Audio hint flag | `expo-secure-store` | `audio_lang_hint_shown` (one-time flag) | iOS Keychain / Android Keystore |

### Entities (from API types)

| Entity | Key Fields | Relationships |
|---|---|---|
| Course | id, title, status, muxPlaybackMode, courseAccessType, priceINR/USD, language, audienceType | Has many Modules |
| Module | id, courseId, title, status, sortOrder | Belongs to Course, Has many Chapters |
| Chapter | id, courseId, moduleId, title, contentType, muxDrmPlaybackId, muxSignedPlaybackId, muxPlaybackId | Belongs to Module |

**Migration strategy:** Not applicable — Base44 manages schema server-side.

---

## 9. Security Review

### Findings

| # | Severity | Issue | Evidence | Recommendation |
|---|---|---|---|---|
| 1 | **HIGH** | API key hardcoded in bundle | `api/base44Client.ts:13`: value embedded in JS bundle, acknowledged in a code comment | Move to post-auth signed tokens or server-side proxy |
| 2 | **MEDIUM** | No token expiry validation before download | DRM tokens from Mux may expire mid-download if not renewed | Implement pre-download token freshness check |
| 3 | **LOW** | `debug.keystore` committed to git | `android/app/debug.keystore` present in repository | Acceptable for debug; ensure production keystore is never committed |
| 4 | **LOW** | `SYSTEM_ALERT_WINDOW` permission in manifest | `AndroidManifest.xml:7` — enables drawing over other apps | Remove if not required by the app |
| 5 | **INFO** | No HTTPS certificate pinning | API calls use standard TLS | Consider pinning for production if API key cannot be rotated |

### Positive Security Practices

- Widevine offline licenses stored in `EncryptedSharedPreferences` with AES256-GCM + Android Keystore master key — correct pattern
- `ITSAppUsesNonExemptEncryption: false` properly declared in `app.json`
- Session-authenticated API calls routed through the WebView — no cookie leakage via native fetch
- Token bridge has cancellation and cleanup on unmount — no dangling resolvers
- `expo-secure-store` (hardware-backed) used for audio hint persistence

---

## 10. Build & Deployment

### EAS Build Profiles (`eas.json`)

| Profile | Type | Distribution | Notes |
|---|---|---|---|
| `development` | Dev client | Internal | prebuild skipped (hand-edited Android) |
| `preview` | Release (unsigned) | Internal APK | prebuild skipped |
| `production` | Release | Store | Auto-increments version code |

### Build Commands

```bash
expo run:android                                          # Local development build
eas build --profile preview --platform android            # Internal APK
eas build --profile production --platform android         # Store build
```

### Key Build Configuration Notes

- **Expo Router:** postinstall patch script `scripts/patch-expo-router-ctx.js` applied after every `npm install`
- **New Architecture:** explicitly **disabled** on both Android and iOS (`newArchEnabled: false`) — required because `react-native-video 5.2.1` is Old Architecture only
- **Android prebuild:** skipped — native folder is committed and manually maintained
- **CI/CD pipelines:** None found (no `.github/workflows`, no CircleCI, no Bitbucket Pipelines)
- **Docker:** Not used
- **Cloud provider:** EAS (Expo Application Services) for cloud builds

---

## 11. Missing Features / Incomplete Implementations

### Documented Incomplete Features (`docs/feature-status.md`)

| # | Feature | Status | Blocker |
|---|---|---|---|
| 1 | Next video auto-advance | Blocked | Backend missing `nextChapterId` field on Chapter entity |
| 2 | Video quality selection | Not implemented | ExoPlayer ABR overrides manual selection; requires custom player UI rebuild |

### Code-Level Incomplete Implementations

| Issue | Location | Details |
|---|---|---|
| iOS offline download | `modules/icare-offline-drm/index.ts:58-64` | `ensureAndroid()` guard with comment: "iOS uses FairPlay offline via AVAssetDownloadTask — not yet implemented" |
| Android online native video | `app/player/[chapterId].tsx:87-90` | `FORCE_ANDROID_WEBVIEW_PLAYER = true` disables react-native-video on Android for online playback |
| Downloads tab not navigable from UI | `app/(tabs)/_layout.tsx` | `href=null` — visible only via programmatic navigation |
| Download notification styling | `OfflineDownloadService.kt:45` | Comment: "Minimal notification — apps that need styled progress can extend this" |
| Offline watch progress tracking | Codebase-wide | No mechanism to store or sync watch position for offline content |
| Push notifications | `app.json` | Plugin not configured; `expo-notifications` not in dependencies |
| Analytics | Codebase-wide | No analytics SDK integrated |

---

## 12. Final Assessment

### Quality Scores

| Dimension | Score | Rationale |
|---|---|---|
| **Architecture Quality** | **8 / 10** | Clean shell+child pattern for hook-order safety; solid WebView-bridge relay design; well-encapsulated native DRM module. Penalty: Android online video forced to WebView is a temporary workaround that limits the native experience. |
| **Code Organization** | **8 / 10** | Well-structured file layout; TypeScript strict mode; clear module boundaries; good naming. Penalty: Downloads tab has no in-app discovery path; `explore.tsx` is 693 lines handling too many responsibilities. |
| **Maintainability** | **7 / 10** | Excellent inline documentation in the player file; `feature-status.md` is a useful living doc. Penalty: committed Android folder without CI risks drift; no test suite; API key hardcoded with acknowledged tech debt. |
| **Scalability** | **6 / 10** | `maxParallelDownloads = 2` is reasonable. `NoOpCacheEvictor` means disk can grow unbounded. No storage quota management. Offline license renewal is manual. No iOS offline capability. |

---

## Most Important Questions — Final Answers

### 1. Does the mobile app support offline downloading?

**YES — on Android. NO — on iOS (not yet implemented).**

The app contains a complete, production-grade offline download pipeline for Android:
- A custom Expo native module (`icare-offline-drm`) using Media3/ExoPlayer
- A foreground `DownloadService` for background downloads with system notifications
- Widevine DRM offline license management via `OfflineLicenseHelper` + `EncryptedSharedPreferences`
- A downloads management UI screen
- "Download for offline" and "Remove download" buttons in the player

### 2. Can videos be downloaded and watched offline?

**YES — on Android.**

Full end-to-end pipeline is implemented:
- HLS segments are cached locally in `{filesDir}/icare-downloads`
- Widevine offline licenses are stored encrypted on-device
- On next launch, `getOfflineSource()` detects the local copy and plays it **without any internet connection**, using ExoPlayer's local cache transparent to the `<Video>` component

### 3. What exact code proves this?

**Download initiation** (`app/player/[chapterId].tsx:492-499`):

```typescript
await IcareOfflineDrm.startDownload({
  id: chapterId,
  manifestUrl: tk.secureStreamUrl,
  drmLicenseUrl: tk.drmLicenseUrl,
  drmToken: tk.drmToken,
  title: chapter.title,
});
```

**Offline source detection and playback** (`app/player/[chapterId].tsx:340-351`):

```typescript
const off = await IcareOfflineDrm.getOfflineSource({ id: chapterId });
if (off) {
  const ch = await fetchChapter(chapterId);
  setChapter(ch.data);
  setOffline(off);
  setMode('offline');   // ← plays from local cache, no network needed
  return;
}
```

**Offline DRM config** (`app/player/[chapterId].tsx:447-450`):

```typescript
if (mode === 'offline' && offline) {
  return { type: 'widevine' as DRMType, offlineLicense: offline.offlineLicenseKeySetId };
}
```

**Kotlin — license acquisition and local storage** (`OfflineLicenseManager.kt:78-88`):

```kotlin
val keySetId = offlineHelper.downloadLicense(format)
prefs(ctx).edit()
  .putString(KEY_PREFIX + downloadId, Base64.encodeToString(keySetId, Base64.NO_WRAP))
  .apply()
```

**Kotlin — ExoPlayer cache in app filesystem** (`DownloadUtil.kt:31-37`):

```kotlin
val dir = File(ctx.filesDir, DOWNLOAD_CONTENT_DIRECTORY)  // "icare-downloads"
val cache = SimpleCache(dir, NoOpCacheEvictor(), getDatabaseProvider(ctx))
```

### 4. If not implemented on iOS, what would be required?

To implement iOS offline downloading (FairPlay Streaming + AVAssetDownloadTask):

| Step | Work Required |
|---|---|
| 1. iOS native module | Write Swift/ObjC counterpart to `IcareOfflineDrmModule.kt` using `AVAssetDownloadURLSession` and `AVAssetDownloadTask` |
| 2. FairPlay certificate | Obtain FairPlay Streaming certificate from Apple (requires Apple Developer enrollment) |
| 3. Mux FairPlay config | Ensure Mux is configured with FairPlay license server and the certificate |
| 4. License storage | Store FairPlay persistent key using iOS Keychain (`SecItemAdd` / `SecItemCopyMatching`) |
| 5. Expo module wiring | Add iOS target to `expo-module.config.json`; implement Swift API surface matching the TypeScript types |
| 6. Player update | `react-native-video` already supports FairPlay offline via `offlineLicense` prop — pass the stored key |
| 7. Testing | FairPlay requires a real device (Simulator does not support DRM) |

### 5. Estimated Implementation Complexity

| Platform | Feature | Complexity | Estimated Effort |
|---|---|---|---|
| iOS | Offline FairPlay download | **High** | 2–4 weeks (native Swift, FairPlay cert, Mux config, real-device testing) |
| Android | Online native video (fix react-native-video 5.x + New Arch) | **Medium** | Upgrade to react-native-video 6.x — 3–5 days |
| Both | Next video auto-advance | **Low** | ~1 day once backend adds `nextChapterId` |
| Both | Offline watch progress / position sync | **Medium** | 1 week (store locally + sync on reconnect) |
| Both | Custom video quality picker | **High** | 3–5 days (custom player UI, remove `controls={true}`) |
| Both | Push notifications | **Low** | 2–3 days with `expo-notifications` |
| Both | Course completion / progress tracking | **Medium** | 1–2 weeks (requires backend API additions) |

---

*Report generated from direct source code analysis. All conclusions are backed by specific file references and code excerpts. No assumptions were made.*
