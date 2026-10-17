import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { compareVersions, decide, splitNotes, releasePost, githubReleaseUrl } from '../src/bot/releases.js';
import { parseManifest } from '../src/bot/version.js';
import { State } from '../src/bot/state.js';

test('versions compare numerically', () => {
  assert.ok(compareVersions('0.1.10', '0.1.9') > 0);
  assert.ok(compareVersions('0.2.0', '0.1.99') > 0);
  assert.ok(compareVersions('1.0.0', '0.9.9') > 0);
  assert.equal(compareVersions('0.1.8', '0.1.8'), 0);
  assert.ok(compareVersions('0.1.7', '0.1.8') < 0);
});

test('the first start records the version instead of posting', () => {
  assert.equal(decide('0.1.7', { lastRelease: null, releaseBaseline: null }), 'record');
});

test('only newer versions are announced', () => {
  assert.equal(decide('0.1.8', { lastRelease: '0.1.7' }), 'announce');
  assert.equal(decide('0.1.8', { lastRelease: '0.1.8' }), 'skip');
  assert.equal(decide('0.1.7', { lastRelease: '0.1.8' }), 'skip');
});

test('a baseline announces everything after it, even on the first start', () => {
  assert.equal(decide('0.1.8', { lastRelease: null, releaseBaseline: '0.1.7' }), 'announce');
  assert.equal(decide('0.1.7', { lastRelease: null, releaseBaseline: '0.1.7' }), 'skip');
});

