// What the Markdown worker does (pool.ts): plain functions of @kaveyl-wiki/core, the same in the worker and in the process.
import { extractLinks, loadMarkdown, parseMarkdown, saveMarkdown, type LocalLink, type PMNode } from '@kaveyl-wiki/core';
import type { Root } from 'mdast';

export type Job = { op: 'links'; raw: string } | { op: 'doc'; raw: string } | { op: 'save'; raw: string; doc: PMNode } | { op: 'tree'; body: string };

export interface JobResult {
  links: LocalLink[];
  doc: PMNode;
  save: string;
  tree: Root;
}

export function runJob(job: Job): JobResult[Job['op']] {
  switch (job.op) {
    case 'links':
      return extractLinks(job.raw);
    case 'doc':
      return loadMarkdown(job.raw).doc;
    case 'save':
      return saveMarkdown(loadMarkdown(job.raw).source, job.doc);
    case 'tree':
      return parseMarkdown(job.body);
  }
}
