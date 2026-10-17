// Typed access to the Rust core. Every Tauri command and event used by the UI
// is declared here, so features never call `invoke` with raw strings.
//
// Outside Tauri (plain browser, e.g. `npm run dev` for design work) a mock
// backend with realistic data is used instead; see ./mock.ts.

import { Channel, invoke as tauriInvoke } from '@tauri-apps/api/core';
import { listen } from '@tauri-apps/api/event';
import type { AgentEvent } from '../bindings/AgentEvent';
import type { AppError } from '../bindings/AppError';
import type { AppInfo } from '../bindings/AppInfo';
import type { ApprovalResponse } from '../bindings/ApprovalResponse';
import type { ChatEvent } from '../bindings/ChatEvent';
import type { ChatSendRequest } from '../bindings/ChatSendRequest';
import type { ChatSummary } from '../bindings/ChatSummary';
import type { Checkpoint } from '../bindings/Checkpoint';
import type { ContextItem } from '../bindings/ContextItem';
import type { DownloadJob } from '../bindings/DownloadJob';
import type { FileNode } from '../bindings/FileNode';
import type { HardwareProfile } from '../bindings/HardwareProfile';
import type { InlineEditRequest } from '../bindings/InlineEditRequest';
import type { InlineEvent } from '../bindings/InlineEvent';
import type { InstalledModel } from '../bindings/InstalledModel';
import type { LastRun } from '../bindings/LastRun';
import type { Mention } from '../bindings/Mention';
import type { ModelSelection } from '../bindings/ModelSelection';
import type { NetworkLogEntry } from '../bindings/NetworkLogEntry';
import type { Recommendation } from '../bindings/Recommendation';
import type { RefreshOutcome } from '../bindings/RefreshOutcome';
import type { RegistryInfo } from '../bindings/RegistryInfo';
import type { RuntimeInstall } from '../bindings/RuntimeInstall';
import type { RuntimeStatus } from '../bindings/RuntimeStatus';
import type { SearchQuery } from '../bindings/SearchQuery';
import type { SearchResults } from '../bindings/SearchResults';
import type { ServerInfo } from '../bindings/ServerInfo';
import type { RepoListing } from '../bindings/RepoListing';
import type { Settings } from '../bindings/Settings';
import type { SkillContent } from '../bindings/SkillContent';
import type { SkillInfo } from '../bindings/SkillInfo';
import type { SkillUpdate } from '../bindings/SkillUpdate';
import type { StoredChat } from '../bindings/StoredChat';
import type { Symbol } from '../bindings/Symbol';
import type { TextFile } from '../bindings/TextFile';
import type { UpdateOutcome } from '../bindings/UpdateOutcome';
import type { UpdateProgress } from '../bindings/UpdateProgress';
import type { WorkspaceInfo } from '../bindings/WorkspaceInfo';
import { mockInvoke, mockListen } from './mock';

export const isTauri = typeof window !== 'undefined' && '__TAURI_INTERNALS__' in window;

/** Error thrown by every API call; `code` is translated via `common:errors.<code>`. */
export class IpcError extends Error {
  readonly code: string;
  readonly detail: string;
  constructor(error: AppError) {
    super(error.message);
    this.code = error.code;
    this.detail = error.message;
  }
}

function toIpcError(e: unknown): IpcError {
  if (e && typeof e === 'object' && 'code' in e && 'message' in e) return new IpcError(e as AppError);
  return new IpcError({ code: 'generic', message: String(e) });
}

async function call<T>(command: string, args?: Record<string, unknown>): Promise<T> {
  try {
    return isTauri ? await tauriInvoke<T>(command, args) : await mockInvoke<T>(command, args ?? {});
  } catch (e) {
    throw toIpcError(e);
  }
}

/** A streaming channel; in the browser mock the handler is called directly. */
function channel<T>(onEvent: (event: T) => void): Channel<T> | ((event: T) => void) {
  if (!isTauri) return onEvent;
  const ch = new Channel<T>();
  ch.onmessage = onEvent;
  return ch;
}

