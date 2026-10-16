// Project files in the sidebar: a lazily loaded tree with keyboard
// navigation, inline create and rename, delete with confirmation and a
// context menu. Opens files through the editor bridge.

import { ChevronRight, ChevronsDownUp, Copy, FilePlus, FolderOpen, FolderPlus, MessageSquarePlus, Pencil, RefreshCw, Trash2 } from 'lucide-react';
import { useCallback, useEffect, useMemo, useRef, useState, type MouseEvent as ReactMouseEvent } from 'react';
import { useTranslation } from 'react-i18next';
import { Dialog } from '../../components/Dialog';
import { Button, IconButton, SectionHeader, Spinner } from '../../components/ui';
import { errorText, reportError } from '../../lib/errors';
import { api, IpcError, pickFolder } from '../../lib/ipc';
import { useApp } from '../../state/app';
import { useEditorBridge } from '../../state/editorBridge';
import { useLayout } from '../../state/layout';
import { useToasts } from '../../state/toasts';
import type { FileNode } from '../../bindings/FileNode';
import { ContextMenu, type MenuEntry } from './ContextMenu';
import { FileIcon } from './FileIcon';
import s from './FileTreePanel.module.css';
import { dirname, joinPath, validateName } from './lib/paths';
import { parentIndex, visibleRows, type TreeRow } from './lib/tree';
import { NameInput } from './NameInput';
import { pathMoved, pathRemoved, requestEditorFocus } from './pathEvents';
import { collapseAll, forget, loadDir, refreshAll, reveal, setExpanded, setFocused, toggleExpanded, useTree, wireTree } from './treeStore';

type Editing = { kind: 'create'; parent: string; dir: boolean } | { kind: 'rename'; node: FileNode };

type Display = { type: 'node'; row: TreeRow } | { type: 'create'; depth: number; dir: boolean };

const INDENT = 12;
const rowId = (path: string) => `tree-row-${encodeURIComponent(path)}`;

export function FileTreePanel() {
  const { t } = useTranslation('editor');
  const workspace = useApp((st) => st.workspace);
  const openWorkspace = useApp((st) => st.openWorkspace);
  const [editing, setEditing] = useState<Editing | null>(null);

  useEffect(wireTree, []);

  if (!workspace) {
    return (
      <div className={s.panel}>
        <SectionHeader title={t('tree.title')} />
        <div className={s.message}>
          <p>{t('tree.noProject')}</p>
          <Button
            size="sm"
            variant="secondary"
            icon={<FolderOpen size={14} />}
            onClick={() =>
              void pickFolder()
                .then((path) => (path ? openWorkspace(path) : undefined))
                .catch((e: unknown) => reportError(e, t('errors.openFolder')))
            }
          >
            {t('common:actions.openFolder')}
          </Button>
        </div>
      </div>
    );
  }

  const startCreate = (dir: boolean) => {
    const { focused, children } = useTree.getState();
    const focusedNode = focused ? findNode(children, focused) : null;
    const parent = !focusedNode ? '' : focusedNode.kind === 'dir' ? focusedNode.path : dirname(focusedNode.path);
    if (parent) setExpanded(parent, true);
    setEditing({ kind: 'create', parent, dir });
  };

  return (
    <div className={s.panel}>
      <SectionHeader
        title={workspace.name}
        actions={
          <>
            <IconButton label={t('tree.newFile')} onClick={() => startCreate(false)}>
              <FilePlus size={15} />
            </IconButton>
            <IconButton label={t('tree.newFolder')} onClick={() => startCreate(true)}>
              <FolderPlus size={15} />
            </IconButton>
            <IconButton label={t('tree.collapseAll')} onClick={collapseAll}>
              <ChevronsDownUp size={15} />
            </IconButton>
            <IconButton label={t('tree.refresh')} onClick={() => void refreshAll()}>
              <RefreshCw size={14} />
            </IconButton>
          </>
        }
      />
      <TreeView key={workspace.root} projectName={workspace.name} editing={editing} setEditing={setEditing} />
    </div>
  );
}

function findNode(children: Record<string, FileNode[] | undefined>, path: string): FileNode | null {
  return children[dirname(path)]?.find((n) => n.path === path) ?? null;
}

interface TreeViewProps {
  projectName: string;
  editing: Editing | null;
  setEditing(e: Editing | null): void;
}

