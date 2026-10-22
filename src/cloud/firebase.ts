// Firebase, loaded on demand so the app stays small when it runs without an account.
import type { CloudConfig } from './config';
import type { MarketInfo, NotifySettings, Portfolio } from '../lib/types';

export interface CloudUser { uid: string; email: string | null; emailVerified: boolean }

export interface LinkedAccount { itemId: string; institution: string; linkedAt: string; needsReauth: boolean }

/** Settings that belong to the account (the rest stay on each device). */
export interface AccountSettings {
  monthlyGoal: number;
  taxRate: number;
  ordinaryTaxRate: number;
  watchlist: string[];
  notify: NotifySettings;
}

export interface Profile {
  settings?: Partial<AccountSettings>;
  accounts?: LinkedAccount[];
  sync?: { lastSync?: string | null; lastError?: string | null; syncing?: boolean; startedAt?: string };
}

export type Cloud = Awaited<ReturnType<typeof loadCloud>>;

const AUTH_MESSAGES: Record<string, string> = {
  'auth/invalid-email': "That email address doesn't look right.",
  'auth/invalid-credential': "That email and password don't match an account.",
  'auth/wrong-password': "That email and password don't match an account.",
  'auth/user-not-found': "That email and password don't match an account.",
  'auth/email-already-in-use': 'An account with that email already exists. Sign in instead.',
  'auth/weak-password': 'Use a password with at least 8 characters.',
  'auth/too-many-requests': 'Too many attempts. Wait a few minutes and try again.',
  'auth/network-request-failed': "Couldn't reach the server. Check your connection.",
  'auth/requires-recent-login': 'For your security, sign in again and then retry.',
};

/** A readable message for Firebase errors (auth codes, callable function errors). */
export function cloudMessage(e: unknown): string {
  const err = e as { code?: string; message?: string };
  if (err.code && AUTH_MESSAGES[err.code]) return AUTH_MESSAGES[err.code];
  if (err.code?.startsWith('functions/') && err.message) return err.message;
  return err.message || 'Something went wrong. Try again.';
}

export async function loadCloud(cfg: CloudConfig) {
  const [{ initializeApp }, A, F, Fn] = await Promise.all([
    import('firebase/app'), import('firebase/auth'), import('firebase/firestore'), import('firebase/functions'),
  ]);
  const app = initializeApp(cfg.options);
  const auth = A.getAuth(app);
  // Imported CSV rows can carry empty optional fields; Firestore rejects undefined unless told to skip it.
  const db = F.initializeFirestore(app, { ignoreUndefinedProperties: true });
  const functions = Fn.getFunctions(app, 'us-central1');
  if (cfg.useEmulators) {
    A.connectAuthEmulator(auth, 'http://127.0.0.1:9099', { disableWarnings: true });
    F.connectFirestoreEmulator(db, '127.0.0.1', 8080);
    Fn.connectFunctionsEmulator(functions, '127.0.0.1', 5001);
  }
  await A.setPersistence(auth, A.browserLocalPersistence);

  const toUser = (u: { uid: string; email: string | null; emailVerified: boolean } | null): CloudUser | null =>
    u ? { uid: u.uid, email: u.email, emailVerified: u.emailVerified } : null;

  return {
    onAuth: (cb: (u: CloudUser | null) => void) => A.onAuthStateChanged(auth, (u) => cb(toUser(u))),
    signIn: (email: string, password: string) => A.signInWithEmailAndPassword(auth, email.trim(), password),
    signUp: async (email: string, password: string) => {
      const cred = await A.createUserWithEmailAndPassword(auth, email.trim(), password);
      await A.sendEmailVerification(cred.user).catch(() => {});
    },
    resetPassword: (email: string) => A.sendPasswordResetEmail(auth, email.trim()),
    signOut: () => A.signOut(auth),
    changePassword: async (current: string, next: string) => {
      const u = auth.currentUser;
      if (!u?.email) throw new Error('Sign in first.');
      await A.reauthenticateWithCredential(u, A.EmailAuthProvider.credential(u.email, current));
      await A.updatePassword(u, next);
    },

    watchProfile: (uid: string, cb: (p: Profile) => void, onError: (e: unknown) => void) =>
      F.onSnapshot(F.doc(db, 'users', uid), (s) => cb((s.data() as Profile) ?? {}), onError),
    watchPortfolio: (uid: string, cb: (p: Portfolio | null) => void, onError: (e: unknown) => void) =>
      F.onSnapshot(F.doc(db, 'users', uid, 'portfolio', 'current'), (s) => cb((s.data() as Portfolio) ?? null), onError),
    saveSettings: (uid: string, settings: AccountSettings) =>
      F.setDoc(F.doc(db, 'users', uid), { settings }, { merge: true }),
    /** Live market data for these symbols (Firestore allows 30 ids per "in" query). */
    watchMarket: (symbols: string[], cb: (m: Record<string, MarketInfo>) => void, onError: (e: unknown) => void) => {
      const parts: Record<string, MarketInfo>[] = [];
      const ids = symbols.map((s) => s.replace(/\//g, '_'));
      const stops: (() => void)[] = [];
      for (let i = 0; i < ids.length; i += 30) {
        const k = i / 30;
        parts[k] = {};
        stops.push(F.onSnapshot(F.query(F.collection(db, 'market'), F.where(F.documentId(), 'in', ids.slice(i, i + 30))), (snap) => {
          parts[k] = Object.fromEntries(snap.docs.map((d) => [(d.data() as MarketInfo).symbol ?? d.id, d.data() as MarketInfo]));
          cb(Object.assign({}, ...parts));
        }, onError));
      }
      return () => stops.forEach((f) => f());
    },
    savePortfolio: (uid: string, p: Portfolio) =>
      F.setDoc(F.doc(db, 'users', uid, 'portfolio', 'current'), { ...p, source: 'manual' }),

    call: async <T = unknown>(name: string, data: unknown = {}): Promise<T> =>
      (await Fn.httpsCallable<unknown, T>(functions, name, { timeout: 150_000 })(data)).data,
  };
}
