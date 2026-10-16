// Assistant answers as Markdown (GFM). Raw HTML is never rendered, images are
// never loaded (that would be a network request), links open in the system
// browser, and project paths become "open in editor" links once the answer
// is complete.

import type { Element, ElementContent } from 'hast';
import { FileCode } from 'lucide-react';
import { createContext, memo, useContext, useMemo, type MouseEvent, type ReactNode } from 'react';
import { useTranslation } from 'react-i18next';
import ReactMarkdown, { type Components } from 'react-markdown';
import remarkGfm from 'remark-gfm';
import { Button } from '../../components/ui';
import { reportError } from '../../lib/errors';
import { openExternal } from '../../lib/ipc';
import { useApp } from '../../state/app';
import { CopyButton } from './CopyButton';
import s from './Markdown.module.css';
import { basename } from './mentions';
import { codeBlockPath, parsePathRef } from './paths';
import { openInEditor, openSnippet, useResolvedPath } from './projectPaths';

interface MarkdownEnv {
  source: string;
  /** False while the answer streams: links to files are resolved only afterwards. */
  settled: boolean;
  root: string | null;
}

const Env = createContext<MarkdownEnv>({ source: '', settled: false, root: null });

function textOf(node: ElementContent): string {
  if (node.type === 'text') return node.value;
  if (node.type === 'element') return node.children.map(textOf).join('');
  return '';
}

function languageOf(code: Element): string | null {
  const cls = code.properties.className;
  const list: string[] = Array.isArray(cls) ? cls.map(String) : String(cls ?? '').split(' ');
  return list.find((c) => c.startsWith('language-'))?.slice('language-'.length) ?? null;
}

function CodeBlock({ node }: { node?: Element }) {
  const { t } = useTranslation('chat');
  const { source, settled, root } = useContext(Env);
  const codeEl = node?.children.find((c): c is Element => c.type === 'element' && c.tagName === 'code');
  // mdast-util-to-hast ends every block with a newline; it is not part of the code.
  const code = codeEl ? textOf(codeEl).replace(/\n$/, '') : '';
  const language = codeEl ? languageOf(codeEl) : null;
  const offset = node?.position?.start.offset;
  const ref = settled && offset !== undefined ? codeBlockPath(source, offset, code, root) : null;
  const path = useResolvedPath(ref, settled);

  return (
    <figure className={s.code}>
      <figcaption className={s.codeHeader}>
        <span className={s.codeLanguage}>{language ?? t('code.plain')}</span>
        <span className={s.grow} />
        {path && (
          <Button variant="ghost" size="sm" icon={<FileCode size={13} />} onClick={() => void openSnippet(path, code)} title={t('code.openTitle', { path })}>
            {t('code.open', { name: basename(path) })}
          </Button>
        )}
        <CopyButton text={code} label={t('code.copy')} />
      </figcaption>
      <pre className={s.codeBody} tabIndex={0}>
        <code>{code}</code>
      </pre>
    </figure>
  );
}

function InlineCode({ children }: { children?: ReactNode }) {
  const { t } = useTranslation('chat');
  const { settled, root } = useContext(Env);
  const text = typeof children === 'string' ? children : '';
  const ref = settled && text ? parsePathRef(text, root) : null;
  const path = useResolvedPath(ref, settled);
  if (!path) return <code className={s.inlineCode}>{children}</code>;
  return (
    <button type="button" className={s.pathLink} onClick={() => openInEditor(path, ref?.line)} title={t('code.openTitle', { path })}>
      <code className={s.inlineCode}>{children}</code>
    </button>
  );
}

const isExternal = (href: string) => /^(https?:|mailto:)/i.test(href);

function safeDecode(href: string): string {
  try {
    return decodeURIComponent(href);
  } catch {
    return href;
  }
}

function Link({ href, children }: { href?: string; children?: ReactNode }) {
  const { t } = useTranslation('chat');
  const { settled, root } = useContext(Env);
  const external = !!href && isExternal(href);
  const ref = settled && href && !external ? parsePathRef(safeDecode(href), root) : null;
  const path = useResolvedPath(ref, settled);

  if (href && external) {
    const open = (e: MouseEvent) => {
      e.preventDefault();
      openExternal(href).catch(reportError);
    };
    return (
      <a href={href} onClick={open} onAuxClick={open} title={t('markdown.openLink', { url: href })}>
        {children}
      </a>
    );
  }
  if (path) {
    return (
      <button type="button" className={s.textLink} onClick={() => openInEditor(path, ref?.line)} title={t('code.openTitle', { path })}>
        {children}
      </button>
    );
  }
  return <span className={s.plainLink}>{children}</span>;
}

function Image({ src, alt }: { src?: string | Blob; alt?: string }) {
  const { t } = useTranslation('chat');
  const url = typeof src === 'string' ? src : '';
  const label = t('markdown.image', { alt: alt || basename(url) || '?' });
  if (!isExternal(url)) return <span className={s.plainLink}>{label}</span>;
  const open = (e: MouseEvent) => {
    e.preventDefault();
    openExternal(url).catch(reportError);
  };
  return (
    <a
      href={url}
      title={t('markdown.imageTitle', { url })}
      onClick={open}
      onAuxClick={open}
    >
      {label}
    </a>
  );
}

function Table({ children }: { children?: ReactNode }) {
  return (
    <div className={s.tableWrap} tabIndex={0}>
      <table>{children}</table>
    </div>
  );
}

const components: Components = {
  pre: CodeBlock,
  code: InlineCode,
  a: Link,
  img: Image,
  table: Table,
};

const remarkPlugins = [remarkGfm];

export const Markdown = memo(function Markdown({ source, settled }: { source: string; settled: boolean }) {
  const root = useApp((st) => st.workspace?.root ?? null);
  const env = useMemo(() => ({ source, settled, root }), [source, settled, root]);
  return (
    <Env.Provider value={env}>
      <div className={s.prose}>
        <ReactMarkdown remarkPlugins={remarkPlugins} components={components} skipHtml>
          {source}
        </ReactMarkdown>
      </div>
    </Env.Provider>
  );
});