function TreeView({ projectName, editing, setEditing }: TreeViewProps) {
  const { t } = useTranslation('editor');
  const children = useTree((st) => st.children);
  const expanded = useTree((st) => st.expanded);
  const loading = useTree((st) => st.loading);
  const rootError = useTree((st) => st.rootError);
  const focused = useTree((st) => st.focused);
  const activePath = useEditorBridge((st) => st.activePath);
  const container = useRef<HTMLDivElement>(null);
  const [menu, setMenu] = useState<{ x: number; y: number; node: FileNode | null } | null>(null);
  const [confirmDelete, setConfirmDelete] = useState<FileNode | null>(null);
  const [editError, setEditError] = useState<string | null>(null);
  // Stable, so the dialog and the menu do not re-run their focus handling on every render.
  const closeMenu = useCallback(() => setMenu(null), []);
  const cancelDelete = useCallback(() => setConfirmDelete(null), []);

  useEffect(() => {
    if (!useTree.getState().children['']) void loadDir('');
  }, []);

  // Follow the active editor tab.
  useEffect(() => {
    if (activePath) void reveal(activePath);
  }, [activePath]);

  useEffect(() => {
    if (focused) document.getElementById(rowId(focused))?.scrollIntoView({ block: 'nearest' });
  }, [focused]);

  const rows = useMemo(() => visibleRows(children, expanded), [children, expanded]);

  const display = useMemo<Display[]>(() => {
    const list: Display[] = rows.map((row) => ({ type: 'node', row }));
    if (editing?.kind === 'create') {
      const parentAt = editing.parent ? rows.findIndex((r) => r.node.path === editing.parent) : -1;
      const depth = parentAt >= 0 ? rows[parentAt].depth + 1 : 0;
      list.splice(parentAt + 1, 0, { type: 'create', depth, dir: editing.dir });
    }
    return list;
  }, [rows, editing]);

  const open = (node: FileNode, takeFocus: boolean) => {
    setFocused(node.path);
    if (node.kind === 'dir') {
      toggleExpanded(node.path);
      return;
    }
    if (takeFocus) requestEditorFocus();
    useEditorBridge.getState().open(node.path);
  };

  const finishEditing = useCallback(() => {
    setEditing(null);
    setEditError(null);
    container.current?.focus();
  }, [setEditing]);

  const nameProblem = (name: string) => {
    const problem = validateName(name);
    return problem ? t(`tree.nameProblem.${problem}`) : null;
  };

  const failure = (e: unknown) => (e instanceof IpcError && e.code === 'exists' ? t('tree.exists') : errorText(e));

  const commitCreate = async (parent: string, dir: boolean, name: string): Promise<boolean> => {
    const problem = nameProblem(name);
    if (problem) {
      setEditError(problem);
      return false;
    }
    const path = joinPath(parent, name.trim());
    try {
      await api.fs.create(path, dir);
    } catch (e) {
      setEditError(failure(e));
      return false;
    }
    finishEditing();
    await loadDir(parent);
    await reveal(path);
    if (!dir) {
      requestEditorFocus();
      useEditorBridge.getState().open(path);
    }
    return true;
  };

  const commitRename = async (node: FileNode, name: string): Promise<boolean> => {
    const problem = nameProblem(name);
    if (problem) {
      setEditError(problem);
      return false;
    }
    const to = joinPath(dirname(node.path), name.trim());
    if (to === node.path) {
      finishEditing();
      return true;
    }
    const wasOpen = !!useTree.getState().expanded[node.path];
    try {
      await api.fs.rename(node.path, to);
    } catch (e) {
      setEditError(failure(e));
      return false;
    }
    finishEditing();
    pathMoved(node.path, to);
    forget(node.path);
    await loadDir(dirname(node.path));
    if (dirname(to) !== dirname(node.path)) await loadDir(dirname(to));
    await reveal(to);
    if (wasOpen) setExpanded(to, true);
    return true;
  };

  const remove = async (node: FileNode) => {
    setConfirmDelete(null);
    const rowsNow = visibleRows(useTree.getState().children, useTree.getState().expanded);
    const index = rowsNow.findIndex((r) => r.node.path === node.path);
    const neighbour = rowsNow[index + 1]?.depth === rowsNow[index]?.depth ? rowsNow[index + 1] : rowsNow[index - 1];
    try {
      await api.fs.remove(node.path);
    } catch (e) {
      reportError(e, t('errors.delete', { name: node.name }));
      return;
    }
    pathRemoved(node.path);
    forget(node.path);
    await loadDir(dirname(node.path));
    setFocused(neighbour && neighbour.node.path !== node.path ? neighbour.node.path : null);
    container.current?.focus();
  };

  const addToChat = (node: FileNode | null) => {
    const path = node?.path ?? '';
    useEditorBridge.getState().sendToChat([node && node.kind === 'file' ? { type: 'file', path } : { type: 'folder', path }]);
    useLayout.getState().setRight('chat');
  };

  const copyPath = (path: string) => {
    navigator.clipboard
      .writeText(path)
      .then(() => useToasts.getState().push({ tone: 'neutral', title: t('common:actions.copied'), body: path }))
      .catch((e: unknown) => reportError(e));
  };

  const menuItems = (node: FileNode | null): MenuEntry[] => {
    const inFolder = node ? (node.kind === 'dir' ? node.path : dirname(node.path)) : '';
    const create = (dir: boolean) => () => {
      if (inFolder) setExpanded(inFolder, true);
      setEditing({ kind: 'create', parent: inFolder, dir });
    };
    const items: MenuEntry[] = [
      { id: 'newFile', label: t('tree.newFile'), icon: <FilePlus size={14} />, onSelect: create(false) },
      { id: 'newFolder', label: t('tree.newFolder'), icon: <FolderPlus size={14} />, onSelect: create(true) },
    ];
    if (node) {
      items.push(
        'separator',
        { id: 'rename', label: t('tree.rename'), icon: <Pencil size={14} />, shortcut: 'F2', onSelect: () => setEditing({ kind: 'rename', node }) },
        { id: 'delete', label: t('tree.delete'), icon: <Trash2 size={14} />, shortcut: t('tree.deleteKey'), danger: true, onSelect: () => setConfirmDelete(node) },
      );
    }
    items.push('separator', { id: 'chat', label: t('tree.addToChat'), icon: <MessageSquarePlus size={14} />, onSelect: () => addToChat(node) });
    if (node) items.push({ id: 'copy', label: t('tree.copyPath'), icon: <Copy size={14} />, onSelect: () => copyPath(node.path) });
    return items;
  };

  const openMenu = (e: ReactMouseEvent, node: FileNode | null) => {
    e.preventDefault();
    e.stopPropagation();
    if (node) setFocused(node.path);
    setMenu({ x: e.clientX, y: e.clientY, node });
  };

  const onKeyDown = (e: React.KeyboardEvent<HTMLDivElement>) => {
    if (editing) return;
    const index = rows.findIndex((r) => r.node.path === focused);
    const row = rows[index];
    const focusAt = (i: number) => rows[i] && setFocused(rows[i].node.path);
    switch (e.key) {
      case 'ArrowDown':
        focusAt(index < 0 ? 0 : Math.min(rows.length - 1, index + 1));
        break;
      case 'ArrowUp':
        focusAt(index < 0 ? 0 : Math.max(0, index - 1));
        break;
      case 'Home':
        focusAt(0);
        break;
      case 'End':
        focusAt(rows.length - 1);
        break;
      case 'ArrowRight':
        if (row?.node.kind !== 'dir') return;
        if (!expanded[row.node.path]) setExpanded(row.node.path, true);
        else if ((rows[index + 1]?.depth ?? -1) > row.depth) focusAt(index + 1);
        break;
      case 'ArrowLeft':
        if (!row) return;
        if (row.node.kind === 'dir' && expanded[row.node.path]) setExpanded(row.node.path, false);
        else focusAt(parentIndex(rows, index));
        break;
      case 'Enter':
        if (row) open(row.node, true);
        break;
      case ' ':
        if (row) open(row.node, false);
        break;
      case 'F2':
        if (row) setEditing({ kind: 'rename', node: row.node });
        break;
      case 'Delete':
        if (row) setConfirmDelete(row.node);
        break;
      case 'ContextMenu': {
        const rect = row && document.getElementById(rowId(row.node.path))?.getBoundingClientRect();
        setMenu({ x: rect ? rect.left + 24 : 40, y: rect ? rect.bottom : 40, node: row?.node ?? null });
        break;
      }
      default:
        if (e.key === 'F10' && e.shiftKey) {
          const rect = row && document.getElementById(rowId(row.node.path))?.getBoundingClientRect();
          setMenu({ x: rect ? rect.left + 24 : 40, y: rect ? rect.bottom : 40, node: row?.node ?? null });
          break;
        }
        return;
    }
    e.preventDefault();
  };

  const rootLoading = !children[''] && loading[''];

  return (
    <>
      <div
        ref={container}
        className={s.tree}
        role="tree"
        aria-label={t('tree.label', { name: projectName })}
        tabIndex={0}
        aria-activedescendant={focused ? rowId(focused) : undefined}
        data-preserve-focus
        onKeyDown={onKeyDown}
        onFocus={(e) => {
          if (e.target === e.currentTarget && !focused && rows[0]) setFocused(rows[0].node.path);
        }}
        onContextMenu={(e) => openMenu(e, null)}
      >
        {rootLoading && (
          <div className={s.message}>
            <Spinner label={t('tree.loading')} />
          </div>
        )}
        {rootError && (
          <div className={s.message} role="alert">
            <p>{rootError}</p>
            <Button size="sm" variant="secondary" onClick={() => void loadDir('')}>
              {t('common:actions.retry')}
            </Button>
          </div>
        )}
        {children['']?.length === 0 && !editing && <p className={s.message}>{t('tree.empty')}</p>}
        {display.map((item) =>
          item.type === 'create' ? (
            <div key="__create" className={s.row} style={{ paddingLeft: 8 + item.depth * INDENT }} role="none">
              <Guides depth={item.depth} />
              <span className={s.chevronSpace} />
              <FileIcon name="" kind={item.dir ? 'dir' : 'file'} className={s.icon} />
              <NameInput
                initial=""
                label={item.dir ? t('tree.newFolderName') : t('tree.newFileName')}
                error={editError}
                onChange={() => setEditError(null)}
                onCancel={finishEditing}
                onCommit={(name) => commitCreate(editing?.kind === 'create' ? editing.parent : '', item.dir, name)}
              />
            </div>
          ) : (
            <Row
              key={item.row.node.path}
              row={item.row}
              expanded={!!expanded[item.row.node.path]}
              loading={!!loading[item.row.node.path]}
              focused={focused === item.row.node.path}
              active={activePath === item.row.node.path}
              renaming={editing?.kind === 'rename' && editing.node.path === item.row.node.path}
              renameError={editError}
              onClick={() => open(item.row.node, false)}
              onDoubleClick={() => item.row.node.kind === 'file' && open(item.row.node, true)}
              onContextMenu={(e) => openMenu(e, item.row.node)}
              onRename={(name) => commitRename(item.row.node, name)}
              onRenameCancel={finishEditing}
              onRenameChange={() => setEditError(null)}
            />
          ),
        )}
        <div className={s.spacer} onClick={() => setFocused(null)} />
      </div>
      {menu && <ContextMenu x={menu.x} y={menu.y} label={t('tree.menuLabel')} items={menuItems(menu.node)} onClose={closeMenu} />}
      <Dialog
        open={confirmDelete !== null}
        title={t('tree.deleteTitle', { name: confirmDelete?.name ?? '' })}
        onClose={cancelDelete}
        width={420}
        footer={
          <>
            <Button variant="secondary" onClick={cancelDelete} data-autofocus>
              {t('common:actions.cancel')}
            </Button>
            <Button variant="danger" icon={<Trash2 size={14} />} onClick={() => confirmDelete && void remove(confirmDelete)}>
              {t('common:actions.delete')}
            </Button>
          </>
        }
      >
        {confirmDelete?.kind === 'dir' ? t('tree.deleteFolderBody', { path: confirmDelete.path }) : t('tree.deleteFileBody', { path: confirmDelete?.path ?? '' })}
      </Dialog>
    </>
  );
}

