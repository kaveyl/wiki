// Unit tests check the German texts, like the E2E suite (locale de-DE): the interface follows the browser
// language (AD-046), and Node reports the system's (often en-US).
Object.defineProperty(globalThis, 'navigator', { value: { language: 'de-DE', languages: ['de-DE'] }, configurable: true });

// Server: scripts and accounts without a language get English (owner 2026-10-22); the tests expect the German texts.
const { setFallbackLang } = await import('./apps/server/src/i18n/index.ts');
setFallbackLang('de');
