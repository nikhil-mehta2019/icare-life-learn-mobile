# iCare Life Learn Mobile — Build & Release Guide

**App:** icare-life-learn-mobile  
**Package:** com.maveristic.icarelifelearnmobile  
**Build system:** Expo EAS (Expo Application Services)  
**Target:** Android (Google Play Store)

> This guide is written for use with Claude. Each section includes the exact prompts to give Claude so it can execute the steps for you.

---

## Prerequisites Checklist

Before starting, confirm the following are in place:

- [ ] Node.js 18+ installed
- [ ] EAS CLI installed: `npm install -g eas-cli`
- [ ] Expo account created at https://expo.dev
- [ ] Google Play Console account (for Play Store release)
- [ ] The repo cloned and dependencies installed (`npm install` in project root)
- [ ] EAS project linked — the `app.json` already has `projectId: "f2a8c774-4137-4a21-9291-4734746371bb"`

---

## Part 1: Build a Test APK (Internal Testing)

Use this to share the app with testers without going through the Play Store review process.

### Step 1 — Log in to EAS

Run in terminal:
```
eas login
```
Enter your Expo account credentials.

**Claude prompt:**
> "Log me into EAS and confirm I'm authenticated"

---

### Step 2 — Configure EAS Build (first time only)

If `eas.json` does not exist in the project root, run:
```
eas build:configure
```
This creates `eas.json` with build profiles.

**Claude prompt:**
> "Check if eas.json exists. If not, run eas build:configure and show me the output"

After running, your `eas.json` should have at minimum:
```json
{
  "build": {
    "development": {
      "developmentClient": true,
      "distribution": "internal"
    },
    "preview": {
      "distribution": "internal",
      "android": {
        "buildType": "apk"
      }
    },
    "production": {
      "android": {
        "buildType": "app-bundle"
      }
    }
  }
}
```

**Claude prompt:**
> "Show me the current eas.json and make sure it has a 'preview' profile that builds an APK for internal distribution"

---

### Step 3 — Build the APK

To build an installable APK for testing (not AAB):
```
eas build --platform android --profile preview
```

This uploads your code to Expo's cloud build servers and returns a download link when done. Build takes approximately 10–20 minutes.

**Claude prompt:**
> "Run eas build for android using the preview profile and monitor the output"

When the build finishes, EAS prints a URL like:
```
https://expo.dev/accounts/[your-account]/projects/icare-life-learn-mobile/builds/[build-id]
```

Download the `.apk` file from that URL and install it on any Android device via:
- Direct file transfer (USB or email)
- Or share the EAS download link — testers can install directly from the browser

---

### Step 4 — Install on Android Device

On the test device:
1. Go to **Settings → Security → Install unknown apps** and allow installation from browser or file manager
2. Open the downloaded APK file
3. Tap Install

---

### Step 5 — Share with Multiple Testers (Optional)

EAS supports internal distribution links. Run:
```
eas build --platform android --profile preview --auto-submit
```

Or share the direct APK download URL from the EAS dashboard with testers. No Play Store account needed.

---

## Part 2: Build for Play Store Release (Production AAB)

The Play Store requires an Android App Bundle (`.aab`), not an APK.

### Step 1 — Increment Version

Before every Play Store release, increment `version` in `app.json`:
```json
"version": "1.0.1"
```
And increment `versionCode` in the android section:
```json
"android": {
  "versionCode": 2
}
```

**Claude prompt:**
> "Increment the version in app.json from 1.0.0 to 1.0.1 and add versionCode 2 under the android section"

---

### Step 2 — Set Up Keystore (first time only)

EAS manages the keystore for you. On first production build it will ask:
```
? Generate a new Android Keystore? Yes
```
Select Yes. EAS stores it securely in their servers. **Do not lose this keystore** — you cannot update the Play Store app without it.

**Claude prompt:**
> "Check if a keystore is already configured for this EAS project. If not, explain how to generate one"

---

### Step 3 — Build the Production AAB

```
eas build --platform android --profile production
```

Build takes 15–25 minutes. Output is a `.aab` file downloadable from the EAS dashboard.

**Claude prompt:**
> "Run eas build for android using the production profile and wait for the build URL"