test('state keeps the last release across restarts and drops a used baseline', () => {
  const dir = mkdtempSync(join(tmpdir(), 'ylide-discord-state-'));
  try {
    writeFileSync(join(dir, 'state.json'), JSON.stringify({ lastTicket: 1, releaseBaseline: '0.1.7' }));
    const state = new State(dir);
    assert.equal(state.lastRelease, null);
    assert.equal(state.releaseBaseline, '0.1.7');
    state.setLastRelease('0.1.8');
    const again = new State(dir);
    assert.equal(again.lastRelease, '0.1.8');
    assert.equal(again.releaseBaseline, null);
    assert.equal(again.nextTicket(), 2);
    assert.deepEqual(JSON.parse(readFileSync(join(dir, 'state.json'), 'utf8')), { lastTicket: 2, lastRelease: '0.1.8' });
    // After that, the same version is never announced again.
    assert.equal(decide('0.1.8', again), 'skip');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('the manifest is read defensively', () => {
  assert.deepEqual(parseManifest({ version: '0.1.8', notes: ' Hi ', pub_date: '2026-10-17T10:00:00Z' }), { version: '0.1.8', notes: 'Hi', date: Date.parse('2026-10-17T10:00:00Z') });
  assert.equal(parseManifest({ version: 'latest' }), null);
  assert.equal(parseManifest(null), null);
  assert.deepEqual(parseManifest({ version: '0.1.8' }), { version: '0.1.8', notes: '', date: null });
});

// Real notes from latest.json: German first, then English.
const notes017 =
  'Bilder kannst du den Agents jetzt überall mitgeben: beim Weitermachen eines Laufs, beim Eingreifen und wenn du eine Frage eines Agents beantwortest. You can now give the agents images wherever you write to them: when continuing a run, when intervening and when answering an agent\'s question.';
const notes014 =
  'Chats werden pro Projekt gespeichert und lassen sich über den Verlauf wieder öffnen. Neu im Katalog: drei unzensierte Modellvarianten (gekennzeichnet, nie empfohlen), und eigene GGUF-Modelle lassen sich leichter importieren. Chats are saved per project and can be reopened from the history. New in the catalog: three uncensored model variants (marked, never recommended), and importing your own GGUF model is easier to find.';

test('release notes split into German and English', () => {
  assert.deepEqual(splitNotes(notes017), {
    de: 'Bilder kannst du den Agents jetzt überall mitgeben: beim Weitermachen eines Laufs, beim Eingreifen und wenn du eine Frage eines Agents beantwortest.',
    en: "You can now give the agents images wherever you write to them: when continuing a run, when intervening and when answering an agent's question.",
  });
  const split = splitNotes(notes014);
  assert.match(split.de, /^Chats werden pro Projekt.*leichter importieren\.$/);
  assert.match(split.en, /^Chats are saved per project.*easier to find\.$/);
});

test('notes that do not split cleanly stay whole', () => {
  assert.deepEqual(splitNotes('Fixes a crash when the model list is empty.'), { en: 'Fixes a crash when the model list is empty.', de: '' });
  assert.deepEqual(splitNotes('Behebt einen Absturz, wenn die Modellliste leer ist.'), { en: '', de: 'Behebt einen Absturz, wenn die Modellliste leer ist.' });
  assert.deepEqual(splitNotes(''), { en: '', de: '' });
  const mixed = 'Fixes the editor. Behebt den Editor. Fixes the chat.';
  assert.deepEqual(splitNotes(mixed), { en: mixed, de: '' });
});

function texts(components) {
  const out = [];
  const walk = (list) => {
    for (const c of list ?? []) {
      if (c.type === 10) out.push(c.content);
      walk(c.components);
    }
  };
  walk(components);
  return out.join('\n');
}

test('the release post shows the version, both languages, links and the ping', () => {
  const post = releasePost({
    version: '0.1.8',
    date: Date.parse('2026-10-17T12:00:00Z'),
    notes: notes017,
    githubUrl: 'https://github.com/sweeax-exe/ylide/releases/tag/v0.1.8',
    pingRoleId: '42',
    emojis: { ylide_mark: '7' },
  });
  const all = texts(post);
  assert.match(all, /^## <:ylide_mark:7> Ylide 0\.1\.8/);
  assert.match(all, /\*\*What's new\*\*\nYou can now give the agents images/);
  assert.match(all, /\*\*Neu in dieser Version\*\*\nBilder kannst du/);
  assert.match(all, /<@&42>/);
  assert.ok(all.length < 4000);
  const buttons = JSON.stringify(post).match(/"url":"[^"]+"/g);
  assert.deepEqual(buttons, ['"url":"https://ylide.app"', '"url":"https://github.com/sweeax-exe/ylide/releases/tag/v0.1.8"']);
});

test('very long notes are clipped to stay within Discord limits', () => {
  const long = `${'Sehr lange Notiz und noch mehr. '.repeat(200)}${'A very long note for the release. '.repeat(200)}`;
  const all = texts(releasePost({ version: '9.9.9', date: null, notes: long, githubUrl: 'https://github.com/x/y', pingRoleId: null, emojis: {} }));
  assert.ok(all.length < 4000, `${all.length} characters`);
});

test('the GitHub link is used only when the release page exists', async () => {
  const ok = async () => ({ ok: true });
  const missing = async () => ({ ok: false });
  const offline = async () => {
    throw new Error('offline');
  };
  assert.equal(await githubReleaseUrl('0.1.8', ok), 'https://github.com/sweeax-exe/ylide/releases/tag/v0.1.8');
  assert.equal(await githubReleaseUrl('0.1.8', missing), null);
  assert.equal(await githubReleaseUrl('0.1.8', offline), null);
});

// A fake #releases channel and server, to run the whole announcer.
function fakeServer() {
  const sent = [];
  const channel = {
    name: 'releases',
    type: 5, // announcement channel
    client: { user: { id: 'bot' } },
    messages: {
      fetch: async () =>
        sent.map((m) => ({ author: { id: 'bot' }, components: m.components.map((c) => ({ toJSON: () => c })) })),
    },
    send: async (payload) => {
      const message = { ...payload, crossposted: false };
      message.crosspost = async () => {
        message.crossposted = true;
      };
      sent.push(message);
      return message;
    },
  };
  const guild = {
    channels: { cache: { find: (fn) => [channel].find(fn) } },
    roles: { cache: { find: (fn) => [{ id: '42', name: 'Release pings' }].find(fn) } },
  };
  return { guild, sent };
}

test('the announcer posts a new version once, publishes it and remembers it', async () => {
  const { ReleaseAnnouncer } = await import('../src/bot/releases.js');
  const dir = mkdtempSync(join(tmpdir(), 'ylide-discord-announce-'));
  try {
    writeFileSync(join(dir, 'state.json'), JSON.stringify({ lastRelease: '0.1.7' }));
    const { guild, sent } = fakeServer();
    const make = () => new ReleaseAnnouncer({ state: new State(dir), guild, emojis: {}, fetchGithub: async (v) => `https://github.com/sweeax-exe/ylide/releases/tag/v${v}` });
    const release = { version: '0.1.8', notes: notes017, date: null };
    await make().check(release);
    assert.equal(sent.length, 1);
    assert.equal(sent[0].crossposted, true);
    assert.deepEqual(sent[0].allowedMentions, { roles: ['42'] });
    // The same version again, also after a restart: nothing new.
    await make().check(release);
    assert.equal(sent.length, 1);
    assert.equal(new State(dir).lastRelease, '0.1.8');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('the announcer does not post twice when the state was lost', async () => {
  const { ReleaseAnnouncer } = await import('../src/bot/releases.js');
  const dir = mkdtempSync(join(tmpdir(), 'ylide-discord-announce-'));
  try {
    const { guild, sent } = fakeServer();
    const fetchGithub = async () => 'https://github.com/x/y';
    writeFileSync(join(dir, 'state.json'), JSON.stringify({ lastRelease: '0.1.7' }));
    await new ReleaseAnnouncer({ state: new State(dir), guild, emojis: {}, fetchGithub }).check({ version: '0.1.8', notes: '', date: null });
    // The state goes back to 0.1.7 (say, a restored backup): the post in the channel stops a second one.
    writeFileSync(join(dir, 'state.json'), JSON.stringify({ lastRelease: '0.1.7' }));
    await new ReleaseAnnouncer({ state: new State(dir), guild, emojis: {}, fetchGithub }).check({ version: '0.1.8', notes: '', date: null });
    assert.equal(sent.length, 1);
    assert.equal(new State(dir).lastRelease, '0.1.8');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('the announcer waits for the GitHub release page and records quietly on a first start', async () => {
  const { ReleaseAnnouncer } = await import('../src/bot/releases.js');
  const dir = mkdtempSync(join(tmpdir(), 'ylide-discord-announce-'));
  try {
    const { guild, sent } = fakeServer();
    // First start without any state: only remembered.
    await new ReleaseAnnouncer({ state: new State(dir), guild, emojis: {}, fetchGithub: async () => null }).check({ version: '0.1.7', notes: '', date: null });
    assert.equal(sent.length, 0);
    assert.equal(new State(dir).lastRelease, '0.1.7');
    // A new version whose GitHub page is not there yet: wait (within the grace period).
    const announcer = new ReleaseAnnouncer({ state: new State(dir), guild, emojis: {}, fetchGithub: async () => null });
    await announcer.check({ version: '0.1.8', notes: '', date: null });
    assert.equal(sent.length, 0);
    assert.equal(new State(dir).lastRelease, '0.1.7');
    // After the grace period it posts with the repository link.
    announcer.waitingSince.set('0.1.8', Date.now() - 31 * 60 * 1000);
    await announcer.check({ version: '0.1.8', notes: '', date: null });
    assert.equal(sent.length, 1);
    assert.match(JSON.stringify(sent[0].components), /"url":"https:\/\/github\.com\/sweeax-exe\/ylide"/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
