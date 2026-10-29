// Loading parts of the app later (code-004). No React and no texts here: main.tsx needs it before the app is there.

/** Loads once and keeps the result – but not a failure: the next call tries again (a moment without network). */
export function retryable<T>(load: () => Promise<T>): () => Promise<T> {
  let loading: Promise<T> | null = null;
  return () =>
    (loading ??= load().catch((err: unknown) => {
      loading = null;
      throw err;
    }));
}

/**
 * A tab opened before an update asks for files the new build no longer has: on the first failure the page loads
 * the current app once (never settles); a second failure in a row is passed on. `key` marks the reload in this tab.
 */
export function reloadingOnce<T>(key: string, loading: Promise<T>): Promise<T> {
  return loading.then(
    (value) => {
      try {
        sessionStorage.removeItem(key);
      } catch {
        // the browser keeps nothing – nothing to forget
      }
      return value;
    },
    (err: unknown) => {
      try {
        if (sessionStorage.getItem(key)) throw err;
        sessionStorage.setItem(key, '1');
      } catch {
        // Already reloaded – or the browser keeps nothing, so a reload could not tell and might loop.
        throw err;
      }
      location.reload();
      return new Promise<never>(() => undefined);
    },
  );
}
