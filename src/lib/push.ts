// Web push: subscribes this browser through the service worker and hands the subscription to the server.
// On iPhone and iPad, push only works once the app is added to the Home Screen (iOS 16.4 or later).

type Call = <T>(name: string, data?: unknown) => Promise<T>;

export const pushSupported = () => 'serviceWorker' in navigator && 'PushManager' in window && 'Notification' in window;
export const isIos = () => /iPhone|iPad|iPod/.test(navigator.userAgent) || (navigator.platform === 'MacIntel' && navigator.maxTouchPoints > 1);
export const isStandalone = () => matchMedia('(display-mode: standalone)').matches || (navigator as { standalone?: boolean }).standalone === true;

function keyBytes(base64url: string): Uint8Array<ArrayBuffer> {
  const b64 = (base64url + '='.repeat((4 - (base64url.length % 4)) % 4)).replace(/-/g, '+').replace(/_/g, '/');
  const raw = atob(b64);
  const out = new Uint8Array(new ArrayBuffer(raw.length));
  for (let i = 0; i < raw.length; i++) out[i] = raw.charCodeAt(i);
  return out;
}

async function registration(): Promise<ServiceWorkerRegistration> {
  // Development builds don't register the worker on load; do it here so push can still be tried.
  return (await navigator.serviceWorker.getRegistration()) ?? navigator.serviceWorker.register('./sw.js');
}

/** Asks permission, subscribes and saves the subscription. Throws a readable error otherwise. */
export async function enablePush(call: Call): Promise<void> {
  if (!pushSupported()) {
    throw new Error(isIos() && !isStandalone()
      ? 'On iPhone, add Dividends to your Home Screen first (Share → Add to Home Screen), then turn this on from there.'
      : "This browser doesn't support notifications.");
  }
  const { publicKey } = await call<{ publicKey: string | null }>('pushKey');
  if (!publicKey) throw new Error("Push notifications aren't set up on the server yet.");
  const permission = await Notification.requestPermission();
  if (permission !== 'granted') throw new Error('Notifications are blocked. Allow them for this site in your browser settings.');
  const reg = await registration();
  await navigator.serviceWorker.ready;
  const existing = await reg.pushManager.getSubscription();
  const sub = existing ?? await reg.pushManager.subscribe({ userVisibleOnly: true, applicationServerKey: keyBytes(publicKey) });
  await call('savePush', { subscription: sub.toJSON() });
}

/** Unsubscribes this browser. */
export async function disablePush(call: Call): Promise<void> {
  if (!pushSupported()) return;
  const reg = await navigator.serviceWorker.getRegistration();
  const sub = await reg?.pushManager.getSubscription();
  if (!sub) return;
  await call('removePush', { endpoint: sub.endpoint }).catch(() => {});
  await sub.unsubscribe();
}

/** Whether this browser is currently subscribed. */
export async function pushActive(): Promise<boolean> {
  if (!pushSupported()) return false;
  const reg = await navigator.serviceWorker.getRegistration();
  return !!(await reg?.pushManager.getSubscription());
}
