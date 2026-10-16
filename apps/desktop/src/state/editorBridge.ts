// The contract between the editor and the AI features. The editor publishes
// what is open and selected; chat and agents read it and can ask the editor
// to open a file or reveal a line.

import { create } from 'zustand';
import type { Mention } from '../bindings/Mention';

export interface EditorSelection {
  path: string;
  /** 1-based, inclusive. */
  startLine: number;
  endLine: number;
  text: string;
  language: string;
}

export interface OpenRequest {
  path: string;
  line?: number;
  /** Move keyboard focus into the editor (default: focus stays where it is). */
  focus?: boolean;
  /** Increments so that opening the same file twice still triggers. */
  seq: number;
}

interface EditorBridge {
  activePath: string | null;
  openPaths: string[];
  dirtyPaths: string[];
  selection: EditorSelection | null;
  openRequest: OpenRequest | null;
  /** Mentions the chat should add to its composer (e.g. "Add selection to chat"). */
  pendingMentions: Mention[];

  setActive(path: string | null): void;
  setOpenPaths(paths: string[]): void;
  setDirtyPaths(paths: string[]): void;
  setSelection(selection: EditorSelection | null): void;
  /** Asks the editor to open `path` (and reveal `line`). */
  open(path: string, line?: number, options?: { focus?: boolean }): void;
  /** Hands mentions to the chat composer. */
  sendToChat(mentions: Mention[]): void;
  takePendingMentions(): Mention[];
}

export const useEditorBridge = create<EditorBridge>((set, get) => ({
  activePath: null,
  openPaths: [],
  dirtyPaths: [],
  selection: null,
  openRequest: null,
  pendingMentions: [],
  setActive: (activePath) => set({ activePath }),
  setOpenPaths: (openPaths) => set({ openPaths }),
  setDirtyPaths: (dirtyPaths) => set({ dirtyPaths }),
  setSelection: (selection) => set({ selection }),
  open: (path, line, options) => set({ openRequest: { path, line, focus: options?.focus, seq: (get().openRequest?.seq ?? 0) + 1 } }),
  sendToChat: (mentions) => set({ pendingMentions: [...get().pendingMentions, ...mentions] }),
  takePendingMentions: () => {
    const m = get().pendingMentions;
    set({ pendingMentions: [] });
    return m;
  },
}));
