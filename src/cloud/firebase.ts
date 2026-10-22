// Firebase, loaded on demand so the app stays small when it runs without an account.
import type { CloudConfig } from './config';
import type { MarketInfo, NotifySettings, Portfolio } from '../lib/types';

export interface CloudUser {
  uid: string;
  email: string | null;
  emailVerified: boolean;
  /** Sign-in methods on the account: 'password', 'google.com'. */
  providers: string[];
}

/** A sign-in that still needs the 6-digit code from an authenticator app. */
export interface SecondStep { finish: (code: string) => Promise<void> }

/** Two-step verification being set up: show the key or QR code, then confirm with a code. */
export interface TotpSetup { secretKey: string; url: string; finish: (code: string) => Promise<void> }

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
  'auth/requires-recent-login': 'For your security, sign out and back in, then try again.',
  'auth/invalid-verification-code': "That code didn't work. Check the 6 digits in your authenticator app and try again.",
  'auth/missing-code': 'Enter the 6-digit code from your authenticator app.',
  'auth/unverified-email': 'Verify your email address first (check your inbox), then try again.',
  'auth/operation-not-allowed': "That sign-in method isn't turned on for this app yet.",
  'auth/admin-restricted-operation': "Two-step verification isn't turned on for this app yet.",
  'auth/popup-blocked': 'Your browser blocked the Google sign-in window. Allow pop-ups for this site and try again.',
  'auth/account-exists-with-different-credential': 'This email already has an account. Sign in with your password, then add Google from Settings.',
  'auth/credential-already-in-use': 'That Google account is already used by another Dividends account.',
};

/** A readable message for Firebase errors (auth codes, callable function errors). */
export function cloudMessage(e: unknown): string {
  const err = e as { code?: string; message?: string };
  if (err.code && AUTH_MESSAGES[err.code]) return AUTH_MESSAGES[err.code];
  // An unreachable server or a crash comes back as a bare "internal".
  if (err.code === 'functions/internal' && /^\s*internal\s*$/i.test(err.message ?? '')) return "Couldn't reach the server. Check your connection and try again.";
  if (err.code === 'functions/unavailable') return "Couldn't reach the server. Check your connection and try again.";
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

  const toUser = (u: { uid: string; email: string | null; emailVerified: boolean; providerData: { providerId: string }[] } | null): CloudUser | null =>
    u ? { uid: u.uid, email: u.email, emailVerified: u.emailVerified, providers: u.providerData.map((p) => p.providerId) } : null;
  const google = () => { const p = new A.GoogleAuthProvider(); p.setCustomParameters({ prompt: 'select_account' }); return p; };
  /** Turns "this account needs its second step" into a SecondStep; rethrows anything else. */
  const secondStep = (e: unknown): SecondStep => {
    if ((e as { code?: string }).code !== 'auth/multi-factor-auth-required') throw e;
    const resolver = A.getMultiFactorResolver(auth, e as Parameters<typeof A.getMultiFactorResolver>[1]);
    const hint = resolver.hints.find((h) => h.factorId === A.TotpMultiFactorGenerator.FACTOR_ID);
    if (!hint) throw new Error('This account uses a kind of two-step verification this app doesn’t support.');
    return {
      finish: async (code: string) => {
        await resolver.resolveSignIn(A.TotpMultiFactorGenerator.assertionForSignIn(hint.uid, code.replace(/\s/g, '')));
      },
    };
  };
  const signedIn = async (p: Promise<unknown>): Promise<SecondStep | null> => {
    try { await p; return null; } catch (e) { return secondStep(e); }
  };
  // Back from a Google sign-in done by redirect (installed apps, blocked pop-ups).
  const redirect = signedIn(A.getRedirectResult(auth));

  return {
    onAuth: (cb: (u: CloudUser | null) => void) => A.onAuthStateChanged(auth, (u) => cb(toUser(u))),
    /** Resolves null when signed in, or a SecondStep when the account has two-step verification. */
    signIn: (email: string, password: string) => signedIn(A.signInWithEmailAndPassword(auth, email.trim(), password)),
    signInWithGoogle: async (): Promise<SecondStep | null> => {
      // Installed home-screen apps can't open pop-ups reliably; go by redirect there.
      const installed = matchMedia('(display-mode: standalone)').matches || (navigator as { standalone?: boolean }).standalone === true;
      if (installed) { await A.signInWithRedirect(auth, google()); return null; }
      try {
        await A.signInWithPopup(auth, google());
        return null;
      } catch (e) {
        const code = (e as { code?: string }).code;
        if (code === 'auth/popup-closed-by-user' || code === 'auth/cancelled-popup-request') return null;
        if (code === 'auth/popup-blocked') { await A.signInWithRedirect(auth, google()); return null; }
        return secondStep(e);
      }
    },
    /** The result of a Google redirect sign-in, if the page just came back from one. */
    redirectResult: () => redirect,
    signUp: async (email: string, password: string) => {
      const cred = await A.createUserWithEmailAndPassword(auth, email.trim(), password);
      await A.sendEmailVerification(cred.user).catch(() => {});
    },
    resetPassword: (email: string) => A.sendPasswordResetEmail(auth, email.trim()),
    signOut: () => A.signOut(auth),
    linkGoogle: async () => {
      const u = auth.currentUser;
      if (!u) throw new Error('Sign in first.');
      await A.linkWithPopup(u, google());
      await u.reload();
    },
    /** Starts setting up an authenticator app. Needs a verified email and a recent sign-in. */
    startTotp: async (): Promise<TotpSetup> => {
      const u = auth.currentUser;
      if (!u) throw new Error('Sign in first.');
      const session = await A.multiFactor(u).getSession();
      const secret = await A.TotpMultiFactorGenerator.generateSecret(session);
      return {
        secretKey: secret.secretKey,
        url: secret.generateQrCodeUrl(u.email ?? 'Dividends', 'Dividends'),
        finish: async (code: string) => {
          await A.multiFactor(u).enroll(A.TotpMultiFactorGenerator.assertionForEnrollment(secret, code.replace(/\s/g, '')), 'Authenticator app');
        },
      };
    },
    totpEnrolled: () => {
      const u = auth.currentUser;
      return !!u && A.multiFactor(u).enrolledFactors.some((f) => f.factorId === A.TotpMultiFactorGenerator.FACTOR_ID);
    },
    removeTotp: async () => {
      const u = auth.currentUser;
      if (!u) throw new Error('Sign in first.');
      for (const f of A.multiFactor(u).enrolledFactors) await A.multiFactor(u).unenroll(f);
    },
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
