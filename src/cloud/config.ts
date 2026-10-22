// Firebase web app config. Get it from the Firebase console:
// Project settings → General → Your apps → Web app → "SDK setup and configuration" → Config.
// These values are not secrets: they identify the project, and the Firestore security rules in
// firestore.rules are what keep each person's data private.
const config = {
  apiKey: 'AIzaSyABdPd6x8aeEi3LREgSHTEJf3jEq0F_Z-U',
  authDomain: 'dividends-c6017.firebaseapp.com',
  projectId: 'dividends-c6017',
  storageBucket: 'dividends-c6017.firebasestorage.app',
  messagingSenderId: '774606066957',
  appId: '1:774606066957:web:9bf44ffcf141affdc48c44',
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
