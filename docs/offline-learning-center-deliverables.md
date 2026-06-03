# Offline Learning Center — Deliverables

**Branch:** `feature/offline-learning-center`  
**Date:** 2026-06-03  
**Scope:** Steps 2–10 of the Offline Learning Center implementation spec.

---

## 1. Branch

```
feature/offline-learning-center
```

Created from `main`. All changes are on this branch. Do not merge directly — go through PR review.

---

## 2. Files Modified

| File | Change |
|------|--------|
| `app/(tabs)/_layout.tsx` | Exposed `downloads` tab (removed `href: null`) so it is navigable via `router.push` |
| `app/(tabs)/downloads.tsx` | Full replacement — Download Center screen (see Step 3) |
| `app/player/[chapterId].tsx` | Offline banner, resume position, network detection, improved controls |
| `modules/icare-offline-drm/index.ts` | Added `title`, `downloadedAt` to `DownloadInfo`; added `StorageStats` type; added `getStorageStats()` |
| `modules/icare-offline-drm/android/.../IcareOfflineDrmModule.kt` | `toMap()` now returns `title` + `downloadedAt`; new `getStorageStats` async function; calls `DownloadMetadata` on start/remove |
| `modules/icare-offline-drm/android/.../DownloadUtil.kt` | Creates `.nomedia` file in download cache dir on first access |

---

## 3. New Files Created

| File | Purpose |
|------|---------|
| `store/offlineProgress.ts` | JSON-file progress store (last position, % watched, sync flag) |
| `hooks/useNetworkStatus.ts` | Ping-based network detection hook (zero new deps) |
| `modules/icare-offline-drm/android/.../DownloadMetadata.kt` | Lightweight SharedPreferences store for title + completion timestamp |
| `docs/offline-learning-center-deliverables.md` | This file |

---

## 4. Database / Storage Changes

### Android (new)
- **`DownloadMetadata.kt`** writes to `icare_download_meta` SharedPreferences (plain, not encrypted — stores only title strings and ISO timestamps, not key material).
- **`.nomedia`** file created inside `ctx.filesDir/icare-downloads` — prevents media scanner from indexing the directory.

### JavaScript (new)
- **`store/offlineProgress.ts`** writes to `<documentDirectory>/icare_progress.json`.
  - Schema: `Record<chapterId, { watchedSeconds, durationSeconds, percentWatched, lastWatchedAt, synced }>`
  - `synced: false` records accumulate for future backend upload.
  - Cleared when a download is removed via `clearProgress(chapterId)`.

### Unchanged
- ExoPlayer `SimpleCache` in `ctx.filesDir/icare-downloads` — no change.
- `icare_offline_drm` EncryptedSharedPreferences — no change.
- ExoPlayer download index SQLite DB — no change.

---

## 5. Security Review — Content Protection

### Storage location
All content is written to **`ctx.filesDir/icare-downloads`** which is:
- App-private (mode 0700 by Android)
- Invisible to Gallery, Photos, File Manager on Android 10+
- Not scanned by MediaStore (confirmed: no `ACTION_MEDIA_SCANNER_SCAN_FILE` anywhere in codebase)
- On older devices: now additionally protected by a `.nomedia` file (added in this PR)

### File format
ExoPlayer `SimpleCache` writes encrypted HLS segment data in `.exo` container format. These files:
- Cannot be opened by VLC, MX Player, or any other video player
- Cannot be assembled into a playable MP4 without the Widevine keySetId AND the Android Keystore hardware key
- Are not raw MP4/TS/MP4A fragments

### DRM key material
- Widevine `keySetId` stored in `EncryptedSharedPreferences` (AES256-GCM, master key backed by Android Keystore hardware security module)
- The raw Widevine content key never leaves the TEE (Trusted Execution Environment)
- Without the `keySetId` AND the device's hardware key, the downloaded content cannot be decrypted on any other device

### Share intents
- No `FileProvider` is declared in `AndroidManifest.xml` → no content URIs can be constructed for these files → files cannot be shared via Android share sheet

### Export paths
- No `MediaStore.Downloads` inserts
- No `ACTION_MEDIA_SCANNER_SCAN_FILE` broadcasts  
- No external storage writes
- No `Environment.getExternalStorageDirectory()` usage

### Verdict: **No security gaps found.**
The implementation correctly confines all downloaded content to app-private encrypted storage. The new `.nomedia` file closes the theoretical gap on pre-Android-10 devices.

---

## 6. Screen Descriptions

### Download Center (`app/(tabs)/downloads.tsx`)

**Storage Summary header (dark card)**
```
Downloads Storage
12.4 GB Used    32 GB Available    32 Videos
```
Low storage warning appears when < 2 GB free:
```
⚠ Less than 2 GB storage remaining. Delete unused downloads to free space.
```

**Filter chips**
```
[All (32)]  [Downloading (2)]  [Downloaded (28)]  [Failed (2)]
```

**Download card (per item)**
```
Chapter Title Here (up to 2 lines)
● Downloading 67%
[===========================       ]   ← progress bar
234 MB / 350 MB  •  12 May 2026 (if completed)
[License Active]  Expires 11 Jun     ← license badge + expiry
Last watched: 4:23 (78%)             ← if progress exists
[▶ Play Offline]  [Delete]
```

License states: `License Active` (green) / `Expiring Soon` (amber) / `License Expired` (red)

**Actions per card**
| State | Buttons shown |
|-------|--------------|
| downloading | Pause · Delete |
| queued/stopped | Resume · Delete |
| completed (active license) | Play Offline · Delete |
| completed (expiring license) | Play Offline · Renew License · Delete |
| completed (expired license) | Renew License · Delete |
| failed | Retry · Delete |

