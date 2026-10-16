# iOS Offline + FairPlay — Handoff

**Branch:** `ios/offline-learning-v2` (based on `feature/offline-learning-manager-v2`)
**Stack:** Expo SDK 56 · React Native 0.85 · `react-native-video` 6.19 · Xcode 26.5
**iOS bundle id:** `life.icare.app`
**Android impact:** none. No `android/` or Kotlin files changed; Android module autolinking output is identical before/after.

This document hands the iOS offline-download work over for the **FairPlay (DRM)** phase.

---

## 1. State of play

| Capability | iOS status |
|---|---|
| App builds and runs on the v2 stack | Works (clean build, 0 errors) |
| "My Downloads" / "Add Downloads" screens (v2 UI) | Work on iOS (storage stats, bulk select, queueing) |
| Non-DRM HLS download (progress, persist across relaunch, remove, storage stats) | **Implemented**; verified end to end on the earlier SDK 54 prototype with the same download core. **Not yet re-verified end to end on v2** — see section 5 |
| Offline playback of a downloaded non-DRM lesson | Implemented (RN player plays the local `.movpkg`); verified on the SDK 54 prototype |
| Online playback | Stays in the WebView (the web app plays it), same as Android |
| **DRM (FairPlay) download** | **Implemented, type-checked only — NOT yet run on a device.** `AVContentKeySession` persistable key, stored in the Keychain; see section 3a |
| **DRM (FairPlay) offline playback** | **Not implemented** — protected offline copies show a clear message instead of playing |

### Why FairPlay is the critical path
The server's download endpoint (`getMuxDownloadToken`) returns `drmEnabled` and a Widevine license URL. For the ADL course ("Senior Care Essentials: Activities of Daily Living", a `drm`-mode course) every lesson came back as DRM for the download path, so **none of that course can be downloaded on iOS without FairPlay**. Catalog-wide (read-only counts, 2026-10-12): 862 published chapters, 245 DRM-protected, 2 of 23 courses in `drm` mode.

---

## 2. What was added (all iOS-only or iOS-gated)

