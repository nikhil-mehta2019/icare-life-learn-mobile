# icare-life-learn-mobile — Technical Context for Second Opinion

## Project Overview

React Native / Expo app (SDK 54, React Native 0.81.5) for Android. The app wraps the Base44 web app (`https://icare-life-learn.base44.app`) in a full-screen WebView. When a user taps a chapter inside the Base44 SPA, the app should open a **native video player screen** that plays a Mux DRM-protected video.

**GitHub:** `https://github.com/nikhil-mehta2019/icare-life-learn-mobile`
**Active branch:** `fix/webview-auth-player-stability`

---

## Core Architecture

```
┌─────────────────────────────────────────────────────┐
│  Explore Screen  (app/(tabs)/explore.tsx)            │
│  ┌──────────────────────────────────────────────┐   │
│  │  WebView → https://icare-life-learn.base44.app│   │
│  │  (injected JS monitors SPA navigation)        │   │
│  └──────────────────────────────────────────────┘   │
└─────────────────────────────────────────────────────┘
            │ window.ReactNativeWebView.postMessage
            ▼
┌─────────────────────────────────────────────────────┐
│  playerCache.ts  (async bridge)                      │
│  waitForPlayerData(chapterId) → Promise<BridgeResult>│
│  deliverPlayerData / deliverPlayerError              │
└─────────────────────────────────────────────────────┘
            │
            ▼
┌─────────────────────────────────────────────────────┐
│  Player Screen  (app/player/[chapterId].tsx)         │
│  Native react-native-video with Widevine DRM         │
└─────────────────────────────────────────────────────┘
```

---

## Why the WebView Bridge Is Needed

React Native's native `fetch()` on Android **does NOT share the cookie jar** with the WebView. The `getMuxToken` API endpoint at `https://icare-life-learn.base44.app/api/functions/getMuxToken` requires the user's session cookie. Therefore:

- The WebView (which IS authenticated) fetches the tokens using `credentials: 'include'`
- It posts the tokens back to native via `window.ReactNativeWebView.postMessage`
- Native stores them in `playerCache` and the player screen picks them up

---

## Key Files

### `app/(tabs)/explore.tsx`
- Hosts the Base44 WebView
- Contains `INJECTED_JS` (injected before content loads) which:
  - Monitors `history.pushState` / `replaceState` / `popstate` for SPA navigation
  - Detects chapter URLs matching `/chapter/{courseId}/{chapterId}`
  - Fetches chapter metadata + Mux token from the API using session cookies
  - Posts `CHAPTER_TOKENS` or `CHAPTER_ERROR` back to native
  - Posts `OPEN_CHAPTER` to trigger player navigation

### `api/playerCache.ts`
- `waitForPlayerData(chapterId)` — returns `{ promise, cancel }`
- Promise resolves with `BridgeResult = { ok: true, data } | { ok: false, error }`
- Times out after 10 seconds, resolves `{ ok: false, error: "Timed out after 10s..." }`

### `app/player/[chapterId].tsx`
- Mounts, checks for offline copy, then calls `waitForPlayerData(chapterId)`
- On `{ ok: true, data }` → plays video
- On `{ ok: false, error }` → shows error screen with the exact error string

### `app/_layout.tsx`
- Root Stack navigator
- Recently added `detachInactiveScreens={false}` (see below)

---

## The Roadblock — Current Error

**Error message on device:** `"Timed out after 10s waiting for WebView bridge tokens"`

This means:
- The player screen DID open (so `OPEN_CHAPTER` message WAS received by native)
- But `CHAPTER_TOKENS` or `CHAPTER_ERROR` NEVER arrived within 10 seconds
- The 10-second timeout in `playerCache.ts` fired, resolving `{ ok: false, error: "Timed out..." }`

---

## What We Know For Sure

