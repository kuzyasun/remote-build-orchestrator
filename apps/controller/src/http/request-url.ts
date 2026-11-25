/** Parse origin-form request targets without trusting the Host header. */
export function parseRequestUrl(target: string | undefined): URL | null {
  if (!target?.startsWith('/') || target.startsWith('//') || target.startsWith('/\\')) {
    return null;
  }
  try {
    const base = 'http://localhost';
    const url = new URL(target, base);
    return url.origin === base ? url : null;
  } catch {
    return null;
  }
}
