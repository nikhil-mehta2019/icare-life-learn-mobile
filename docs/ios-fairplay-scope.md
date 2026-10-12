# iOS FairPlay (DRM) — Scope & Plan

**App:** icare-life-learn-mobile  **Platform:** iOS only (no Android changes)
**Status:** scoping — nothing here is implemented yet

---

## 1. Where we are today

| Area | iOS status |
|---|---|
| Login / course list (WebView) | Works |
| Playback of **non-DRM** lessons (public Mux playback IDs, incl. signed) | Works (verified in simulator) |
| Offline download + offline playback of **non-DRM** lessons | Works (verified in simulator, survives relaunch) |
| Playback of **DRM-protected** lessons | **Not working** (app asks for Widevine; iOS needs FairPlay) |
| Offline download of **DRM-protected** lessons | **Not available** (rejects with a clear message) |

### How much content is affected (read-only counts from the backend, 2026-10-12)

- 862 published chapters in total
  - **245 (~28%) are DRM-protected**
  - 399 (~46%) require signed playback (not necessarily DRM)
- 23 courses: 21 are `public` playback mode, **2 are `drm` mode**
  - "Senior Care Essentials: ADL" and "Baby & Childcare"
  - A DRM course can still contain non-DRM chapters (e.g. the intro lesson used in testing)

So without FairPlay, roughly a quarter of lessons, concentrated in two paid courses, cannot be watched on iPhone.

---

## 2. What FairPlay needs (non-code prerequisites)

These are on the critical path and have lead time. None of them can be done from this repo.

1. **Apple FairPlay Streaming (FPS) deployment package.** Apple issues it per developer account after a request/approval (can take several days). Mux does not provide this for FairPlay (it manages Widevine/PlayReady itself).
2. **Send the FPS files to Mux** and have FairPlay enabled on the Mux environment. Mux has been reported to require a certificate built on a specific FPS SDK version — confirm with Mux support before requesting from Apple.
3. **Apple Developer Program account** with a physical iPhone for testing. **FairPlay does not play in the iOS Simulator**, so every DRM test must be on a real device.
4. **Confirm what `getMuxToken` (Base44 backend function) returns for a DRM chapter** — see section 4.

