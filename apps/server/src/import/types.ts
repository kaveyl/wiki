// The shape every import format fills (docs/PLAN-IMPORT.md): a converter only turns the export's files into notes and
// files with their wished names; safe names, links between them and the report are done once for all (build.ts).
import type { SourceFile } from './zip.js';

/** A note as the converter made it. `from` = its path in the export (links in other notes point there). */
export interface DraftNote {
  from: string;
  /** Folder inside the import, as named in the export (made safe later). */
  dir: string[];
  /**
   * Where each folder of `dir` comes from in the export, when folders are named after titles (Trilium, Wiki.js): two
   * folders of the same name from different places stay apart („Projekt“, „Projekt 2“).
   */
  dirKeys?: string[];
  /** File name without `.md`, as the program showed it (made safe later). */
  name: string;
  content: string;
  /** More names `[[…]]` links may use for it (Logseq: the full page name with namespace, aliases, journal titles). */
  names?: string[];
  /** The note is the page of the folder `dir` (Trilium: a note with text and children) – written as the folder note. */
  folderPage?: boolean;
  /**
   * The converter already set every link it could resolve by the program's own rules to the export path (Wiki.js): the
   * shared step follows links only to exactly that path, never by its own guesses (`x` → `x.md`, folder pages).
   */
  exactLinks?: boolean;
}

export interface DraftFile {
  from: string;
  dir: string[];
  /**
   * Where each folder of `dir` comes from in the export, when folders are named after titles (Trilium, Wiki.js): two
   * folders of the same name from different places stay apart („Projekt“, „Projekt 2“).
   */
  dirKeys?: string[];
  name: string;
  source: SourceFile;
}

/** A hint for the preview and the report: a finished German sentence; `notes` = export paths of the notes concerned. */
export interface DraftWarning {
  text: string;
  notes?: string[];
  items?: string[];
}

export interface Draft {
  notes: DraftNote[];
  files: DraftFile[];
  warnings: DraftWarning[];
  /** `[[Name]]` links are this program's way of linking: turn them into Markdown links. */
  wikiLinks?: boolean;
  /** Files the export only links to on the old server (full URL as written in the notes, export paths of the notes). */
  remote?: RemotePicture[];
  /** `remote` was fetched: what is left there could not be fetched. */
  remoteTried?: boolean;
}

export interface RemotePicture {
  url: string;
  notes: string[];
  /** A better file name than the server's (the picture's text), without extension. */
  title?: string;
}

export type FormatId = 'hedgedoc' | 'joplin' | 'logseq' | 'silverbullet' | 'obsidian' | 'trilium' | 'wikijs' | 'outline' | 'markdown';

export interface ImportFormat {
  id: FormatId;
  label: string;
  /** How sure the export is of this format: 0 = not at all; the highest wins. */
  detect(files: SourceFile[]): Promise<number>;
  convert(files: SourceFile[]): Promise<Draft>;
}

/** Notes of the finished import, paths inside the new folder. */
export interface PlannedNote {
  path: string;
  content: string;
}

export interface PlannedFile {
  path: string;
  source: SourceFile;
}

export interface Warning {
  text: string;
  /** Final paths of the notes concerned (links in the report) or plain names. */
  notes: string[];
  items: string[];
  /** The pictures still on the old server – the preview shows them as the „fetch“ choice instead. */
  remote?: boolean;
}

export interface Plan {
  notes: PlannedNote[];
  files: PlannedFile[];
  folders: number;
  warnings: Warning[];
  /** Pictures still on the old server and the servers they are on (the preview offers to fetch them). */
  remote: { count: number; servers: string[] };
}