| File | Change |
|---|---|
| `modules/icare-offline-drm/ios/IcareOfflineDrmModule.swift` | New. Three Expo modules: `IcareOfflineDrm` (downloads), `IcareDownloadManager` (device storage + per-download entitlement), `IcareLanguagePreferences` |
| `modules/icare-offline-drm/ios/IcareOfflineDrm.podspec` | New. iOS 16.4 (SDK 56's ExpoModulesCore minimum) |
| `modules/icare-offline-drm/expo-module.config.json`, `package.json` | `ios` added next to `android` (Android entries unchanged) |
| `modules/icare-offline-drm/index.ts` | Native modules used on iOS too; `launchOfflinePlayer` stays Android-only |
| `app/(tabs)/explore.tsx` | iOS keeps online playback in the WebView like Android |
| `app/player/[chapterId].tsx` | iOS plays the offline copy in the RN player (no native Activity); stream-URL fallback; no Widevine config for non-DRM |
| `utils/offlineDownload.ts` | iOS passes DRM fields only when `drmEnabled` |
| `app/(tabs)/download-manager.tsx` | `contentInsetAdjustmentBehavior="automatic"` so the title clears the notch |

### Download core (Swift)
`OfflineDownloadManager` uses `AVAssetDownloadURLSession` (background session id `life.icare.offline.downloads`) with `AVAssetDownloadConfiguration`.
- Progress from `didLoad timeRange…`; location from `willDownloadTo`/`didFinishDownloadingTo` (stored relative to `NSHomeDirectory()`).
- Records persisted in `UserDefaults` (`life.icare.offline.downloads.v1`).
- Audio/caption selection via `AVMediaSelection` when the stream offers the requested languages.
- Local notification on completion/failure when the app is not in the foreground.
- `start(...)` currently **throws** when `drmLicenseUrl` is non-empty — this is the FairPlay entry point.

---

## 3. FairPlay plan

### 3a. Status of the FairPlay code (added after the backend change in `c97ce62`)

Backend (Nikhil): `getMuxDownloadToken` now returns `fairplayLicenseUrl`, `fairplayCertificateUrl` and `licenseExpiresAt`, and accepts an optional `platform`.

Client, this branch:
- `utils/offlineDownload.ts` passes `platform: 'ios'` (iOS only) and forwards the three fields to `startDownload` **only when `drmEnabled`** is true (Android request/payload unchanged).
- `IcareOfflineDrmModule.swift`: `FairPlayDownloadKeyDelegate` + `FairPlayKeychain`. During the HLS download it requests a *persistable* key, fetches the certificate, builds the SPC, POSTs it to the licence URL (token added as `?token=` and `x-mux-license-token` if absent), stores the key in the Keychain. A protected download is marked `completed` only if its key was stored; otherwise `failed` with a reason.
- Protected offline copies report `drmType: "fairplay"`; the player shows "Offline playback of protected lessons is not available on iOS yet." until P3.

**Simulator behaviour (observed 2026-10-16):** in the Simulator the backend returned the FairPlay URLs and `startDownload` reached the native module, but `AVContentKeySession(keySystem: .fairPlayStreaming)` raised an uncatchable `NSInvalidArgumentException` (key system unsupported) and killed the app. The module now guards this with `#if targetEnvironment(simulator)` and reports "Protected lessons can only be downloaded on a physical iPhone, not in the Simulator." Real devices are unaffected.

**Unverified assumptions (check first on a real iPhone):**
1. Content identifier = host of the `skd://` key URI (Apple sample convention). Mux may expect something else.
2. Certificate GET and licence POST formats (raw SPC body, raw or base64 CKC, token as query vs header).
3. `AVContentKeyRequestProtocolVersionsKey: [1]`.
4. Whether the key request is raised at all during `AVAssetDownloadURLSession` with the recipient set on the same `AVURLAsset`.

### Prerequisites (non-code, long lead time — start first)
1. **Apple FairPlay Streaming (FPS) deployment package** for the Apple Developer account (request + approval can take days).
2. Provide the FPS files to **Mux** and enable FairPlay on the Mux environment. Confirm with Mux which FPS SDK version they require.
3. A **physical iPhone** and a signed build. FairPlay does not play in the iOS Simulator.

### Mux endpoints (per Mux docs — verify against current docs)
- Certificate: `https://license.mux.com/appcert/fairplay/{playback-id}?token={drm-license-token}`
- License: `https://license.mux.com/license/fairplay/{playback-id}?token={drm-license-token}`
- Offline needs the license JWT to carry `offline: true` and a `licenseExpiration`.
- Docs: <https://www.mux.com/docs/guides/protect-videos-with-drm>

### Open questions to answer first
1. For a DRM chapter, what does `getMuxDownloadToken` return? Is `drmToken` a platform-neutral Mux DRM JWT? If yes, the iOS client can build the FairPlay certificate/license URLs from `playbackId` + `drmToken` and **no backend change is needed**; otherwise add the FairPlay URLs to the response (additive; Android ignores them).
2. Does that JWT include `offline` / `licenseExpiration`, and for how long is an offline license valid? (Drives renewal UX.)
3. **Does the Base44 web player play FairPlay content inside `WKWebView`?** If yes, *online* DRM playback on iOS needs no native work (the app already stays in the WebView). Only offline needs native FairPlay. Verify on a real device first — this decides the size of the project.

### Work breakdown (rough, one developer, excluding Apple/Mux lead time)
| Phase | What | Estimate |
|---|---|---|
| P0 | Prerequisites + answers to the open questions | calendar time |
| P1 | Online FairPlay playback (only if the WebView cannot play it): `drm: { type: 'fairplay', certificateUrl, licenseServer, headers }` on iOS | 1–2 days + device testing |
| P2 | Offline FairPlay download: `AVContentKeySession` with a **persistable** key, stored securely (Keychain), alongside the existing download | 4–6 days |
| P3 | Offline FairPlay playback: supply the stored persistent key for the local asset (check what `react-native-video` 6.19 supports for offline FairPlay before writing a custom path) | 3–5 days |
| P4 | License renewal + expiry UX (mirror Android `renewOfflineLicense`, "license expired" state) | 2–3 days |
| P5 | Device QA matrix (online/offline × DRM/non-DRM × relaunch × expired license × airplane mode; iOS 16.4 → latest) | 2–3 days |

Where to hook in Swift: replace the `throw` in `OfflineDownloadManager.start(params:)` with a FairPlay branch; add key-session handling and key storage next to it; `renewOfflineLicense` is currently a no-op stub for API parity.

---

## 4. Running it

```bash
npm install
npx expo run:ios            # first build is a full build; later ones are incremental
```

- The app is a **separate install** from older SDK 54 builds (`life.icare.app`); log in once in the simulator.
- **Metro cache gotcha:** edits sometimes are not served to the app. If a JS change does not appear, restart with `npx expo start --dev-client --clear`.
- After changing the Swift module or podspec, run `npx expo run:ios` again (pod install + incremental build).
- The "Add Downloads" catalog load can take ~30–70 s on a cold start (sequential per-course/module fetches). That is v2 behaviour on both platforms.

### Type-checking Swift without a full build
After one successful build, `swiftc -typecheck` against `ios/Pods` headers and the built `ExpoModulesCore.swiftmodule` (in DerivedData) validates edits to the module quickly.

---

## 5. Not yet done / to verify

- **FairPlay download has never been executed** (simulator cannot run FairPlay; no device was available). Treat section 3a as a starting point, not a verified feature.
- **End-to-end non-DRM download on v2.** Needs a lesson from a **public-mode** course on the test account (the ADL course is DRM for downloads). Cycle to run: Add Downloads → progress → My Downloads → relaunch → play offline → remove. The same download core already passed this on the SDK 54 prototype.
- **Android regression check** before merging: the shared JS files changed (`index.ts`, `explore.tsx`, `[chapterId].tsx`, `offlineDownload.ts`); all changes are `Platform.OS`-gated or additive, but they have not been run on an Android device.
- Background-session relaunch handling (`handleEventsForBackgroundURLSession` in the app delegate) is not implemented; downloads resume when the app returns to the foreground.
- Language-selection (`audioLanguages`/`captionLanguages`) is implemented for iOS but not exercised against a multi-language stream yet.
- No pause/resume UI exists on Android's list either; the Swift module supports it.

---

## 6. Reference
- Earlier prototype branch (SDK 54, `main`-based): `fix/ios-course-player` — kept for history; superseded by this branch.
- Scoping notes and Mux research: the sections above (also in `docs/ios-fairplay-scope.md` on that branch).
