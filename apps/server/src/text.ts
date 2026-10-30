// Small string helpers for values from requests. Loops instead of `/\/+$/`: a pattern that is anchored only at the end is
// tried at every position, which is quadratic on a long run of slashes followed by something else (CodeQL
// js/polynomial-redos on admin settings).

/** Without slashes at the end (with `start`: also at the beginning). */
export function trimSlashes(s: string, start = false): string {
  let a = 0;
  let b = s.length;
  if (start) while (a < b && s[a] === '/') a++;
  while (b > a && s[b - 1] === '/') b--;
  return s.slice(a, b);
}
