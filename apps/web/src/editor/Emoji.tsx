// Emoji: picker in the toolbar and ":"-autocomplete (":haken" → ✅). The file stores the Unicode
// character itself, never a :shortcode: (readable in Gitea/VS Code). SEE-DOC: docs/PLAN.md §3a
import { Extension, type Editor } from '@tiptap/react';
import Suggestion, { type SuggestionProps } from '@tiptap/suggestion';
import { PluginKey } from '@tiptap/pm/state';
import * as Popover from '@radix-ui/react-popover';
import { forwardRef, useEffect, useImperativeHandle, useMemo, useState } from 'react';
import { Smile } from 'lucide-react';
import { PopoverContent, cx } from '../ui';
import { t } from '../i18n';
import { popupRenderer, type MenuHandle } from './SlashMenu';

/** [emoji, search words (German and English)] */
export const EMOJI: [string, string][] = [
  ['😀', 'lachen grinsen smile grin'], ['😂', 'tränen lachen joy'], ['🙂', 'lächeln slight smile'], ['😉', 'zwinkern wink'], ['😍', 'verliebt herz augen love'],
  ['🤔', 'nachdenken denken think'], ['😅', 'puh schwitzen sweat'], ['😎', 'cool sonnenbrille'], ['😢', 'traurig weinen sad cry'], ['😡', 'wütend sauer angry'],
  ['😱', 'schreck schock scream'], ['🙄', 'augenrollen eyeroll'], ['😴', 'schlafen müde sleep'], ['🤯', 'kopf explodiert mind blown'], ['🥳', 'party feiern'],
  ['👍', 'daumen hoch gut ok thumbsup'], ['👎', 'daumen runter schlecht thumbsdown'], ['👏', 'klatschen applaus clap'], ['🙏', 'bitte danke beten pray'], ['👋', 'winken hallo wave'],
  ['💪', 'stark muskel strong'], ['👀', 'augen schauen eyes'], ['🤝', 'handschlag deal handshake'], ['✌️', 'peace victory'], ['🫡', 'salut jawohl salute'],
  ['❤️', 'herz liebe heart love'], ['💔', 'gebrochenes herz broken'], ['⭐', 'stern star'], ['✨', 'funkeln sparkles neu'], ['🔥', 'feuer heiß fire hot'],
  ['💯', 'hundert perfekt 100'], ['✅', 'haken erledigt done check ok'], ['☑️', 'checkbox haken'], ['✔️', 'haken check'], ['❌', 'kreuz falsch nein cross x'],
  ['⚠️', 'warnung achtung warning'], ['⛔', 'verboten stop no entry'], ['🚫', 'verbot forbidden'], ['❗', 'ausrufezeichen wichtig exclamation'], ['❓', 'frage question'],
  ['ℹ️', 'info information hinweis'], ['💡', 'idee glühbirne idea'], ['📌', 'pin anheften wichtig'], ['📎', 'büroklammer anhang clip'], ['🔗', 'link verknüpfung'],
  ['📝', 'notiz schreiben memo'], ['📄', 'dokument seite page'], ['📁', 'ordner folder'], ['📂', 'ordner offen open folder'], ['🗂️', 'register index'],
  ['📅', 'kalender datum calendar'], ['🗓️', 'kalender plan'], ['⏰', 'wecker zeit alarm'], ['⏳', 'sanduhr warten hourglass'], ['🕒', 'uhr zeit clock'],
  ['📊', 'diagramm statistik chart'], ['📈', 'steigend wachstum up trend'], ['📉', 'fallend down trend'], ['📋', 'klemmbrett liste clipboard'], ['📦', 'paket package'],
  ['📧', 'email mail'], ['📞', 'telefon anruf phone'], ['💬', 'kommentar sprechblase chat'], ['📣', 'ankündigung megafon announce'], ['🔔', 'glocke benachrichtigung bell'],
  ['🔒', 'schloss gesperrt lock'], ['🔓', 'offen entsperrt unlock'], ['🔑', 'schlüssel key passwort'], ['🛡️', 'schild sicherheit shield security'], ['🐛', 'bug fehler käfer'],
  ['🛠️', 'werkzeug tools'], ['🔧', 'schraubenschlüssel wrench'], ['⚙️', 'einstellungen zahnrad settings gear'], ['🧪', 'test labor experiment'], ['🚀', 'rakete start launch rocket'],
  ['🎯', 'ziel target'], ['🏁', 'ziel flagge finish'], ['🚧', 'baustelle in arbeit wip construction'], ['♻️', 'recycling wiederholen'], ['🔄', 'aktualisieren sync refresh'],
  ['➡️', 'pfeil rechts arrow right'], ['⬅️', 'pfeil links arrow left'], ['⬆️', 'pfeil hoch up'], ['⬇️', 'pfeil runter down'], ['↩️', 'zurück return'],
  ['💻', 'laptop computer'], ['🖥️', 'bildschirm desktop'], ['📱', 'handy smartphone'], ['🖨️', 'drucker printer'], ['💾', 'speichern diskette save'],
  ['☁️', 'wolke cloud'], ['🐳', 'docker wal whale'], ['🐧', 'linux pinguin'], ['🤖', 'roboter ki bot ai'], ['🧠', 'gehirn denken brain'],
  ['🏠', 'haus home zuhause'], ['🏢', 'büro firma office'], ['🌍', 'welt erde globe'], ['✈️', 'flugzeug reise flight'], ['🚗', 'auto car'],
  ['💰', 'geld money'], ['💶', 'euro geld'], ['🧾', 'rechnung beleg receipt'], ['🛒', 'einkauf warenkorb cart'], ['🎁', 'geschenk gift'],
  ['☕', 'kaffee coffee'], ['🍕', 'pizza essen'], ['🍺', 'bier beer'], ['🎉', 'feier party tada'], ['🎵', 'musik music'],
  ['📷', 'kamera foto camera'], ['🎥', 'video film'], ['📚', 'bücher lernen books'], ['🎓', 'abschluss studium graduation'], ['✏️', 'stift bleistift pencil'],
  ['🟢', 'grün green ok'], ['🟡', 'gelb yellow'], ['🔴', 'rot red'], ['🔵', 'blau blue'], ['⚪', 'weiß white'],
];