---

### Step 4 — Submit to Play Store

#### Option A — Manual upload (via Play Console)

1. Go to https://play.google.com/console
2. Select your app (create it first if this is the first release)
3. Go to **Release → Production → Create new release**
4. Upload the `.aab` file downloaded from EAS
5. Fill in release notes
6. Click **Review release → Start rollout**

#### Option B — Automated via EAS Submit

Configure `eas.json` to include submit config:
```json
{
  "submit": {
    "production": {
      "android": {
        "serviceAccountKeyPath": "./google-service-account.json",
        "track": "production"
      }
    }
  }
}
```

Then run:
```
eas submit --platform android --profile production
```

This requires a Google Play service account JSON key. To create one:
1. Go to Google Play Console → Setup → API access
2. Link to a Google Cloud project
3. Create a service account with **Release Manager** role
4. Download the JSON key and save as `google-service-account.json` in the project root (add to `.gitignore`)

**Claude prompt:**
> "Help me set up EAS Submit for Android with a Google service account so I can automate Play Store uploads"

---

## Part 3: Play Store First-Time App Setup

If this app has never been published before, complete these steps in Play Console before submitting a build.

### Required Before First Release

1. **Create the app** in Play Console → All apps → Create app
   - App name: iCare Life Learn
   - Default language: English
   - App or Game: App
   - Free or Paid: (your choice)

2. **Complete the store listing:**
   - Short description (80 chars)
   - Full description (4000 chars)
   - Screenshots: at least 2 phone screenshots
   - Feature graphic: 1024×500 px banner
   - App icon: 512×512 px PNG

3. **Content rating:** Play Console → Policy → App content → Rating questionnaire

4. **Privacy policy URL:** Required — must be a publicly accessible URL

5. **Data safety form:** Declare what data the app collects (Play Console → Policy → App content → Data safety)

6. **Target audience:** Set age group

7. **Internal test track first:** Before going to production, release to Internal testing (up to 100 testers) to validate the build, then promote to Production.

**Claude prompt:**
> "What is the minimum store listing information I need to fill in Play Console before I can submit my first APK for internal testing?"

---

## Part 4: Update Releases (After First Release)

For every subsequent update:

1. Increment `version` and `versionCode` in `app.json`
2. Commit and push changes to git
3. Run `eas build --platform android --profile production`
4. Download the `.aab` and upload to Play Console, or use `eas submit`
5. Write release notes describing what changed
6. Roll out (can do staged rollout: 10% → 50% → 100%)

**Claude prompt:**
> "Prepare the app for a new Play Store release: increment the version, build the production AAB, and guide me through submitting it"

---

## Quick Reference — Common EAS Commands

| Task | Command |
|------|---------|
| Login | `eas login` |
| Check login status | `eas whoami` |
| Build test APK | `eas build --platform android --profile preview` |
| Build production AAB | `eas build --platform android --profile production` |
| Submit to Play Store | `eas submit --platform android` |
| View build list | `eas build:list` |
| View build logs | `eas build:view` |
| Check project config | `eas project:info` |

---

## Troubleshooting with Claude

If any step fails, give Claude the exact error message and use these prompts:

| Problem | Claude prompt |
|---------|--------------|
| EAS build fails | "The EAS build failed with this error: [paste error]. Help me fix it." |
| Keystore issue | "EAS is showing a keystore error. What does this mean and how do I resolve it?" |
| Play Store rejection | "My app was rejected with this reason: [paste reason]. What do I need to change?" |
| Version conflict | "Play Store says the versionCode already exists. How do I fix app.json?" |
| Native module build error | "The build failed on the icare-offline-drm native module with: [paste error]" |

---

## Notes on This Project's Native Module

This app contains a custom native Android module at `modules/icare-offline-drm/` that handles Widevine DRM offline downloads. This means:

- **Expo Go cannot be used for final testing** — it does not support custom native modules. Use the preview APK build instead.
- The module only targets Android. iOS builds will compile but the DRM download feature will not function on iOS until native iOS code is added to the module.
- EAS cloud builds handle the Android NDK and Gradle setup automatically — no local Android SDK setup is needed on the build machine.
