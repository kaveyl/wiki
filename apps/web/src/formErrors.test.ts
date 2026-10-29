// Form errors (design-006): what is wrong with a field shows at the field (marked invalid, described by the
// message, announced); what is wrong with the whole form is announced too – never a silent red line.
import { readdirSync, readFileSync } from 'node:fs';
import { join, relative, resolve } from 'node:path';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
// The parser Vite builds with (rolldown, oxc) – no extra dependency, as in i18n/moduleLevel.test.ts.
import { parseSync } from 'rolldown/utils';
import { describe, expect, it } from 'vitest';
import { Field, FormError, FormStatus, Input } from './ui';

const src = resolve(import.meta.dirname);
function sources(dir: string): string[] {
  return readdirSync(dir, { withFileTypes: true }).flatMap((e) => {
    const p = join(dir, e.name);
    if (e.isDirectory()) return sources(p);
    return /\.tsx$/.test(e.name) ? [p] : [];
  });
}

describe('form errors', () => {
  it('a field with an error is invalid, described by error and hint, and the error is announced', () => {
    const html = renderToStaticMarkup(createElement(Field, { label: 'Adresse', hint: 'Hinweis', error: 'Falsch', children: createElement(Input, { value: '', readOnly: true }) }));
    const input = html.match(/<input [^>]*>/)![0];
    expect(input).toContain('aria-invalid="true"');
    const ids = /aria-describedby="([^"]+)"/.exec(input)![1]!.split(' ');
    expect(ids).toHaveLength(2);
    const error = new RegExp(`<span id="${ids[0]}" role="alert"[^>]*>Falsch</span>`);
    expect(html).toMatch(error);
    expect(html).toContain(`id="${ids[1]}"`);
  });

  it('a field without an error is not marked invalid; a render function gets the same attributes', () => {
    const plain = renderToStaticMarkup(createElement(Field, { label: 'Name', hint: 'Hinweis', children: createElement(Input, { value: '', readOnly: true }) }));
    expect(plain).not.toContain('aria-invalid');
    expect(plain).not.toContain('role="alert"');
    const wrapped = renderToStaticMarkup(
      createElement(Field, { label: 'Name', error: 'Schon da', children: (a11y: object) => createElement('div', null, createElement(Input, { value: '', readOnly: true, ...a11y }), '.md') }),
    );
    expect(wrapped.match(/<input [^>]*>/)![0]).toContain('aria-invalid="true"');
  });

  it('FormError renders nothing without a message and an alert with one; FormStatus is a live status', () => {
    expect(renderToStaticMarkup(createElement(FormError, null, ''))).toBe('');
    expect(renderToStaticMarkup(createElement(FormError, null, 'Fehler'))).toMatch(/^<p role="alert"[^>]*>Fehler<\/p>$/);
    expect(renderToStaticMarkup(createElement(FormStatus, null, false))).toMatch(/^<span role="status"/);
  });

  it('no silent red error lines are left: messages go through Field, FormError or carry role="alert"', () => {
    expect(sources(src).flatMap((file) => silentLines(readFileSync(file, 'utf8'), relative(src, file)))).toEqual([]);
  });

  it('the check finds red lines in any form, and leaves announced ones, controls, icons and marked badges alone', () => {
    const found = (code: string) => silentLines(code, 'x.tsx').length;
    expect(found('const a = x && <p className="text-sm text-danger">{e}</p>;')).toBe(1);
    expect(found('function A() { if (x) return <p className="text-sm text-danger">{errorText(e)}</p>; }')).toBe(1);
    expect(found('const a = <ul>{x && <li className="text-danger">\n{t("Fehler")}\n</li>}</ul>;')).toBe(1);
    expect(found('const a = <div className={cx("flex text-danger", b)}>Fehler</div>;')).toBe(1);
    expect(found('const a = <p role="alert" className="text-danger">{e}</p>;')).toBe(0);
    expect(found('const a = <span className="text-danger" role="status">{e}</span>;')).toBe(0);
    expect(found('const a = <p role="alert"><span className="text-danger">{e}</span></p>;')).toBe(0);
    expect(found('const a = <><Button className="text-danger">X</Button><button className="text-danger">X</button><Trash2 className="text-danger" /></>;')).toBe(0);
    expect(found('const a = <span className={cx("text-xs", bad && "text-danger")}>{s}</span>;')).toBe(0);
    expect(found('const a = <button className="hover:text-danger">X</button>;')).toBe(0);
    expect(found('const a = <>{/* a count, not a message */ n > 0 && <span className="text-danger">{n}</span>}</>;')).toBe(0);
  });
});

type Node = { type: string; start: number; [k: string]: unknown };
type Attr = { type: string; name?: { name?: string }; value?: { type: string; value?: unknown; expression?: Node } | null };
// Elements a user acts on are red for a dangerous action, not for a message.
const CONTROLS = new Set(['button', 'a', 'input', 'select', 'textarea', 'option']);
const ANNOUNCED = new Set(['alert', 'status']);
const DANGER = /(^|\s)text-danger(\s|$)/;

/** Class names an element always has (literal className, or literal arguments of cx(); not `ok ? … : 'text-danger'`). */
function fixedClasses(attr: Attr | undefined): string {
  const v = attr?.value;
  if (!v) return '';
  if (v.type === 'Literal') return String(v.value);
  const e = v.expression;
  if (e?.type === 'Literal') return String(e.value);
  if (e?.type === 'TemplateLiteral') return (e.quasis as { value: { raw: string } }[]).map((q) => q.value.raw).join(' ');
  if (e?.type === 'CallExpression') return (e.arguments as Node[]).filter((a) => a.type === 'Literal').map((a) => String(a.value)).join(' ');
  return '';
}

/**
 * Elements that are always red and show text or a value, but are neither announced (role alert/status, also on an
 * ancestor) nor inside FormError/Field. A red badge or count says so with a „not a message“ comment just before it.
 */
function silentLines(code: string, name: string): string[] {
  const found: string[] = [];
  const visit = (node: unknown, announced: boolean) => {
    if (!node || typeof node !== 'object') return;
    if (Array.isArray(node)) return node.forEach((n) => visit(n, announced));
    const n = node as Node;
    let inner = announced;
    if (n.type === 'JSXElement') {
      const open = n.openingElement as { name: { type: string; name?: string }; attributes: Attr[] };
      const tag = open.name.type === 'JSXIdentifier' ? open.name.name! : '';
      const attr = (key: string) => open.attributes.find((a) => a.type === 'JSXAttribute' && a.name?.name === key);
      const role = attr('role')?.value;
      inner ||= tag === 'FormError' || tag === 'Field' || (role?.type === 'Literal' && ANNOUNCED.has(String(role.value)));
      const shows = (n.children as Node[]).some((c) => (c.type === 'JSXText' ? String(c.value).trim() !== '' : !(c.type === 'JSXExpressionContainer' && (c.expression as Node).type === 'JSXEmptyExpression')));
      const lineStart = code.lastIndexOf('\n', code.lastIndexOf('\n', n.start - 1) - 1) + 1;
      const marked = /not a message/.test(code.slice(lineStart, n.start));
      if (!inner && /^[a-z]/.test(tag) && !CONTROLS.has(tag) && shows && DANGER.test(fixedClasses(attr('className'))) && !marked)
        found.push(`${name}:${code.slice(0, n.start).split('\n').length}`);
    }
    for (const [k, v] of Object.entries(n)) if (k !== 'parent' && v && typeof v === 'object') visit(v, inner);
  };
  visit(parseSync(name, code).program, false);
  return found;
}
