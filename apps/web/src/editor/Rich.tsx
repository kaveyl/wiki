// Rendered blocks in the editor: KaTeX math (`$…$`, `$$…$$`) and Mermaid diagrams (```mermaid).
// Both libraries are large and loaded only when a note uses them. The file keeps the source.
import { NodeViewContent, NodeViewWrapper, ReactNodeViewRenderer, type NodeViewProps } from '@tiptap/react';
import CodeBlockLowlight from '@tiptap/extension-code-block-lowlight';
import { MathBlock, MathInline } from '@kaveyl-wiki/core';
import { useEffect, useId, useState } from 'react';
import { errorText } from '../api';
import { cx, promptDialog } from '../ui';
import { t } from '../i18n';
import { retryable } from '../loading';

const loadKatex = retryable(() => Promise.all([import('katex'), import('katex/dist/katex.min.css')]).then(([m]) => m.default));

/**
 * Diagram colours in the app's palette instead of Mermaid's defaults (pure blue, lemon, lime; a near-white first chart
 * line). Strong colours carry white text. The last step is a light one with dark text on purpose: Mermaid's timeline
 * draws its axis in that step's text colour – dark on a light page, light on a dark one.
 */
function diagramColors(dark: boolean): Record<string, unknown> {
  const strong = ['#6366f1', '#0d9488', '#f97362', '#d97706', '#db2777', '#0284c7', '#7c3aed', '#16a34a', '#e11d48', '#0891b2', '#ca8a04'];
  const vars: Record<string, unknown> = {
    pieSectionTextColor: '#ffffff',
    pieStrokeColor: dark ? '#18172a' : '#ffffff',
    pieStrokeWidth: '2px',
    pieOuterStrokeWidth: '0px',
    pieOpacity: '1',
    xyChart: { plotColorPalette: '#6366f1, #f97362, #14b8a6, #f59e0b, #ec4899, #0ea5e9' },
  };
  strong.forEach((c, i) => {
    vars[`cScale${i}`] = c;
    vars[`cScaleLabel${i}`] = '#ffffff';
    if (i < 8) {
      vars[`git${i}`] = c;
      vars[`gitBranchLabel${i}`] = '#ffffff';
    }
  });
  ['#6366f1', '#14b8a6', '#f97362', '#f59e0b', '#ec4899', '#0ea5e9', '#8b5cf6', '#22c55e'].forEach((c, i) => (vars[`pie${i + 1}`] = c));
  vars.cScale11 = dark ? '#3730a3' : '#c7d2fe';
  vars.cScaleLabel11 = dark ? '#e0e7ff' : '#1e1b3a';
  return vars;
}

const loadMermaid = retryable(() =>
  import('mermaid').then((m) => {
    // `strict`: no HTML labels or click handlers from diagram text (it comes from repositories). Layout `dagre`: Mermaid 12
    // lays flowcharts out with ELK by default, which is left out of the build (licence, AD-064 – vendor/elk-stub.ts).
    const dark = document.documentElement.classList.contains('dark');
    m.default.initialize({ startOnLoad: false, securityLevel: 'strict', layout: 'dagre', theme: dark ? 'dark' : 'default', themeVariables: diagramColors(dark) });
    return m.default;
  }),
);

function useKatex(latex: string, display: boolean): { html: string | null; error: string | null } {
  const [out, setOut] = useState<{ html: string | null; error: string | null }>({ html: null, error: null });
  useEffect(() => {
    let alive = true;
    void loadKatex().then(
      (katex) => {
        if (!alive) return;
        try {
          setOut({ html: katex.renderToString(latex, { displayMode: display, throwOnError: true, trust: false }), error: null });
        } catch (e) {
          setOut({ html: null, error: errorText(e) });
        }
      },
      () => alive && setOut({ html: null, error: t('Dieser Teil der App konnte nicht geladen werden. Bitte die Seite neu laden.') }),
    );
    return () => {
      alive = false;
    };
  }, [latex, display]);
  return out;
}

