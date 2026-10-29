// Whether a file from a backup is shown as text (comparison, preview) or offered as a download.
const TEXT = /\.(md|markdown|txt|ya?ml|json|csv|tsv|html?|css|js|ts|xml|svg|ini|toml|excalidraw|drawio|mmd)$/i;
const UTF8 = new TextDecoder('utf-8', { fatal: true });

export function isText(path: string, data: Buffer): boolean {
  if (data.length > 4 * 1024 * 1024) return false;
  if (!TEXT.test(path) && data.includes(0)) return false;
  try {
    UTF8.decode(data);
    return TEXT.test(path) || !data.includes(0);
  } catch {
    return false;
  }
}