function Guides({ depth }: { depth: number }) {
  return (
    <>
      {Array.from({ length: depth }, (_, i) => (
        <span key={i} className={s.guide} style={{ left: 8 + i * INDENT + 7 }} aria-hidden />
      ))}
    </>
  );
}

interface RowProps {
  row: TreeRow;
  expanded: boolean;
  loading: boolean;
  focused: boolean;
  active: boolean;
  renaming: boolean;
  renameError: string | null;
  onClick(): void;
  onDoubleClick(): void;
  onContextMenu(e: ReactMouseEvent): void;
  onRename(name: string): Promise<boolean>;
  onRenameCancel(): void;
  onRenameChange(): void;
}

function Row({ row, expanded, loading, focused, active, renaming, renameError, onClick, onDoubleClick, onContextMenu, onRename, onRenameCancel, onRenameChange }: RowProps) {
  const { t } = useTranslation('editor');
  const { node, depth } = row;
  const isDir = node.kind === 'dir';
  return (
    <div
      id={rowId(node.path)}
      role="treeitem"
      aria-level={depth + 1}
      aria-expanded={isDir ? expanded : undefined}
      aria-selected={focused}
      aria-current={active ? 'page' : undefined}
      className={[s.row, focused && s.focused, active && s.active].filter(Boolean).join(' ')}
      style={{ paddingLeft: 8 + depth * INDENT }}
      title={node.path}
      onClick={onClick}
      onDoubleClick={onDoubleClick}
      onContextMenu={onContextMenu}
    >
      <Guides depth={depth} />
      {isDir ? (
        loading ? (
          <span className={s.chevronSpace}>
            <Spinner />
          </span>
        ) : (
          <ChevronRight size={14} className={`${s.chevron} ${expanded ? s.open : ''}`} aria-hidden />
        )
      ) : (
        <span className={s.chevronSpace} />
      )}
      <FileIcon name={node.name} kind={node.kind} open={expanded} className={s.icon} />
      {renaming ? (
        <NameInput initial={node.name} label={t('tree.renameLabel', { name: node.name })} error={renameError} onCommit={onRename} onCancel={onRenameCancel} onChange={onRenameChange} />
      ) : (
        <span className={s.name}>{node.name}</span>
      )}
    </div>
  );
}
