**To:** Nikhil
**Subject:** icare-life-learn-mobile — Full Handoff: Changes Made, Remaining Issue & Debug Guide

---

Hi Nikhil,

All changes have been pushed to the `main` branch on GitHub. Latest commit: **`7f8409d`**. Please pull before your next build.

---

## What Was Done

### 1. Home screen fixed
The native course list is gone. `app/(tabs)/index.tsx` is now a simple redirect:

```tsx
import { Redirect } from 'expo-router';
export default function IndexRedirect() {
  return <Redirect href="/(tabs)/explore" />;
}
```

The app opens directly to the Base44 WebView on launch. Confirmed working.

### 2. Tab bar hidden
`app/(tabs)/_layout.tsx` sets `tabBarStyle: { display: 'none' }`. Base44 is the sole navigation UI.

### 3. Chapter URL pattern fixed
Base44 uses `/chapter/{courseId}/{chapterId}`. We were incorrectly capturing `courseId` (first segment) instead of `chapterId` (second segment). Fixed in both the TypeScript regex patterns and the injected JavaScript in `explore.tsx`.

### 4. Native player opens on chapter tap
The injected JavaScript now monitors SPA navigation (`pushState`/`replaceState`/`popstate`) and posts an `OPEN_CHAPTER` message to native when a chapter URL is detected. The native player screen opens immediately in a loading state. Confirmed working via logcat — `[RNScreens]` fires when a chapter is tapped.

### 5. "Unauthorized" fix — WebView auth bridge
The core problem: `getMuxToken` requires the user's login session cookie. React Native's native `fetch()` does **not** share the WebView's cookie jar on Android. The fix routes the token fetch through the WebView itself, which IS authenticated.

**New file added: `api/playerCache.ts`** — a lightweight async bridge. No new npm packages required.

**The flow:**
1. User taps a chapter → injected JS immediately posts `OPEN_CHAPTER` → native player opens in loading state
2. Simultaneously, injected JS calls `fetchAndPostTokens(chapterId)` inside the WebView — this uses `credentials: 'include'` with the live session cookie to call `/api/entities/Chapter/{id}` and `/api/functions/getMuxToken`
3. On success: posts `CHAPTER_TOKENS` message to native
4. On failure: posts `CHAPTER_ERROR` message to native
5. Native player calls `waitForPlayerData(chapterId)` which resolves as soon as tokens arrive, or returns `null` after 10 seconds
6. If tokens received → plays video. If `null` → falls back to direct API call (which also fails if not logged in, showing "Unauthorized")

---

## What Still Needs to Be Verified

Trigger a fresh build from `main` (commit `7f8409d`) if you haven't already:

```
eas build --platform android --profile preview
```

Run this from **Command Prompt** (not PowerShell — execution policy blocks `eas`).

**Test checklist:**
1. App opens directly to Base44 WebView — no course list ✅ (already confirmed)
2. Log in to Base44 within the WebView
3. Navigate to a chapter and tap it — native player should open ✅ (confirmed opening)
4. **Video plays without "Unauthorized" error** ← needs verification
5. Pinch-to-zoom, download for offline, back button all work as before

---

## Logcat Analysis — Latest Build

The logcat from the most recent test (PID 18328, 13:31) shows:

- ✅ App launches cleanly
- ✅ WebView loads (Chrome 148)
- ✅ `[RNScreens]` fires at 13:31:39 — player screen opened when chapter was tapped
- ⚠️ `FabricUIManagerBinding::reportMount: Surface with id -1 is not found` at 13:31:59 and 13:32:59
- ⚠️ `DequeueBuffer time out` at 13:32:59

**What these mean:** The `Surface with id -1` warning fires exactly 20 seconds after the player opens. The `waitForPlayerData` timeout is 10 seconds. Timeline: player opens → waits 10s → timeout fires → falls back to native `getMuxToken` → fails with Unauthorized → error screen shown → user presses "Go back" → the stale Promise tries to call `setState` on the now-unmounted component → Surface -1 warning. This is a symptom, not the cause.

**Root cause:** The WebView auth bridge (`fetchAndPostTokens`) is not delivering tokens within 10 seconds. The player times out and falls back to native `getMuxToken`, which also fails because the session cookie isn't available natively.

**Most likely reasons:**
1. **User was not logged in** when tapping the chapter. Session cookie doesn't exist → `getMuxToken` returns 401 inside WebView → `CHAPTER_ERROR` posted → `waitForPlayerData` returns `null` immediately → native fallback also fails → "Unauthorized" appears quickly (under 2 seconds, not after 10s).
2. **Old APK still installed** from before commit `7f8409d`. The `onMessage` handler wouldn't have the new token delivery logic.

---

## How to Debug the WebView Bridge

1. Connect the Android device via USB to a PC
2. Open Chrome and go to `chrome://inspect`
3. Find the WebView under the app name and click **Inspect**
4. Open the **Console** tab
5. On the device, log in to Base44, then tap a chapter
6. In the Console, look for:
   - Any error output from `fetchAndPostTokens`
   - The HTTP response status from `/api/functions/getMuxToken`
   - Whether `window.ReactNativeWebView` is defined — type `window.ReactNativeWebView` in the console and check it's not `undefined`

If the console shows a 401 from `getMuxToken`, the user is not logged in. If `window.ReactNativeWebView` is `undefined`, the bridge injection failed and the injected JS is not running.

---

## Critical Build Constraints — Please Do Not Change

- ❌ Do **NOT** run `expo prebuild` or `expo prebuild --clean` — this overwrites the hand-configured `android/` folder containing custom Widevine DRM and offline download native modules
- ❌ Do **NOT** run `npm audit fix --force` — breaks package dependencies
- ❌ Do **NOT** add `android/` to `.gitignore` — it is intentionally committed
- Always commit/push from **Command Prompt**, not PowerShell (PowerShell blocks `eas` due to execution policy)
- If you see `HEAD.lock` or `index.lock` errors from git, delete the lock file from the `.git` folder and retry

---

## Summary of All Changed Files

| File | Change |
|------|--------|
| `app/(tabs)/index.tsx` | Replaced with `<Redirect href="/(tabs)/explore" />` |
| `app/(tabs)/_layout.tsx` | Tab bar hidden, only explore screen active |
| `app/_layout.tsx` | Anchor set to explore, player added to root Stack |
| `app/(tabs)/explore.tsx` | SPA navigation monitoring + WebView auth bridge for tokens |
| `app/player/[chapterId].tsx` | Uses `waitForPlayerData()` from playerCache, falls back gracefully |
| `api/playerCache.ts` | **NEW** — async bridge between WebView and native player |

Your original player features (pinch-to-zoom, Widevine DRM, offline download, keep-awake, audio language toast) are all intact and untouched.

Let me know if you have any questions.

Thanks,
Canute