export const api = {
  appInfo: () => call<AppInfo>('app_info'),
  settings: {
    get: () => call<Settings>('settings_get'),
    defaults: () => call<Settings>('settings_defaults'),
    set: (settings: Settings) => call<Settings>('settings_set', { settings }),
  },
  networkLog: () => call<NetworkLogEntry[]>('network_log'),
  hardware: {
    probe: (force = false) => call<HardwareProfile>('hardware_probe', { force }),
  },
  registry: {
    info: () => call<RegistryInfo>('registry_info'),
    refresh: () => call<RefreshOutcome>('registry_refresh'),
  },
  updates: {
    /** Asks the update address for a newer version (`disabled` when switched off); the startup check is made once per start. */
    check: (startup = false) => call<UpdateOutcome>('update_check', { startup }),
    /** Downloads and verifies the update found by the last check. */
    download: (onProgress: (p: UpdateProgress) => void) => call<void>('update_download', { onProgress: channel(onProgress) }),
    /** Starts the downloaded installer, which closes Ylide and starts it again. */
    launch: () => call<void>('update_launch'),
  },
  recommend: () => call<Recommendation>('recommend'),
  models: {
    installed: () => call<InstalledModel[]>('models_installed'),
    downloads: () => call<DownloadJob[]>('downloads'),
    download: (modelId: string, quant: string) => call<DownloadJob>('model_download', { modelId, quant }),
    pause: (jobId: string) => call<void>('model_pause', { jobId }),
    cancel: (jobId: string) => call<void>('model_cancel', { jobId }),
    remove: (modelId: string, quant: string) => call<void>('model_delete', { modelId, quant }),
    import: (path: string) => call<InstalledModel>('model_import', { path }),
    /** Switches image input on: downloads the vision projector of a registry model. */
    downloadProjector: (modelId: string) => call<DownloadJob>('model_projector_download', { modelId }),
    /** A projector file the user picked, or null: image input off (a downloaded projector is deleted). */
    setProjector: (modelId: string, path: string | null) => call<InstalledModel[]>('model_projector_set', { modelId, path }),
  },
  images: {
    /** An image file the user picked, as a data URL (to be scaled down, see lib/images.ts). */
    load: (path: string) => call<string>('image_load', { path }),
  },
  runtime: {
    status: () => call<RuntimeStatus>('runtime_status'),
    install: (variant: string) => call<void>('runtime_install', { variant }),
  },
  server: {
    start: (selection?: ModelSelection) => call<ServerInfo>('server_start', { selection: selection ?? null }),
    stop: () => call<void>('server_stop'),
    info: () => call<ServerInfo | null>('server_info'),
    logs: () => call<string[]>('server_logs'),
  },
  workspace: {
    open: (path: string) => call<WorkspaceInfo>('workspace_open', { path }),
    current: () => call<WorkspaceInfo | null>('workspace_current'),
    close: () => call<void>('workspace_close'),
  },
  fs: {
    listDir: (path: string) => call<FileNode[]>('fs_list_dir', { path }),
    readFile: (path: string) => call<TextFile>('fs_read_file', { path }),
    writeFile: (path: string, content: string) => call<void>('fs_write_file', { path, content }),
    create: (path: string, directory: boolean) => call<void>('fs_create', { path, directory }),
    rename: (from: string, to: string) => call<void>('fs_rename', { from, to }),
    remove: (path: string) => call<void>('fs_delete', { path }),
    search: (query: SearchQuery) => call<SearchResults>('fs_search', { query }),
    findFiles: (query: string, limit = 50) => call<string[]>('fs_find_files', { query, limit }),
    /** The given paths that name existing project files, normalized to forward slashes. */
    exists: (paths: string[]) => call<string[]>('fs_exists', { paths }),
    findSymbols: (query: string, limit = 50) => call<Symbol[]>('fs_find_symbols', { query, limit }),
    contextPreview: (mentions: Mention[]) => call<ContextItem[]>('context_preview', { mentions }),
  },
  chat: {
    send: (request: ChatSendRequest, onEvent: (e: ChatEvent) => void) =>
      call<void>('chat_send', { request, onEvent: channel(onEvent) }),
    /** Cancels a chat or inline-edit request by its id. */
    cancel: (id: string) => call<void>('request_cancel', { id }),
  },
  /** Saved chats of a project (its root as WorkspaceInfo has it, or null), on this computer only. */
  chats: {
    list: (project: string | null) => call<ChatSummary[]>('chats_list', { project }),
    load: (project: string | null, id: string) => call<StoredChat>('chat_load', { project, id }),
    /** Returns null while saving is switched off. */
    save: (project: string | null, chat: StoredChat) => call<ChatSummary | null>('chat_save', { project, chat }),
    remove: (project: string | null, id: string) => call<void>('chat_delete', { project, id }),
    /** Deletes the saved chats of every project. */
    removeAll: () => call<void>('chats_delete_all'),
  },
  inline: {
    edit: (request: InlineEditRequest, onEvent: (e: InlineEvent) => void) =>
      call<void>('inline_edit', { request, onEvent: channel(onEvent) }),
  },
  /** Skills: installed ones work with every model; the open project's own are switched per project. */
  skills: {
    list: () => call<SkillInfo[]>('skills_list'),
    /** Switches a skill on or off (`id` from SkillInfo); returns the new list. */
    setEnabled: (id: string, enabled: boolean) => call<SkillInfo[]>('skills_set_enabled', { id, enabled }),
    remove: (name: string) => call<SkillInfo[]>('skills_remove', { name }),
    /** SKILL.md in full and the skill's files. */
    content: (id: string) => call<SkillContent>('skills_content', { id }),
    /** Lists the skills of a GitHub repository (needs the skill-download permission). */
    browse: (address: string) => call<RepoListing>('skills_browse', { address }),
    /** Installs folders of the listed repository at its commit, switched off. */
    installGithub: (repo: string, gitRef: string | null, commit: string, paths: string[]) => call<SkillInfo[]>('skills_install_github', { repo, gitRef, commit, paths }),
    /** Copies the skills of a folder on this computer, switched off. */
    installFolder: (path: string) => call<SkillInfo[]>('skills_install_folder', { path }),
    /** What a newer version would change. */
    checkUpdate: (name: string) => call<SkillUpdate>('skills_check_update', { name }),
    /** Installs the version checkUpdate showed (its commit; empty for folders). */
    update: (name: string, commit: string) => call<SkillInfo>('skills_update', { name, commit }),
  },
  agents: {
    /** With `previousRun`, the new run continues that finished run; `images` (data URLs) go with the request. */
    start: (goal: string, onEvent: (e: AgentEvent) => void, previousRun: string | null = null, images: string[] = []) =>
      call<string>('agent_start', { goal, images, previousRun, onEvent: channel(onEvent) }),
    approve: (runId: string, requestId: string, response: ApprovalResponse) =>
      call<boolean>('agent_approve', { runId, requestId, response }),
    answer: (runId: string, questionId: string, answer: string) => call<boolean>('agent_answer', { runId, questionId, answer }),
    control: (runId: string, action: 'pause' | 'resume' | 'cancel') => call<void>('agent_control', { runId, action }),
    intervene: (runId: string, agentId: string, text: string) => call<void>('agent_intervene', { runId, agentId, text }),
    /** The open project's last run, kept across restarts. */
    lastRun: () => call<LastRun | null>('agent_last_run'),
    checkpoints: (runId: string) => call<Checkpoint[]>('checkpoints_list', { runId }),
    restore: (runId: string, checkpointId: string) => call<string[]>('checkpoint_restore', { runId, checkpointId }),
  },
};

