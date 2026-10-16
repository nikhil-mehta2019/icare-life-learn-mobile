# Build the iOS app for a real iPhone (EAS, internal distribution)

Needs once: an Expo account with access to this project, and the Apple Developer account
(the one that holds the FairPlay deployment package). Everything else is automatic.

From the repo root, on the `ios/offline-learning-v2` branch:

```bash
npm install
npx eas-cli login                       # Expo account
npx eas-cli device:create               # opens a link; open it on the iPhone and install the profile (registers the UDID)
npx eas-cli build --platform ios --profile ios-test
```

- On the first build EAS asks you to sign in to Apple and creates the certificate and provisioning profile itself (answer "yes" to let it manage credentials).
- When the build finishes (about 15-25 minutes) it prints an install link / QR code. Open it on the registered iPhone and install.
- Install builds are only for registered devices. For wider testing use TestFlight (`--profile production` then `eas submit`).

Notes
- Do NOT use the `preview` profile for iOS: it skips native project generation (`prebuildCommand`), which works for Android only.
- First thing to test on the phone: download a DRM lesson ("Add Downloads") and watch for the FairPlay key exchange. See `docs/ios-offline-fairplay-handoff.md`, section 3a.
