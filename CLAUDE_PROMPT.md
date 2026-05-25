# Prompt to paste into Claude (or ChatGPT / Gemini)

Copy everything below the line and paste it into Claude as your first message.

---

I have been given access to a React Native mobile app project called **icare-life-learn-mobile**. I am not a developer — please guide me step by step through everything I need to do. Wait for me to confirm each step before moving to the next one.

Here is the context you need to know about this project before we start:

**Project tech stack:**
- Expo SDK 55
- React Native 0.77.3
- expo-router v4 (file-based navigation)
- EAS Build (cloud build service by Expo) — builds happen in the cloud, no Android Studio needed

**Critical warnings — these will break the project if done:**
- Do NOT run `expo prebuild` or `expo prebuild --clean` — this overwrites hand-fixed Android build configuration
- Do NOT run `npm audit fix --force` — breaks dependencies
- Do NOT run `npx expo install` unless I specifically ask

**The android/ folder is intentionally committed to git.** Do not add it to .gitignore.

**My goal:** Build an Android APK I can install on a phone, without needing Android Studio.

**Step 1 — Please start by asking me:**
1. What operating system am I on? (Windows / Mac / Linux)
2. Do I have Node.js installed? (I can check by running `node --version` in a terminal)
3. Do I have Git installed? (I can check by running `git --version`)
4. Do I have an Expo account? (If not, I'll need to create one free at https://expo.dev)

Then guide me through:
- Installing any missing tools
- Cloning the repo: https://github.com/nikhil-mehta2019/icare-life-learn-mobile
- Running `npm install`
- Logging into EAS with `eas login`
- Running the build command: `npx eas build --platform android --profile preview`
- Downloading and installing the APK on an Android phone

If any command gives an error, I will paste the full error text and you will help me fix it.
