# Milestone 3 — Mux DRM Offline Playback

This milestone adds offline-capable, Widevine-protected video playback for
chapter videos served via Mux. The flow is:

1. The Explore tab embeds the existing Base44 web app in a `WebView`.
2. When the web app navigates to a chapter URL (or calls
   `window.icareNative.openChapter(id)` via the injected JS bridge), the
   native app intercepts and pushes `/player/[chapterId]` instead.
3. The player screen calls Base44 `getMuxToken` to obtain a signed playback
   URL + Widevine license token, and plays the video with
   `react-native-video`.
4. The user can tap **Download for offline**, which:
   - Acquires + persists a Widevine offline license (`OfflineLicenseHelper`),
     storing the `keySetId` in `EncryptedSharedPreferences`.
   - Enqueues an HLS download via ExoPlayer’s `DownloadService`
     (foreground service, Android 14 compliant).
5. On next playback, the player checks for a stored offline source first
   and plays from local cache with the persisted license — no network
   license request is made.
6. The Downloads tab lists all downloads with live progress and a Remove
   action.

---

## What was added

### JavaScript / TypeScript

| Path | Purpose |
| --- | --- |
| `app/(tabs)/_layout.tsx` | Registers the new **Downloads** tab. |
| `app/(tabs)/explore.tsx` | WebView host with chapter-URL interception + JS bridge. |
| `app/(tabs)/downloads.tsx` | Downloads list with live progress. |
| `app/player/[chapterId].tsx` | Native chapter player (online + offline). |
| `api/base44Client.js` | Adds `fetchChapter`, `getMuxToken`, `resolveStudentAccess`. |
| `modules/icare-offline-drm/index.ts` | TS surface for the native module + event emitter. |

### Native (Android, Kotlin)

| Path | Purpose |
| --- | --- |
| `modules/icare-offline-drm/android/build.gradle` | androidx.media3 1.4.1, security-crypto. |
| `…/IcareOfflineDrmModule.kt` | Expo module: `startDownload`, `removeDownload`, `getOfflineSource`, etc. |
| `…/OfflineDownloadService.kt` | Foreground `DownloadService` for HLS downloads. |
| `…/DownloadUtil.kt` | Singletons for `SimpleCache`, `DownloadManager`, `StandaloneDatabaseProvider`. |
| `…/OfflineLicenseManager.kt` | Acquires + persists Widevine offline license (`keySetId`). |
| `…/DownloadEventBridge.kt` | Static glue for download events → JS event emitter. |

### Config

| Path | Change |
| --- | --- |
| `package.json` | Added `react-native-video`, `expo-build-properties`, `expo-secure-store`, `expo-file-system`. |
| `app.json` | `expo-build-properties` (minSdk 24, compileSdk 35), `react-native-video` plugin (Exoplayer HLS/DASH), custom `./modules/icare-offline-drm/app.plugin.js`, foreground-service permissions. |
| `modules/icare-offline-drm/app.plugin.js` | Registers `OfflineDownloadService` in `AndroidManifest.xml` with `foregroundServiceType="dataSync"`. |

---

## Build steps

These commands assume you’re in the project root:
`D:\Icare\Expo\icare-life-learn-mobile`.

```bash
# 1. Align dep versions for Expo SDK 54.
npx expo install --fix

# 2. Regenerate the native android/ project so the new plugins
#    (expo-build-properties, react-native-video, icare-offline-drm)
#    are applied to AndroidManifest.xml and gradle files.
npx expo prebuild --clean

# 3. EAS development build (Android).
eas build --profile development --platform android
```

> The custom native module lives under `modules/icare-offline-drm/`. Expo
> auto-links local modules at prebuild time — you do not need to edit
> `settings.gradle` or `MainApplication.kt` by hand.

After install, launch the dev client and connect it to the Metro bundler
the same way as for Milestones 1 and 2.

---

## Backend / environment

`getMuxToken` proxies to the play-API; ensure these are set on the Base44
side (Functions → Environment):

- `ICARE_PLAY_API_BASE` — base URL of the Mux signing service.
- `ICARE_PLAY_API_KEY` — server-side API key (sent as `X-API-Key`).

The mobile app never sees these — it only calls
`POST {BASE44}/functions/getMuxToken` with `{ playbackId }`.

---

## URL pattern interception

Edit `app/(tabs)/explore.tsx` → `CHAPTER_PATH_PATTERNS` to match the
**actual** chapter URL scheme used by your Base44 web app. The current
patterns cover several common shapes:

```
/chapter/<id>
/student/chapter/<id>
/chapter-player?id=<id>
/ChapterPlayer?id=<id>
```

If the IDs aren’t hex (Base44 sometimes uses ULID-style), relax the
character class in the regex. You can also drive handoff explicitly from
the web app:

```js
window.icareNative && window.icareNative.openChapter(chapterId);
```

---

## Manual test plan (device)

1. **Online streaming.** Cold-start the app on a real Android device
   (Widevine doesn’t work on Android emulators), open Explore, sign into
   Base44, navigate to a Mux-protected chapter. The native player should
   open and stream successfully (badge = “Streaming”).
2. **Download.** Tap **Download for offline**. A foreground notification
   should appear (“Icare downloads”). Progress should update live in
   both the player screen and the Downloads tab.
3. **Offline playback.** Once state is `completed`, kill the app, switch
   the device to airplane mode, reopen the app → Downloads → tap the
   chapter. It should play from local cache (badge = “Offline”) without
   any network license request.
4. **Renewal.** After 24h or after revoking the license server-side,
   `IcareOfflineDrm.renewOfflineLicense({ id })` should reissue the
   license without re-downloading the segments.
5. **Removal.** Tap **Remove download** in the player or Downloads tab.
   The file should be deleted, the persisted `keySetId` released, and
   the Downloads tab should show an empty state.

---

## Known limitations

- **Android only.** iOS offline DRM uses FairPlay + persistent content
  keys (different SDK surface). When iOS is in scope, mirror the
  module under `modules/icare-offline-drm/ios/` using
  `AVAssetDownloadURLSession` + `AVContentKeySession`.
- **No background pause/resume UX.** The native APIs support it; the JS
  surface exposes `pauseDownload` / `resumeDownload`, but the Downloads
  tab UI currently only exposes Remove.
- **Single-quality download.** `DownloadHelper` selects the first
  renditions exposed by the manifest. If you want to let users pick
  720p vs 1080p, expose `DownloadHelper.getMappedTrackInfo` selection
  in `IcareOfflineDrmModule.kt`.