1. ✅ The injected JS IS running (otherwise `OPEN_CHAPTER` wouldn't be posted)
2. ✅ `checkUrl()` IS detecting the chapter URL (player opens)
3. ✅ `_doFetchTokens(chapterId)` IS being called (called right after `OPEN_CHAPTER`)
4. ❌ But `CHAPTER_TOKENS` or `CHAPTER_ERROR` NEVER arrives at native within 10 seconds

---

## Attempted Fixes (All Failed)

### Fix 1 — Null check fallback for API key
Added `var key = _apiKey || window._icareApiKey || null` in `_doFetchTokens`.
**Result:** No change. (Nikhil already embedded the key directly, so this was the same thing.)

### Fix 2 — `detachInactiveScreens={false}` on Stack navigator
**Theory:** When `router.push('/player/[chapterId]')` fires, `react-native-screens` (used by expo-router) detaches the Explore screen from the Android view hierarchy. When detached, `window.ReactNativeWebView.postMessage()` may fail silently.
**Fix:** Added `detachInactiveScreens={false}` to the `<Stack>` in `app/_layout.tsx`.
**Result:** Still the same "Timed out after 10s" error.

### Fix 3 — Fetch BEFORE navigate (current, not yet tested)
**Theory:** Even with `detachInactiveScreens={false}`, there may be another mechanism causing `postMessage` to fail after navigation.
**Fix:** Changed the order. Now `_doFetchTokens` posts `OPEN_CHAPTER` ONLY AFTER the fetch completes (in both success and error paths). The WebView stays in the foreground for the entire API round-trip.
**Status:** Pushed to branch, new build in progress. NOT YET TESTED ON DEVICE.

---

## Current `INJECTED_JS` Logic (Simplified)

```javascript
// Runs before page content loads (injectedJavaScriptBeforeContentLoaded)
(function() {
  var _apiKey  = "6af260f41e2140b9950788621360c5cf"; // embedded at build time
  var _baseApi = "https://icare-life-learn.base44.app/api";

  window.__icareFetchTokens = function(chapterId) {
    _doFetchTokens(chapterId, false); // for download/delete flows
  };

  function _doFetchTokens(chapterId, navigateAfter) {
    // Step 1: Fetch chapter metadata
    fetch(_baseApi + '/entities/Chapter/' + chapterId, {
      headers: { 'Content-Type': 'application/json', 'api_key': _apiKey },
      credentials: 'include'
    })
    .then(r => r.json())
    .then(chapter => {
      var playbackId = chapter.muxDrmPlaybackId || chapter.muxSignedPlaybackId || chapter.muxPlaybackId;

      // Step 2: Fetch Mux token
      return fetch(_baseApi + '/functions/getMuxToken', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'api_key': _apiKey },
        credentials: 'include',
        body: JSON.stringify({ playbackId })
      })
      .then(r => r.json())
      .then(tokens => {
        // Post tokens back to native
        window.ReactNativeWebView.postMessage(JSON.stringify({
          type: 'CHAPTER_TOKENS', chapterId, chapter, tokens
        }));
        // THEN navigate (Fix 3 — newest)
        if (navigateAfter) {
          window.ReactNativeWebView.postMessage(JSON.stringify({
            type: 'OPEN_CHAPTER', chapterId
          }));
        }
      });
    })
    .catch(err => {
      window.ReactNativeWebView.postMessage(JSON.stringify({
        type: 'CHAPTER_ERROR', chapterId, error: String(err)
      }));
      if (navigateAfter) {
        window.ReactNativeWebView.postMessage(JSON.stringify({
          type: 'OPEN_CHAPTER', chapterId
        }));
      }
    });
  }

  // Monitor SPA navigation
  function checkUrl() {
    var chapterId = getChapterIdFromUrl(window.location.href);
    if (chapterId && chapterId !== _lastFiredId) {
      _lastFiredId = chapterId;
      _doFetchTokens(chapterId, true); // fetch first, THEN open player
    }
  }

  history.pushState = wrap(history.pushState, () => setTimeout(checkUrl, 150));
  history.replaceState = wrap(history.replaceState, () => setTimeout(checkUrl, 150));
  window.addEventListener('popstate', () => setTimeout(checkUrl, 150));
  window.addEventListener('hashchange', () => setTimeout(checkUrl, 150));
  setTimeout(checkUrl, 800);
})();
```

---

## Key Questions We Cannot Answer Without Chrome DevTools

We have no way to inspect the WebView console from the device being tested. We cannot see:
1. Whether `[icare-bridge] Fetching tokens for chapter X` is logged
2. Whether the fetch completes (success or error)
3. Whether `window.ReactNativeWebView` is defined when the callback fires
4. Any network errors on the fetch

---

## Hypotheses for Why Fetch Never Posts Back

**Hypothesis A — Fetch hangs indefinitely (never resolves or rejects)**
If the Base44 API never responds to the fetch (TCP connect but no response), the Promise chain never completes. `.catch` never fires. Nothing is posted.

**Hypothesis B — `window.ReactNativeWebView` is undefined/dead when callback fires**
After `router.push` moves the player to front, even with `detachInactiveScreens={false}`, the WebView's Java bridge might become unavailable. `_postMessage` check is `if (window.ReactNativeWebView)` — if the check passes but calling `.postMessage()` throws internally, everything silently fails.

**Hypothesis C — Base44 SPA navigates away mid-fetch, aborting the fetch**
If the Base44 SPA itself calls `location.replace()` or causes a full page reload after the chapter URL is detected, the WebView reloads, destroying the JS context and aborting the fetch.

**Hypothesis D — Authentication issue causing silent hang**
Base44 may use session tokens in localStorage (not cookies). `credentials: 'include'` sends cookies but not localStorage data. If the `/api/entities/Chapter/{id}` endpoint requires a token that's in localStorage, the request might hang or silently fail rather than returning 401.

**Hypothesis E — CORS preflight hanging (unlikely but possible)**
Even on same origin, some server configurations cause CORS issues with custom headers. If the API has non-standard CORS config, a preflight might hang.

---

## What We Would Like GPT's Help With

1. **Which hypothesis is most likely given the symptoms?** (10s timeout, player opens, no CHAPTER_TOKENS/ERROR ever arrives)

2. **Is there a way to get the Mux token WITHOUT going through the WebView bridge?** For example, using `@react-native-cookies/cookies` to extract the session cookie from the WebView and use it in a native fetch?

3. **Is there a fundamentally different architecture** that avoids this WebView → native message passing entirely?

4. **Could the `credentials: 'include'` fetch from injected JS fail** on Android WebView in a way that causes a silent hang rather than an error? Any known Android WebView quirks with `fetch()` + `credentials: 'include'`?

5. **Is there a way to test this without building a full APK each time?** (Expo Go doesn't work because of native modules.)

---

## Build Info

- EAS Build, account: `maveristic`, project: `icare-life-learn-mobile`
- Profile: `preview` (internal distribution APK)
- Branch: `fix/webview-auth-player-stability`
- Each test cycle = ~15 minutes (EAS build time)
- Cannot use Expo Go (custom native modules: Widevine DRM, offline download)
- **CONSTRAINT: Do NOT run `expo prebuild`** — the `android/` folder has hand-configured native modules

---

## Environment

- Expo SDK 54
- React Native 0.81.5
- expo-router 4.x
- react-native-webview 13.x
- react-native-video (with DRM support)
- react-native-screens (used by expo-router for Stack navigation)
- Android target: physical device (not emulator)