export function findEmoji(query: string, limit = 8): [string, string][] {
  const q = query.toLowerCase();
  if (!q) return EMOJI.slice(0, limit);
  const starts = EMOJI.filter(([, k]) => k.split(' ').some((w) => w.startsWith(q)));
  const contains = EMOJI.filter(([, k]) => !starts.some(([, s]) => s === k) && k.includes(q));
  return [...starts, ...contains].slice(0, limit);
}

const EmojiList = forwardRef<MenuHandle, SuggestionProps<[string, string]>>(function EmojiList({ items, command }, ref) {
  const [active, setActive] = useState(0);
  useEffect(() => setActive(0), [items]);
  useImperativeHandle(ref, () => ({
    onKeyDown({ event }) {
      if (event.key === 'ArrowDown' || event.key === 'ArrowRight') {
        setActive((a) => (a + 1) % Math.max(1, items.length));
        return true;
      }
      if (event.key === 'ArrowUp' || event.key === 'ArrowLeft') {
        setActive((a) => (a - 1 + items.length) % Math.max(1, items.length));
        return true;
      }
      if (event.key === 'Enter' || event.key === 'Tab') {
        const item = items[active];
        if (item) command(item);
        return !!item;
      }
      return false;
    },
  }));
  if (!items.length) return null;
  return (
    <div className="flex gap-0.5 rounded-lg border border-line bg-bg p-1 shadow-pop" role="listbox" aria-label={t('Emoji')}>
      {items.map(([e, k], i) => (
        <button
          key={e}
          role="option"
          aria-selected={i === active}
          title={k.split(' ')[0]}
          className={cx('flex h-8 w-8 items-center justify-center rounded-md text-lg', i === active && 'bg-hover')}
          onMouseEnter={() => setActive(i)}
          onMouseDown={(ev) => {
            ev.preventDefault();
            command([e, k]);
          }}
        >
          {e}
        </button>
      ))}
    </div>
  );
});

export const EmojiSuggestion = Extension.create({
  name: 'emojiSuggestion',
  addProseMirrorPlugins() {
    return [
      Suggestion<[string, string]>({
        editor: this.editor,
        char: ':',
        pluginKey: new PluginKey('emojiSuggestion'),
        // Only after two letters, so "Uhrzeit: 10:30" or "Hinweis:" do not pop anything up.
        items: ({ query }) => (/^[\p{L}]{2,}$/u.test(query) ? findEmoji(query) : []),
        command: ({ editor, range, props }) => editor.chain().focus().deleteRange(range).insertContent(props[0]).run(),
        allow: ({ state, range }) => !state.doc.resolve(range.from).parent.type.spec.code,
        render: () => popupRenderer(EmojiList),
      }),
    ];
  },
});

export function EmojiButton({ editor }: { editor: Editor }) {
  const [open, setOpen] = useState(false);
  const [q, setQ] = useState('');
  const list = useMemo(() => findEmoji(q, EMOJI.length), [q]);
  return (
    <Popover.Root open={open} onOpenChange={(o) => (setOpen(o), setQ(''))}>
      <Popover.Trigger asChild>
        <button type="button" aria-label={t('Emoji einfügen')} title={t('Emoji einfügen (oder „:“ + Wort tippen)')} onMouseDown={(e) => e.preventDefault()} className="flex h-7 w-7 shrink-0 items-center justify-center rounded text-fg-muted hover:bg-hover hover:text-fg">
          <Smile className="h-4 w-4" />
        </button>
      </Popover.Trigger>
      <Popover.Portal>
        <PopoverContent align="start" sideOffset={4} className="z-50 w-80 p-2" onOpenAutoFocus={(e) => e.preventDefault()}>
          <input value={q} onChange={(e) => setQ(e.target.value)} placeholder={t('Suchen (z. B. haken, warnung, rakete)')} aria-label={t('Emoji suchen')} className="mb-2 h-7 w-full rounded border border-line bg-bg px-2 text-sm" />
          <div className="grid max-h-60 grid-cols-9 gap-0.5 overflow-y-auto">
            {list.map(([e, k]) => (
              <button
                key={e}
                title={k.split(' ')[0]}
                aria-label={t('Emoji {emoji}', { emoji: k.split(' ')[0]! })}
                className="flex h-8 w-8 items-center justify-center rounded text-lg hover:bg-hover"
                onClick={() => {
                  editor.chain().focus().insertContent(e).run();
                  setOpen(false);
                }}
              >
                {e}
              </button>
            ))}
          </div>
        </PopoverContent>
      </Popover.Portal>
    </Popover.Root>
  );
}