Sources: [Protect videos on Mux with DRM](https://www.mux.com/docs/guides/protect-videos-with-drm), [Multi-DRM for developers](https://www.mux.com/articles/multi-drm-video-streaming-widevine-fairplay-playready), [Mux Player for iOS](https://www.mux.com/docs/guides/mux-player-ios). The DRM guide page was flagged as possibly dated — verify against current Mux docs before building.

---

## 3. How FairPlay playback works with Mux (summary)

- Playback needs **two JWTs**: a *playback token* (for the signed stream URL) and a *DRM license token*.
- Stream: `https://stream.mux.com/{PLAYBACK_ID}.m3u8?token={playback-token}`
- FairPlay endpoints (per Mux docs; verify):
  - Certificate: `https://license.mux.com/appcert/fairplay/{playback-id}?token={drm-license-token}`
  - License: `https://license.mux.com/license/fairplay/{playback-id}?token={drm-license-token}`
- The player fetches the certificate, builds an SPC with `AVContentKeySession`, POSTs it to the license URL, and feeds the returned CKC back.
- **Offline** additionally requires the license JWT to carry an `offline` claim and a `licenseExpiration` (seconds). The existing Android flow already needs an offline-capable token, so the backend may already emit one — to verify.

---

## 4. Open questions to verify (cheap, do these first)

1. For a DRM chapter, what does `getMuxToken` return? Expected on Android: `token`, `drmToken`, `drmLicenseUrl` (Widevine), `secureStreamUrl`.
2. Is `drmToken` a platform-neutral Mux DRM license JWT? If yes, iOS can build the FairPlay certificate/license URLs on the client from `playbackId` + `drmToken`, and **no backend change is needed**. If the backend hard-codes Widevine URLs, it needs an additive change (return FairPlay URLs too — Android keeps ignoring them).
3. Does that JWT include `offline` / `licenseExpiration` claims, and for how long is an offline license valid? (Drives the renewal UX.)
4. Which Mux "DRM configuration" is used, and is FairPlay enabled on it?

> Verification method: open one DRM chapter in the app with a temporary on-screen probe that prints token field names and JWT claim *names* (never values). This was prepared but not run — it needs a production read of a DRM lesson with the test account, which needs your go-ahead.

---

## 5. Work breakdown (rough estimates; one developer, excluding Apple/Mux lead time)

| Phase | What | Where | Estimate |
|---|---|---|---|
| **P0** | Prerequisites in section 2 + answers to section 4 | Apple / Mux / backend | Calendar time: days–weeks |
| **P1** | **Online FairPlay playback.** Pass `drm: { type: 'fairplay', certificateUrl, licenseServer, headers }` on iOS only. `react-native-video` 5.2.1 already has FairPlay support on iOS (resource-loader based). Handle token expiry and error mapping. | JS (iOS-gated) + possible small patch via patch-package | 1–2 days + device testing |
| **P2** | **Offline FairPlay download.** In the Swift module: `AVContentKeySession` with a *persistable* content key, stored securely (Keychain), plus the existing `AVAssetDownloadURLSession` download; expiry tracking. | Swift (`modules/icare-offline-drm/ios`) | 4–6 days |
| **P3** | **Offline FairPlay playback.** The player must supply the stored persistent key for the local asset. 5.2.1's player has no offline-key path, so this means patching its iOS resource loader or adding a small native player view. | Swift / patch | 3–5 days |
| **P4** | **License renewal + UX.** Re-acquire offline license before expiry (mirrors Android `renewOfflineLicense`), "license expired" state, error messages, retry. | Swift + JS | 2–3 days |
| **P5** | **QA on real devices.** Matrix: online/offline × DRM/non-DRM × fresh/relaunch × expired license × airplane mode; iOS 15 → latest. | — | 2–3 days |

**Total engineering:** roughly 2–3 weeks, dominated by P2/P3 and device testing. P1 alone (online DRM playback) can ship earlier and unlocks ~28% of lessons for streaming; offline DRM follows.

### Suggested sequencing

1. P0 now (start the Apple/Mux requests immediately — they gate everything).
2. P1 as soon as a FairPlay-enabled Mux config exists.
3. P2–P4 as one block, then P5.

---

## 6. Risks

- **Apple / Mux onboarding delay** is the biggest schedule risk and is outside the codebase.
- **No simulator testing** — every DRM change needs a physical device and a signed build (EAS or Xcode).
- **Old video library** (`react-native-video` 5.2.1): FairPlay online is supported but the iOS code path is dated; offline keys need a patch or a custom view. Upgrading to v6 would simplify P1/P3 but changes the shared dependency (and therefore Android), which is out of scope unless you decide otherwise.
- **License expiry behavior** (offline) must be defined with product: what happens to a downloaded lesson when its license lapses and the user is offline?
- **Certificate pinning / ATS**: the certificate fetch must not be blocked by app transport settings.

---

## 7. Android impact

None planned. All iOS work is gated on `Platform.OS === 'ios'` or lives in iOS-only files (`modules/icare-offline-drm/ios`). If a backend change is needed (section 4, question 2), it is additive — extra fields Android ignores.

---

## 8. Decisions needed from you

1. Start the Apple FPS request and Mux FairPlay enablement now? (Who owns the Apple Developer / Mux accounts?)
2. OK to run the read-only DRM token probe described in section 4 with the test account?
3. Offline license policy: how long should a downloaded DRM lesson stay playable offline?
4. Is upgrading `react-native-video` to v6 acceptable for both platforms later, or must the 5.2.1 line stay?
