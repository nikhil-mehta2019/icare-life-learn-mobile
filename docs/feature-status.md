# iCare Life Learn Mobile — Feature Implementation Status

**App:** icare-life-learn-mobile  
**Package:** com.maveristic.icarelifelearnmobile  
**Version:** 1.0.0  
**Platform:** Android (iOS structure present, native modules Android-only)  
**Date:** 2026-05-26

---

## Implemented Features

### 1. Pinch-to-Fullscreen Support
**Status:** Complete  
**Commit:** `62d78c1`  
**File:** `app/player/[chapterId].tsx`

**What was done:**
- Integrated `react-native-gesture-handler` pinch gesture on the video player
- Spreading fingers (scale > 1.2) triggers `presentFullscreenPlayer()` — enters native fullscreen
- Pinching in (scale < 0.8) triggers `dismissFullscreenPlayer()` — exits fullscreen
- Player container sized to exact 16:9 ratio using `useWindowDimensions` — adapts to any screen width without distortion
- `resizeMode="contain"` ensures video letterboxes correctly without cropping
- `onFullscreenPlayerDidDismiss` callback keeps state in sync when the user exits fullscreen via the native back gesture

**Result:** Users can pinch to enter/exit fullscreen. Aspect ratio is correctly maintained on all Android screen sizes.

---

### 2. Screen Lock Prevention During Video Playback
**Status:** Complete  
**Commit:** `62d78c1`  
**File:** `app/player/[chapterId].tsx`

**What was done:**
- Integrated `expo-keep-awake` (part of Expo SDK, no extra install needed)
- Screen stays on when `onPlaybackStateChanged` fires with `isPlaying: true`
- Screen lock is restored in all of these cases:
  - Video paused
  - Video reaches end (`onEnd`)
  - Playback error (`onError`)
  - User exits the player screen (effect cleanup)
  - App goes to background (expo-keep-awake handles this automatically)
- Uses a named tag `'video-player'` to avoid conflicts with other keep-awake callers

**Platform behavior:**
- Android: sets `FLAG_KEEP_SCREEN_ON` on the window
- iOS: sets `UIApplication.shared.isIdleTimerDisabled`

**Result:** Screen stays active for the full duration of video playback, exactly like YouTube or SonyLiv.

---

### 3. Audio Language Selection Prompt
**Status:** Complete  
**Commit:** `13cec25`  
**File:** `app/player/[chapterId].tsx`

**What was done:**
- `onLoad` callback reads `audioTracks` array from the video metadata (provided by ExoPlayer via react-native-video)
- If more than one audio track is detected, an animated toast is shown at the bottom of the player:
  > *"Multiple audio languages available. Select your preferred language from player settings."*
- Toast fades in over 300ms, stays for 4 seconds, then fades out — or can be dismissed immediately with the ✕ button
- Uses `expo-secure-store` to persist a flag `audio_lang_hint_shown` — toast is shown **only once per device**, not on every video
- If only one audio track exists, no toast is shown

**Result:** First-time users are clearly guided to the audio language setting without any blocking UI or repeated interruptions.

---

## Not Implemented

### 4. Next Video Navigation Button
**Status:** Blocked — backend data missing

**What was requested:**
After a video finishes, show a "Next Video" button that loads the next chapter automatically.

**Why it was not implemented:**
The Base44 backend API currently does not return any data that identifies what the next chapter is. The `fetchChapter` API returns only these fields:

```
id, title, muxPlaybackId, muxDrmProtected, muxSignedPlaybackRequired, videoPosterUrl
```

There is no `nextChapterId`, no `order`/`sequence` field, no `courseId`, and no endpoint to fetch a course's ordered chapter list. Without knowing which chapter comes next, there is nothing to navigate to.

**What the backend team needs to add (pick one):**

| Option | Effort | Description |
|--------|--------|-------------|
| A | Lowest | Add a `nextChapterId` field to the Chapter entity in Base44. The player reads it from the existing `fetchChapter` response — zero new endpoints. |
| B | Medium | Add a `GET /courses/{courseId}/chapters` endpoint returning an ordered list. Requires `courseId` to be passed when opening the player. |
| C | Medium | Add a `fetchNextChapter(chapterId)` backend function that returns the next chapter object or null. Clean API, hides ordering logic on the server. |

**What is ready on the frontend once backend is done:**
The player already has `onEnd`, `router`, and the full navigation pattern. Wiring the "Next Video" overlay with a 5-second auto-advance countdown is approximately 60 lines of code — ready to implement the moment a `nextChapterId` is available in the API response.

---

### 5. Video Resolution / Quality Selection
**Status:** Not a code bug — architectural constraint in current library version

**What was reported:**
Switching between 1080p, 720p, 540p, 360p, and Auto in the player shows no visible quality difference.

**Root cause analysis:**

The current player uses `controls={true}` on `react-native-video` v5.2.1, which renders ExoPlayer's native built-in controls. The quality picker in that native UI does pass selections to ExoPlayer internally, but:

1. **ABR overrides manual selection:** ExoPlayer's Adaptive Bitrate logic on a fast Wi-Fi or 4G connection will float back up to the highest available rendition immediately after a manual selection, overriding the user's choice.

2. **JS bridge limitation in v5.x:** The `selectedVideoTrack` prop in react-native-video 5.x is a separate code path from the native controls picker. They do not share state — changing quality in the native UI does not update `selectedVideoTrack`, and setting `selectedVideoTrack` in JS does not reflect in the native controls UI.

3. **Possible Mux encoding factor:** For short or low-motion content, Mux may produce renditions at 720p and 1080p that are visually near-identical in bitrate. Test with a long, high-motion clip (e.g., sports footage) on a throttled connection to confirm the difference is actually visible on the source content.

**What a proper fix requires:**
- Remove `controls={true}` 
- Build a fully custom player UI (play/pause, seek bar, fullscreen button, quality picker)
- Set `selectedVideoTrack` prop programmatically from the custom UI
- This is a 3–5 day rebuild

**Recommended path:**
1. First verify on throttled connection whether the quality difference is visible in Mux's own web player for the same video. If it is invisible there too, it is a Mux encoding issue, not a player bug.
2. When ready, migrate to `react-native-video` v6 (maintained by TheWidlarzGroup) which includes a proper `ControlsComponent` API and first-class `selectedVideoTrack` support designed for this use case.

---

## Summary Table

| # | Feature | Status | Commit |
|---|---------|--------|--------|
| 1 | Pinch-to-Fullscreen + Aspect Ratio | Done | `62d78c1` |
| 2 | Screen Wake Lock During Playback | Done | `62d78c1` |
| 3 | Audio Language Selection Prompt | Done | `13cec25` |
| 4 | Next Video Navigation Button | Blocked (needs backend `nextChapterId`) | — |
| 5 | Video Resolution Quality Switching | Not implemented (library + ABR constraint) | — |
