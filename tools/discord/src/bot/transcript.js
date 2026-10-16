// Renders a ticket channel as one self-contained HTML file in the Ylide look.
// The file is only ever posted to Discord (team log, or privately to the
// person who asks for it); the bot does not keep a copy.

const escapeHtml = (s) => String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');

/** Collects the visible text of Components V2 messages (text displays, sections, buttons). */
export function componentText(components = []) {
  const parts = [];
  const walk = (list) => {
    for (const c of list ?? []) {
      if (c.type === 10 && c.content) parts.push(c.content);
      if (c.components) walk(c.components);
      if (c.accessory?.label) parts.push(`[${c.accessory.label}]`);
      if (c.type === 2 && c.label) parts.push(`[${c.label}]`);
    }
  };
  walk(components);
  return parts.join('\n');
}

/**
 * A small Markdown subset: code blocks, inline code, bold, italics, links,
 * mentions, custom emojis and timestamps. Everything is escaped first.
 */
export function renderMarkdown(source, names = {}) {
  const blocks = [];
  let s = String(source).replace(/```(?:[\w+-]*\n)?([\s\S]*?)```/g, (_, code) => {
    blocks.push(`<pre>${escapeHtml(code.replace(/\n$/, ''))}</pre>`);
    return `\u0000${blocks.length - 1}\u0000`;
  });
  s = escapeHtml(s)
    .replace(/`([^`\n]+)`/g, '<code>$1</code>')
    .replace(/\*\*([^*\n]+)\*\*/g, '<strong>$1</strong>')
    .replace(/(^|[^*])\*([^*\n]+)\*/g, '$1<em>$2</em>')
    .replace(/\[([^\]\n]+)\]\((https?:\/\/[^)\s]+)\)/g, '<a href="$2">$1</a>')
    .replace(/&lt;@!?(\d+)&gt;/g, (_, id) => `<span class="mention">@${escapeHtml(names.users?.[id] ?? id)}</span>`)
    .replace(/&lt;@&amp;(\d+)&gt;/g, (_, id) => `<span class="mention">@${escapeHtml(names.roles?.[id] ?? 'role')}</span>`)
    .replace(/&lt;#(\d+)&gt;/g, (_, id) => `<span class="mention">#${escapeHtml(names.channels?.[id] ?? id)}</span>`)
    .replace(/&lt;a?:(\w+):\d+&gt;/g, ':$1:')
    .replace(/&lt;t:(\d+)(?::\w)?&gt;/g, (_, t) => formatTime(Number(t) * 1000))
    .replace(/^-# (.*)$/gm, '<small>$1</small>')
    .replace(/^#{1,3} (.*)$/gm, '<strong>$1</strong>')
    .replace(/\n/g, '<br>');
  return s.replace(/\u0000(\d+)\u0000/g, (_, i) => blocks[Number(i)]);
}

export const formatTime = (ms) => new Date(ms).toISOString().replace('T', ' ').slice(0, 16) + ' UTC';

/**
 * messages: oldest first, each { author, bot, time, content, components, attachments: [{ name, url }] }
 * meta: { name, title, owner, opened, closed }
 */
export function renderTranscript(meta, messages, names = {}) {
  const rows = messages
    .map((m) => {
      const body = [m.content, componentText(m.components)].filter(Boolean).join('\n');
      const files = (m.attachments ?? []).map((a) => `<li><a href="${escapeHtml(a.url)}">${escapeHtml(a.name)}</a></li>`).join('');
      return `<article${m.bot ? ' class="bot"' : ''}>
  <header><b>${escapeHtml(m.author)}</b>${m.bot ? ' <span class="tag">bot</span>' : ''}<time>${formatTime(m.time)}</time></header>
  <div class="body">${renderMarkdown(body, names)}</div>${files ? `\n  <ul class="files">${files}</ul>` : ''}
</article>`;
    })
    .join('\n');
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="robots" content="noindex">
<title>${escapeHtml(meta.name)} · Ylide ticket</title>
<style>
:root{color-scheme:dark;--bg:#0c111b;--panel:#111726;--raised:#18202f;--border:#273246;--t1:#e7ecf4;--t2:#9aa6bb;--t3:#808ca6;--accent:#22d3ee}
*{box-sizing:border-box}
body{margin:0;background:var(--bg);color:var(--t1);font:14px/1.55 "Instrument Sans","Segoe UI",system-ui,sans-serif}
main{max-width:860px;margin:0 auto;padding:32px 20px 64px}
h1{font-size:20px;font-weight:600;margin:0 0 4px}
.meta{color:var(--t2);margin:0 0 24px;font-variant-numeric:tabular-nums}
article{background:var(--panel);border:1px solid var(--border);border-radius:8px;padding:12px 14px;margin:0 0 8px}
article.bot{border-left:3px solid var(--accent)}
header{display:flex;gap:8px;align-items:baseline;margin-bottom:4px}
header time{margin-left:auto;color:var(--t3);font-size:12px;font-variant-numeric:tabular-nums}
.tag{font-size:11px;color:var(--accent);border:1px solid var(--border);border-radius:3px;padding:0 4px}
.body{overflow-wrap:anywhere}
pre,code{font-family:"JetBrains Mono",Consolas,monospace;font-size:12.5px;background:var(--raised);border:1px solid var(--border);border-radius:5px}
pre{padding:10px;overflow-x:auto;white-space:pre-wrap}
code{padding:1px 4px}
a{color:var(--accent)}
.mention{color:var(--accent)}
small{color:var(--t3)}
.files{margin:6px 0 0;padding-left:18px;color:var(--t2)}
footer{color:var(--t3);font-size:12px;margin-top:24px}
</style>
</head>
<body>
<main>
<h1>${escapeHtml(meta.title)} · ${escapeHtml(meta.name)}</h1>
<p class="meta">Opened by ${escapeHtml(meta.owner)} · ${formatTime(meta.opened)}${meta.closed ? ` · exported ${formatTime(meta.closed)}` : ''} · ${messages.length} messages</p>
${rows}
<footer>Exported by the Ylide Discord bot. Attachment links point to Discord and stop working after a while.</footer>
</main>
</body>
</html>
`;
}
