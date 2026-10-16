import { test } from 'node:test';
import assert from 'node:assert/strict';
import { renderMarkdown, renderTranscript, componentText } from '../src/bot/transcript.js';

test('markdown is escaped before it is formatted', () => {
  assert.equal(renderMarkdown('<script>alert(1)</script>'), '&lt;script&gt;alert(1)&lt;/script&gt;');
  assert.equal(renderMarkdown('**bold** and `x<y`'), '<strong>bold</strong> and <code>x&lt;y</code>');
  assert.equal(renderMarkdown('```js\nif (a < b) {}\n```'), '<pre>if (a &lt; b) {}</pre>');
});

test('mentions use names, unknown ones fall back', () => {
  const names = { users: { 1: 'Ada' }, roles: { 2: 'Support' }, channels: { 3: 'help' } };
  assert.equal(renderMarkdown('<@1> <@&2> <#3> <@9>', names), '<span class="mention">@Ada</span> <span class="mention">@Support</span> <span class="mention">#help</span> <span class="mention">@9</span>');
  assert.equal(renderMarkdown('<:ylide_bug:123>'), ':ylide_bug:');
});

test('links only allow http(s)', () => {
  assert.equal(renderMarkdown('[site](https://ylide.app)'), '<a href="https://ylide.app">site</a>');
  assert.equal(renderMarkdown('[x](javascript:alert(1))'), '[x](javascript:alert(1))');
});

test('component text is collected for bot messages', () => {
  const components = [{ type: 17, components: [{ type: 10, content: 'Hello' }, { type: 9, components: [{ type: 10, content: 'Row' }], accessory: { type: 2, label: 'Go' } }] }];
  assert.equal(componentText(components), 'Hello\nRow\n[Go]');
});

test('the transcript is a complete, escaped page', () => {
  const html = renderTranscript({ name: 'bug-0001', title: 'Bug report', owner: 'Ada <3', opened: 0, closed: 1000 }, [
    { author: 'Ada', bot: false, time: 0, content: 'It crashes <b>', components: [], attachments: [{ name: 'ylide.log', url: 'https://cdn.discordapp.com/x/ylide.log' }] },
  ]);
  assert.match(html, /^<!doctype html>/);
  assert.match(html, /Ada &lt;3/);
  assert.match(html, /It crashes &lt;b&gt;/);
  assert.match(html, /ylide\.log<\/a>/);
  assert.doesNotMatch(html, /crashes <b>/);
});
