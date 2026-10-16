import { File, FileBraces, FileCode, FileCog, FileImage, FileLock, FileTerminal, FileText, Folder, FolderOpen, type LucideIcon } from 'lucide-react';
import { extension } from './lib/paths';

const byExtension: Record<string, LucideIcon> = {};
const assign = (icon: LucideIcon, exts: string[]) => exts.forEach((e) => (byExtension[e] = icon));
assign(FileCode, ['ts', 'tsx', 'js', 'jsx', 'mjs', 'cjs', 'rs', 'py', 'go', 'java', 'kt', 'c', 'h', 'cpp', 'hpp', 'cc', 'cs', 'swift', 'rb', 'php', 'lua', 'dart', 'scala', 'vue', 'svelte', 'html', 'css', 'scss', 'less', 'sql', 'zig']);
assign(FileBraces, ['json', 'jsonc', 'json5']);
assign(FileText, ['md', 'mdx', 'txt', 'rst', 'adoc']);
assign(FileCog, ['toml', 'yaml', 'yml', 'ini', 'cfg', 'conf', 'env', 'editorconfig', 'xml']);
assign(FileTerminal, ['sh', 'bash', 'zsh', 'ps1', 'bat', 'cmd', 'fish']);
assign(FileImage, ['png', 'jpg', 'jpeg', 'gif', 'svg', 'webp', 'ico', 'bmp', 'avif']);
assign(FileLock, ['lock']);

const byName: Record<string, LucideIcon> = {
  '.gitignore': FileCog,
  '.gitattributes': FileCog,
  '.npmrc': FileCog,
  '.prettierrc': FileCog,
  dockerfile: FileCog,
  makefile: FileTerminal,
  license: FileText,
};

/** A quiet icon for a file or folder, chosen by name and extension. */
export function FileIcon({ name, kind = 'file', open = false, size = 14, className }: { name: string; kind?: 'file' | 'dir'; open?: boolean; size?: number; className?: string }) {
  const Icon = kind === 'dir' ? (open ? FolderOpen : Folder) : (byName[name.toLowerCase()] ?? byExtension[extension(name)] ?? File);
  return <Icon size={size} className={className} aria-hidden strokeWidth={1.75} />;
}
