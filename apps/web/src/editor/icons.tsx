// Note icons in the frontmatter (readable everywhere):
//   `icon: lucide:rocket`  any Lucide icon — a common set ships in the main bundle, the rest
//                          loads with the full set on first use (lucide-all.ts)
//   `icon: emoji:📘` / `icon: 📘`
//   `icon: custom:<id>`    an uploaded image, global for all sources (AD-018)
import { useEffect, useState, type ComponentType, type ReactNode } from 'react';
import {
  Book, BookOpen, Bookmark, Briefcase, Bug, Calendar, Camera, CheckSquare, Cloud, Code2, Coffee, Compass, Cpu, Database, DollarSign, FileText, Flag, Flame, Folder,
  Gift, Globe, GraduationCap, Hammer, Heart, Home, Image, Inbox, Key, Lightbulb, Link, List, Lock, Mail, Map, MessageSquare, Music, Package, PenTool, Phone, Pin,
  Rocket, Server, Settings, Shield, ShoppingCart, Star, Tag, Target, Terminal, Users, Wrench, Zap, type LucideProps,
} from 'lucide-react';
import { cx } from '../ui';
import { t } from '../i18n';
import { retryable } from '../loading';

/** The "common" set (also the first page of the picker). Some keys are older aliases. */
export const LUCIDE_ICONS: Record<string, ComponentType<LucideProps>> = {
  book: Book, 'book-open': BookOpen, bookmark: Bookmark, briefcase: Briefcase, bug: Bug, calendar: Calendar, camera: Camera, 'check-square': CheckSquare,
  cloud: Cloud, code: Code2, coffee: Coffee, compass: Compass, cpu: Cpu, database: Database, dollar: DollarSign, file: FileText, flag: Flag, flame: Flame,
  folder: Folder, gift: Gift, globe: Globe, 'graduation-cap': GraduationCap, hammer: Hammer, heart: Heart, home: Home, image: Image, inbox: Inbox, key: Key,
  lightbulb: Lightbulb, link: Link, list: List, lock: Lock, mail: Mail, map: Map, message: MessageSquare, music: Music, package: Package, pen: PenTool,
  phone: Phone, pin: Pin, rocket: Rocket, server: Server, settings: Settings, shield: Shield, cart: ShoppingCart, star: Star, tag: Tag, target: Target,
  terminal: Terminal, users: Users, wrench: Wrench, zap: Zap,
};

type All = typeof import('./lucide-all');
let all: All | null = null;
export const loadAllIcons = retryable(() => import('./lucide-all').then((m) => (all = m)));

/** The full Lucide set, or null while it loads (re-renders once it is there). */
export function useAllIcons(load = true): All | null {
  const [m, setM] = useState(all);
  useEffect(() => {
    if (!m && load) void loadAllIcons().then(setM, () => undefined);
  }, [m, load]);
  return m;
}

export const customIconUrl = (id: string) => `/api/icons/${encodeURIComponent(id)}`;

/** Renders an icon value; `null` when there is none (or it cannot be shown), so callers pick a default. */
/** `fallback`: shown instead of an empty square when a Lucide name does not exist. */
export function IconGlyph({ icon, className, fallback }: { icon: string; className?: string; fallback?: ReactNode }) {
  if (icon.startsWith('lucide:')) return <LucideGlyph name={icon.slice(7)} className={className} fallback={fallback} />;
  if (icon.startsWith('custom:')) return <CustomGlyph id={icon.slice(7)} className={className} />;
  const emoji = icon.replace(/^emoji:/, '');
  return <span className={cx('w-4 shrink-0 text-center text-[0.8125rem] leading-none', className)}>{emoji}</span>;
}

function LucideGlyph({ name, className, fallback }: { name: string; className?: string; fallback?: ReactNode }) {
  const common = LUCIDE_ICONS[name];
  const full = useAllIcons(!common);
  const Icon = common ?? (full ? full.icons[full.pascal(name) as keyof All['icons']] : null);
  // Same footprint while loading or for an unknown name: no jumping rows.
  if (!Icon) return full && fallback ? fallback : <span className={cx('inline-block h-4 w-4 shrink-0', className)} />;
  return <Icon className={cx('h-4 w-4 shrink-0 text-fg-muted', className)} />;
}

function CustomGlyph({ id, className }: { id: string; className?: string }) {
  const [broken, setBroken] = useState(false);
  if (broken) return <span className={cx('inline-block h-4 w-4 shrink-0 rounded-sm border border-dashed border-line', className)} title={t('Icon nicht mehr vorhanden')} />;
  return <img src={customIconUrl(id)} alt="" draggable={false} onError={() => setBroken(true)} className={cx('h-4 w-4 shrink-0 object-contain', className)} />;
}
