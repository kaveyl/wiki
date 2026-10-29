// What the shell needs of the AI without loading it (dialogs, editor actions): which dialog is open, the active
// note's editor, and whether a provider is set up. The dialogs themselves are in AiAssist.tsx, loaded on first use.
import { useQuery } from '@tanstack/react-query';
import type { Editor } from '@tiptap/react';
import { create } from 'zustand';
import { api, type AiAction, type AiScope } from '../api';

export interface Suggestion {
  action: AiAction;
  mountId: string;
  path: string;
  original: string;
  /** Selection range at request time and the document then (to detect later edits). */
  from: number;
  to: number;
  editor: Editor | null;
  docAtRequest: unknown;
  result: string | null;
  error: string | null;
  meta: string;
}

interface AiState {
  suggestion: Suggestion | null;
  ask: { scope: AiScope; chatId?: string } | null;
  /** The editor of the active note (header actions use it). */
  current: { editor: Editor; mountId: string; path: string } | null;
  setCurrent(c: AiState['current']): void;
  openAsk(scope: AiScope, chatId?: string): void;
  close(): void;
}

export const useAi = create<AiState>((set) => ({
  suggestion: null,
  ask: null,
  current: null,
  setCurrent: (current) => set({ current }),
  openAsk: (scope, chatId) => set({ ask: { scope, chatId } }),
  close: () => set({ suggestion: null, ask: null }),
}));

/** Whether any provider is set up (hides the AI UI otherwise). */
export function useAiAvailable() {
  return (useQuery({ queryKey: ['ai-providers'], queryFn: api.aiProviders, staleTime: 60_000 }).data?.providers.length ?? 0) > 0;
}
