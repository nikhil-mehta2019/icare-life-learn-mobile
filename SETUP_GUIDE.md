# icare-life-learn-mobile — Setup Guide for New Team Members

This guide helps you get the project running and build an Android APK.
You do not need deep technical knowledge — just follow each step exactly.
If something goes wrong, copy the full error message and paste it into Claude, ChatGPT, or Gemini along with this note: **"I am setting up the icare-life-learn-mobile Expo React Native project."**

---

## What You Need to Install First

Install these tools in order. Each has a simple installer — just click Next/Install.

| Tool | Where to get it | Why |
|---|---|---|
| **Node.js 20 LTS** | https://nodejs.org → click "LTS" | Runs JavaScript tools |
| **Git** | https://git-scm.com/downloads | Downloads the code |
| **VS Code** (optional but recommended) | https://code.visualstudio.com | Editor with a built-in terminal |

After installing Node.js, open a terminal (search "cmd" or "PowerShell" on Windows) and run:
```
node --version
```
You should see something like `v20.x.x`. If you see an error, restart your computer and try again.

---

## Step 1 — Install EAS CLI (Expo Build Tool)

In your terminal, run:
```
npm install -g eas-cli
```

Then log in to Expo. You need an Expo account — create a free one at https://expo.dev if you don't have one:
```
eas login
```
It will ask for your email and password.

---

## Step 2 — Get the Code

If your colleague shared a GitHub link (e.g. `https://github.com/maveristic/icare-life-learn-mobile`), run:
```
git clone <paste-the-github-link-here>
cd icare-life-learn-mobile
```

---

## Step 3 — Install Project Dependencies

Inside the project folder, run:
```
npm install
```

This downloads all the libraries the project needs. It may take 2–5 minutes. You will see a lot of text — that is normal.

---

## Step 4 — Build the Android APK

Run this command to start a cloud build (it builds on Expo's servers, not your computer — no Android Studio needed):
```
npx eas build --platform android --profile preview
```

- It will ask: **"Do you want to log in..."** — press Enter to continue
- It will upload your project and start building in the cloud
- It prints a link like: `https://expo.dev/accounts/.../builds/...`
- Open that link in your browser to watch the progress
- Build usually takes **5–15 minutes**

When it says **"Build finished"**, you will see a download link or QR code for the APK.

---

## Step 5 — Install the APK on an Android Phone

1. Download the `.apk` file from the build link
2. Transfer it to the Android phone (via USB, WhatsApp, email, etc.)
3. On the phone: go to **Settings → Security → Install unknown apps** and allow it
4. Open the APK file on the phone and tap Install

---

## Common Errors and What to Do

### "eas: command not found"
The EAS CLI didn't install correctly. Try:
```
npm install -g eas-cli
```
If still failing, close and reopen your terminal.

### "npm install" fails with permission errors (Mac/Linux)
Run:
```
sudo npm install -g eas-cli
```

### Build fails on EAS with a Gradle error
This project has specific Gradle configuration. Do **not** run `expo prebuild` or `expo prebuild --clean` — it will overwrite important fixes. If the build fails, share the full error log with your technical colleague.

### "You are not authorized" on EAS
You need to be added to the Expo project. Ask the project owner (maveristic account) to add you at https://expo.dev.

---

## Important: Do NOT Run These Commands

These commands will break the project configuration and require manual fixes:

- ❌ `expo prebuild` or `expo prebuild --clean` — overwrites Android build fixes
- ❌ `npx expo install` without being told to — may downgrade packages
- ❌ `npm audit fix --force` — breaks dependencies

---

## Quick Reference

| Task | Command |
|---|---|
| Install dependencies | `npm install` |
| Start local dev server | `npx expo start` |
| Build Android APK (cloud) | `npx eas build --platform android --profile preview` |
| Check for project issues | `npx expo-doctor` |
| View recent builds | `npx eas build:list --platform android --limit 5` |

---

## Need Help?

Paste your error into Claude/ChatGPT/Gemini with this context:

> "I am working on the icare-life-learn-mobile project. It is a React Native app using Expo SDK 55 and react-native 0.77.3. I am trying to [describe what you were doing]. I got this error: [paste error here]."

The AI will guide you through fixing it step by step.