async function editLatex(props: NodeViewProps) {
  if (!props.editor.isEditable) return;
  const next = await promptDialog(t('Formel bearbeiten'), {
    label: t('LaTeX'),
    value: String(props.node.attrs.latex ?? ''),
    mono: true,
    hint: t('Leer lassen entfernt die Formel.'),
    confirmLabel: t('Übernehmen'),
    help: 'bearbeiten',
  });
  if (next === null) return;
  if (!next.trim()) props.deleteNode();
  else props.updateAttributes({ latex: next });
}

function MathBlockView(props: NodeViewProps) {
  const latex = String(props.node.attrs.latex ?? '');
  const { html, error } = useKatex(latex, true);
  return (
    <NodeViewWrapper className={cx('math-block', props.selected && 'is-selected')} data-math-block="" onDoubleClick={() => void editLatex(props)} title={t('Doppelklick: Formel bearbeiten')}>
      {html ? <div dangerouslySetInnerHTML={{ __html: html }} /> : <code className={error ? 'text-danger' : undefined}>{error ? `${error}\n${latex}` : latex}</code>}
    </NodeViewWrapper>
  );
}

function MathInlineView(props: NodeViewProps) {
  const latex = String(props.node.attrs.latex ?? '');
  const { html, error } = useKatex(latex, false);
  return (
    <NodeViewWrapper as="span" className={cx('math-inline', props.selected && 'is-selected')} data-math-inline="" onDoubleClick={() => void editLatex(props)} title={error ?? t('Doppelklick: Formel bearbeiten')}>
      {html ? <span dangerouslySetInnerHTML={{ __html: html }} /> : <code className={error ? 'text-danger' : undefined}>{latex}</code>}
    </NodeViewWrapper>
  );
}

export const MathBlockView_ = MathBlock.extend({ addNodeView: () => ReactNodeViewRenderer(MathBlockView) });
export const MathInlineView_ = MathInline.extend({ addNodeView: () => ReactNodeViewRenderer(MathInlineView) });
/** Name of a task list checkbox for screen readers, in the app's language (instead of Tiptap's English one). */
export const taskCheckboxLabel = (text: string) => (text ? t('Aufgabe: {text}', { text }) : t('Leere Aufgabe'));

function MermaidPreview({ code }: { code: string }) {
  const id = useId().replace(/[^a-zA-Z0-9]/g, '');
  const [svg, setSvg] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  useEffect(() => {
    let alive = true;
    const timer = setTimeout(() => {
      void loadMermaid()
        .then((mermaid) => mermaid.render(`mermaid-${id}-${Date.now()}`, code))
        .then((r) => alive && (setSvg(r.svg), setError(null)))
        .catch((e: unknown) => alive && setError(errorText(e).split('\n')[0]!));
    }, 300);
    return () => {
      alive = false;
      clearTimeout(timer);
    };
  }, [code, id]);
  return (
    <div className="mermaid-preview" contentEditable={false} aria-label={t('Diagramm-Vorschau')}>
      {error ? /* the diagram's own preview while typing, not a message */ <p className="text-xs text-danger">{t('Diagramm-Fehler: {error}', { error })}</p> : svg ? <div dangerouslySetInnerHTML={{ __html: svg }} /> : <p className="text-xs text-fg-faint">{t('Diagramm wird gezeichnet …')}</p>}
    </div>
  );
}

function CodeBlockView(props: NodeViewProps) {
  const language = (props.node.attrs.language as string | null) ?? null;
  return (
    <NodeViewWrapper className="code-block">
      <pre>
        <NodeViewContent<'code'> as="code" className={language ? `language-${language}` : undefined} />
      </pre>
      {language === 'mermaid' && <MermaidPreview code={props.node.textContent} />}
    </NodeViewWrapper>
  );
}

/** The highlighting code block with a Mermaid preview below ```mermaid blocks. */
export function codeBlockWithPreview(lowlight: Parameters<typeof CodeBlockLowlight.configure>[0] extends infer O ? O : never) {
  return CodeBlockLowlight.extend({ addNodeView: () => ReactNodeViewRenderer(CodeBlockView) }).configure(lowlight);
}