/** Events pushed by the core. */
export interface EventMap {
  'models://job': DownloadJob;
  'runtime://server': ServerInfo | null;
  'runtime://install': RuntimeInstall;
  'runtime://log': string;
  'fs://changed': string[];
  'network://log': NetworkLogEntry;
  'registry://updated': string;
}

/** Subscribes to a core event; returns the unsubscribe function. */
export async function onEvent<K extends keyof EventMap>(name: K, handler: (payload: EventMap[K]) => void): Promise<() => void> {
  if (!isTauri) return mockListen(name, handler as (payload: unknown) => void);
  return listen<EventMap[K]>(name, (e) => handler(e.payload));
}

/** Opens the native folder picker. */
export async function pickFolder(): Promise<string | null> {
  if (!isTauri) return 'D:/projects/demo';
  const { open } = await import('@tauri-apps/plugin-dialog');
  const result = await open({ directory: true, multiple: false });
  return typeof result === 'string' ? result : null;
}

/** Opens the native file picker for GGUF models. */
export async function pickGguf(): Promise<string | null> {
  if (!isTauri) return 'D:/models/my-finetune-Q4_K_M.gguf';
  const { open } = await import('@tauri-apps/plugin-dialog');
  const result = await open({ multiple: false, filters: [{ name: 'GGUF', extensions: ['gguf'] }] });
  return typeof result === 'string' ? result : null;
}

/** Opens the native file picker for images (chat and agent requests). */
export async function pickImages(): Promise<string[]> {
  if (!isTauri) return ['D:/projects/demo/docs/screenshot.png'];
  const { open } = await import('@tauri-apps/plugin-dialog');
  const result = await open({ multiple: true, filters: [{ name: 'Images', extensions: ['png', 'jpg', 'jpeg', 'webp', 'gif'] }] });
  return Array.isArray(result) ? result : typeof result === 'string' ? [result] : [];
}

/** Opens the native file picker for a vision projector (mmproj GGUF) of an imported model. */
export async function pickProjector(): Promise<string | null> {
  if (!isTauri) return 'D:/models/mmproj-my-finetune-F16.gguf';
  const { open } = await import('@tauri-apps/plugin-dialog');
  const result = await open({ multiple: false, filters: [{ name: 'GGUF', extensions: ['gguf'] }] });
  return typeof result === 'string' ? result : null;
}

/** Opens a URL in the system browser (licenses, model cards). */
export async function openExternal(url: string): Promise<void> {
  if (!isTauri) {
    window.open(url, '_blank', 'noopener');
    return;
  }
  const { openUrl } = await import('@tauri-apps/plugin-opener');
  await openUrl(url);
}
