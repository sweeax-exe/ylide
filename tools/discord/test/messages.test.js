import { test } from 'node:test';
import assert from 'node:assert/strict';
import { messages } from '../src/content.js';
import { modal, readForm, ticketTypes, fields } from '../src/bot/forms.js';
import {
  ticketHeader,
  ticketName,
  parseTicketName,
  ticketTopic,
  ownerFromTopic,
  headerButtons,
  withHeaderButtons,
  claimedByOf,
  closedPanel,
  ideaPost,
  logEntry,
} from '../src/bot/cards.js';
import { emojiNames } from '../src/theme.js';

const ctx = {
  ch: { faq: '1', help: '2', tickets: '3', ideas: '4', releases: '5', general: '6', offTopic: '7', showcase: '8', dev: '9', translations: '10' },
  emojis: Object.fromEntries(emojiNames.map((n, i) => [n, String(1000 + i)])),
  files: { banner: 'banner-abc.png' },
};

function walk(components, fn) {
  for (const c of components ?? []) {
    fn(c);
    walk(c.components, fn);
    if (c.accessory) fn(c.accessory);
    if (c.component) fn(c.component);
  }
}

// Components V2 limits: 40 components per message (nested ones count) and
// 4000 characters of text in total.
function checkMessage(components, where) {
  let count = 0;
  let chars = 0;
  const ids = new Set();
  walk(components, (c) => {
    count++;
    if (c.type === 10) chars += c.content.length;
    if (c.custom_id) {
      assert.ok(!ids.has(c.custom_id), `${where}: custom_id ${c.custom_id} is unique`);
      assert.ok(c.custom_id.length <= 100);
      ids.add(c.custom_id);
    }
    if (c.type === 2) assert.ok((c.label ?? '').length <= 80, `${where}: button label fits`);
    if (c.type === 9) assert.ok(c.components.length >= 1 && c.components.length <= 3, `${where}: section has 1-3 texts`);
  });
  assert.ok(count <= 40, `${where}: ${count} components`);
  assert.ok(chars <= 4000, `${where}: ${chars} characters`);
}

test('info messages stay within Discord limits', () => {
  for (const [key, build] of Object.entries(messages)) {
    const list = build(ctx);
    assert.ok(list.length >= 1);
    for (const m of list) {
      assert.equal(m.flags, 1 << 15, `${key} is a Components V2 message`);
      checkMessage(m.components, key);
    }
  }
});

test('the ticket panel has one button per type', () => {
  const ids = [];
  walk(messages.tickets(ctx)[0].components, (c) => c.custom_id && ids.push(c.custom_id));
  assert.deepEqual(ids, ['ticket:open:bug', 'ticket:open:help', 'ticket:open:idea', 'ticket:open:other']);
});

test('the welcome banner refers to the uploaded file', () => {
  const [m] = messages.welcome(ctx);
  assert.deepEqual(m.files, ['banner']);
  assert.match(JSON.stringify(m.components), /attachment:\/\/banner-abc\.png/);
});

test('modals have at most five labelled fields', () => {
  for (const type of [...Object.keys(ticketTypes), 'idea']) {
    const m = modal(type, { version: '0.1.4' });
    assert.ok(m.title.length <= 45);
    assert.ok(m.components.length >= 1 && m.components.length <= 5, type);
    for (const l of m.components) {
      assert.equal(l.type, 18);
      assert.ok(l.label.length <= 45, `${type}: label ${l.label}`);
      if (l.description) assert.ok(l.description.length <= 100, `${type}: description of ${l.label}`);
      if (l.component.placeholder) assert.ok(l.component.placeholder.length <= 100);
    }
    // Every field shown in the ticket comes from the form.
    const ids = m.components.map((l) => l.component.custom_id);
    for (const [id] of fields[type]) assert.ok(ids.includes(id), `${type}: ${id}`);
  }
});

test('the bug form suggests the latest version', () => {
  const version = modal('bug', { version: '0.1.4' }).components.find((l) => l.component.custom_id === 'version').component;
  assert.equal(version.value, '0.1.4');
  assert.equal(modal('bug').components.find((l) => l.component.custom_id === 'version').component.value, undefined);
});

test('readForm keeps ticket order and joins select values', () => {
  const values = { topic: ['Models and downloads'], version: ' 0.1.4 ', question: 'Why?', tried: null };
  assert.deepEqual(readForm('help', (id) => values[id]), [
    { id: 'topic', label: 'Topic', value: 'Models and downloads' },
    { id: 'version', label: 'Ylide version', value: '0.1.4' },
    { id: 'question', label: 'Question', value: 'Why?' },
    { id: 'tried', label: 'What I tried', value: '' },
  ]);
});

test('ticket names and topics round-trip', () => {
  assert.equal(ticketName('bug', 7), 'bug-0007');
  assert.deepEqual(parseTicketName('bug-0007'), { type: 'bug', number: 7 });
  assert.deepEqual(parseTicketName('help-12345'), { type: 'help', number: 12345 });
  assert.equal(parseTicketName('general'), null);
  assert.equal(parseTicketName('idea-0001'), null);
  assert.equal(ownerFromTopic(ticketTopic('other', '123456789012345678')), '123456789012345678');
  assert.equal(ownerFromTopic(null), null);
});

test('the longest ticket header stays within the limits', () => {
  const long = (n) => 'x'.repeat(n);
  for (const type of Object.keys(ticketTypes)) {
    const filled = fields[type].map(([id, label]) => ({ id, label, value: long(2500) }));
    // Use the real maximum lengths of the form fields.
    const max = Object.fromEntries(modal(type).components.map((l) => [l.component.custom_id, l.component.max_length ?? 100]));
    for (const f of filled) f.value = long(max[f.id]);
    const components = ticketHeader({ type, number: 9999, ownerId: '1', supportRoleId: '2', fields: filled, emojis: ctx.emojis, openedAt: 0 });
    checkMessage(components, `header ${type}`);
  }
});

test('claiming swaps the header buttons and is remembered', () => {
  const header = ticketHeader({ type: 'bug', number: 1, ownerId: '1', supportRoleId: '2', fields: [], emojis: ctx.emojis, openedAt: 0 });
  assert.equal(claimedByOf(header), null);
  const claimed = withHeaderButtons(header, headerButtons(ctx.emojis, { claimedBy: '42', claimedName: 'Ada' }));
  assert.equal(claimedByOf(claimed), '42');
  const closed = withHeaderButtons(claimed, headerButtons(ctx.emojis, { claimedBy: '42', claimedName: 'Ada', closed: true }));
  const buttons = [];
  walk(closed, (c) => c.type === 2 && buttons.push(c));
  assert.ok(buttons.every((b) => b.disabled));
  assert.equal(claimedByOf(closed), '42');
});

test('other bot messages stay within the limits', () => {
  checkMessage(closedPanel({ closedBy: '1', emojis: ctx.emojis, closedAt: 0 }), 'closed panel');
  checkMessage(ideaPost({ ownerId: '1', fields: readForm('idea', (id) => 'y'.repeat(1500)), emojis: ctx.emojis }), 'idea');
  for (const action of ['opened', 'claimed', 'closed', 'reopened', 'deleted']) {
    checkMessage(logEntry({ action, channelId: '1', type: 'help', actorId: '2', ownerId: '3', emojis: ctx.emojis }), action);
  }
});
