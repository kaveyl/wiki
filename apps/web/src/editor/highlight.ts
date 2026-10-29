// Syntax highlighting for code blocks (view only — the Markdown keeps its fence): lowlight's
// common languages plus a few admin/ops favourites, and language detection for blocks without one.
import { common, createLowlight } from 'lowlight';
import apache from 'highlight.js/lib/languages/apache';
import dockerfile from 'highlight.js/lib/languages/dockerfile';
import nginx from 'highlight.js/lib/languages/nginx';
import powershell from 'highlight.js/lib/languages/powershell';

export const lowlight = createLowlight(common);
lowlight.register({ apache, dockerfile, nginx, powershell });

/** Offered in the toolbar (all highlighted; `mermaid` renders a diagram, `toml` uses ini). */
export const CODE_LANGUAGES = [
  'apache', 'bash', 'c', 'cpp', 'csharp', 'css', 'diff', 'dockerfile', 'go', 'ini', 'java', 'javascript', 'json', 'kotlin', 'lua', 'makefile',
  'markdown', 'mermaid', 'nginx', 'perl', 'php', 'powershell', 'python', 'ruby', 'rust', 'shell', 'sql', 'swift', 'toml', 'typescript', 'xml', 'yaml',
];

// Detection candidates: languages that are easy to confuse with prose or each other stay out.
const DETECT = CODE_LANGUAGES.filter((l) => !['mermaid', 'markdown', 'toml', 'shell', 'diff', 'makefile'].includes(l));
let last: { code: string; lang: string | null } = { code: '', lang: null };

/** Most likely language of a code block without one, or null when the guess is weak. */
export function detectLanguage(code: string): string | null {
  if (code === last.code) return last.lang;
  let lang: string | null = null;
  if (code.trim().length >= 12) {
    const r = lowlight.highlightAuto(code, { subset: DETECT });
    const relevance = (r.data as { relevance?: number } | undefined)?.relevance ?? 0;
    // Several lines of real code score 2+ (bash install lines: 2, docker-compose: 4, prose: 0); one line needs more.
    const needed = code.trim().includes('\n') ? 2 : 5;
    lang = relevance >= needed ? ((r.data as { language?: string } | undefined)?.language ?? null) : null;
  }
  last = { code, lang };
  return lang;
}