---

### Player screen changes

**Offline mode banner** (below video, above title)
```
📥  Playing downloaded content
```

**Download controls**

Before download:
```
[⬇  Download for Offline Viewing]
```

While downloading:
```
Downloading 67%
[Go To Downloads]
```

After download:
```
Downloaded ✓
[Go To Downloads]  [Remove Download]
```

**No-internet screen** (when offline and no download)
```
📡
Internet connection required
This lesson hasn't been downloaded for offline use.
Connect to the internet to watch this lesson.
[Go back]  [View Downloads]
```

---

## 7. Testing Checklist

### Content Protection
- [ ] Download a chapter. Open file manager. Verify `icare-downloads` folder is not visible.
- [ ] On Android ≤ 9: verify `.nomedia` file exists in `files/icare-downloads/`.
- [ ] Attempt to open downloaded `.exo` files with VLC — confirm "format not supported".
- [ ] Verify Gallery app shows no downloaded video files.
- [ ] Attempt Android share from a file manager pointed at `files/icare-downloads/` — confirm no share sheet appears.
- [ ] Uninstall app. Reinstall. Verify downloads are gone (app-private storage wiped on uninstall).

### Download Center
- [ ] Storage summary reflects correct used bytes and device free space.
- [ ] Low-storage warning appears when < 2 GB available.
- [ ] Filter chips correctly count and filter items.
- [ ] Downloading card shows live progress bar updating in real time.
- [ ] Pause button stops download (state transitions to `stopped`).
- [ ] Resume button restarts download (state transitions to `downloading`).
- [ ] Delete shows confirmation alert before removing.
- [ ] After delete, card disappears from list and used bytes decrease.
- [ ] `Downloaded ✓` card shows correct file size, download date, license expiry.
- [ ] `Play Offline` navigates to player and plays without internet.
- [ ] `License Expired` badge appears ~30 days after download (test by moving system clock).
- [ ] `Renew License` opens alert → tap Open Chapter → player opens.

### Player UX
- [ ] Opening a downloaded chapter shows "Offline" badge and "Playing downloaded content" banner.
- [ ] Opening a non-downloaded chapter with no internet shows the no-internet screen.
- [ ] Watch 30 seconds, close app, reopen chapter — video seeks to ~30s on load.
- [ ] `Download for Offline Viewing` button starts download, transitions to `Downloading X%`.
- [ ] `Downloaded ✓` state shows after completion.
- [ ] `Go To Downloads` navigates to Download Center.
- [ ] `Remove Download` removes the offline copy and resumes online streaming.

### Network Detection
- [ ] Enable airplane mode before opening a non-downloaded chapter — no-internet screen appears.
- [ ] Enable airplane mode after download completes — chapter plays offline correctly.
- [ ] Re-enable network while on no-internet screen — (next open of chapter) resumes online.

### Progress Tracking
- [ ] Watch 2+ minutes, background app, reopen — resumes from correct position.
- [ ] Watch to 100% — `percentWatched: 100` in progress store.
- [ ] Delete download — `clearProgress()` removes progress file entry.
- [ ] Progress store file exists at `<documentDirectory>/icare_progress.json`.

### Kotlin Module (unit-level)
- [ ] `startDownload` saves title to `icare_download_meta` SharedPreferences.
- [ ] `toMap()` returns non-null `title` and `downloadedAt` for completed downloads.
- [ ] `getStorageStats()` returns correct byte sum and completed download count.
- [ ] `removeDownload` clears title + completedAt from `icare_download_meta`.
- [ ] `.nomedia` file created in `files/icare-downloads/` on first cache access.

---

## 8. Migration Steps

No database migrations required. All new storage is additive:

1. **Existing downloads** already in ExoPlayer's download index will appear in the new Download Center automatically. They will show `title: null` and `downloadedAt: null` until re-downloaded — this is displayed gracefully (title falls back to chapter ID, date shows `—`).

2. **No APK version lock** — the JS `offlineProgress.ts` file is new and starts with an empty JSON object on first read.

3. **Android build required** — `DownloadMetadata.kt` is a new Kotlin file. A new EAS build (development or preview profile) is required before testing. The `app.json` does not need changes; the file is auto-included by the Kotlin build.

4. **Expo prebuild is disabled** (`prebuildCommand: "echo 'skipping prebuild'"` in `eas.json`) — the new `.kt` file in `modules/icare-offline-drm/android/...` will be picked up automatically by Gradle since it's in the module's `src` directory. No `CMakeLists` or `build.gradle` changes needed.

---

## 9. Known Limitations

| # | Limitation | Workaround / Future Fix |
|---|-----------|------------------------|
| 1 | License renewal from Downloads screen navigates to player rather than silently renewing in background | Background renewal requires a fresh `drmToken` from the WebView bridge; this cannot be acquired without opening the WebView session |
| 2 | Network ping uses `google.com/generate_204` — may be blocked on some networks | Swap for a dedicated health endpoint on the Base44 backend |
| 3 | Watch position syncs to backend: not yet implemented (`synced: false` records accumulate) | Add a background sync job when `resolveStudentAccess` succeeds |
| 4 | iOS offline download not implemented (FairPlay / AVAssetDownloadTask) | All iOS-guarded paths throw a descriptive error — not a regression |
| 5 | Existing completed downloads show `downloadedAt: null` until re-downloaded | Acceptable for MVP; title/date shown as fallback strings |
