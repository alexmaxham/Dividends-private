// Firebase web app config. Get it from the Firebase console:
// Project settings → General → Your apps → Web app → "SDK setup and configuration" → Config.
// These values are not secrets: they identify the project, and the Firestore security rules in
// firestore.rules are what keep each person's data private.
// Until apiKey is filled in, the app runs on its own in the browser (sample data, CSV import, manual entry).
const config = {
  apiKey: '',
  authDomain: '',
  projectId: '',
  storageBucket: '',
  messagingSenderId: '',
  appId: '',
};

export interface CloudConfig {
  options: typeof config;
  /** Talk to local Firebase emulators instead of the real project (for development/testing). */
  useEmulators: boolean;
}

export const cloudConfig: CloudConfig | null =
  import.meta.env.VITE_FIREBASE_EMULATORS === 'true'
    ? { options: { ...config, apiKey: 'demo-key', authDomain: 'localhost', projectId: 'demo-dividends' }, useEmulators: true }
    : config.apiKey
      ? { options: config, useEmulators: false }
      : null;
