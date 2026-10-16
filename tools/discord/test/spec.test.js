import { test } from 'node:test';
import assert from 'node:assert/strict';
import { roles, categories, allChannels, onboarding, guild, automodExempt, ChannelType } from '../src/spec.js';
import { mergeOverwrites } from '../src/setup/compare.js';
import { writing, P } from '../src/permissions.js';
import { messages } from '../src/content.js';

const targets = new Set(['everyone', 'bot', ...roles.map((r) => r.key)]);

test('role names and keys are unique', () => {
  assert.equal(new Set(roles.map((r) => r.name)).size, roles.length);
  assert.equal(new Set(roles.map((r) => r.key)).size, roles.length);
});

test('category and channel keys are unique and channel names are valid', () => {
  const channels = allChannels();
  assert.equal(new Set(categories.map((c) => c.key)).size, categories.length);
  assert.equal(new Set(channels.map((c) => c.key)).size, channels.length);
  for (const c of channels) {
    assert.ok(c.type in ChannelType, `${c.key} has a known type`);
    // Lowercase letters of any script (with their combining marks), digits and dashes.
    if (c.type !== 'voice') assert.match(c.name, /^[\p{Ll}\p{Lo}\p{M}0-9-]{1,100}$/u, `${c.name} is a valid text channel name`);
    if (c.topic) assert.ok(c.topic.length <= (c.type === 'forum' ? 4096 : 1024), `${c.key} topic fits`);
    if (c.tags) {
      assert.ok(c.tags.length <= 20, `${c.key} has at most 20 tags`);
      for (const t of c.tags) assert.ok(t.name.length <= 20, `tag ${t.name} fits`);
    }
  }
});

test('every overwrite points at a known target', () => {
  for (const category of categories) {
    for (const o of category.overwrites ?? []) assert.ok(targets.has(o.target), o.target);
    for (const channel of category.channels) for (const o of channel.overwrites ?? []) assert.ok(targets.has(o.target), o.target);
  }
});

test('referenced channels exist', () => {
  const keys = new Set(allChannels().map((c) => c.key));
  for (const key of [guild.rulesChannel, guild.updatesChannel, guild.safetyAlertsChannel, ...automodExempt.channels, ...Object.keys(messages)]) {
    assert.ok(keys.has(key), key);
  }
  for (const key of automodExempt.roles) assert.ok(roles.some((r) => r.key === key), key);
});

// Discord refuses to enable onboarding unless there are at least 7 default
// channels and @everyone can send messages in at least 5 of them.
test('onboarding meets Discord constraints', () => {
  const channels = allChannels();
  const byKey = Object.fromEntries(channels.map((c) => [c.key, c]));
  assert.ok(onboarding.defaultChannels.length >= 7);
  const sendable = onboarding.defaultChannels.filter((key) => {
    const c = byKey[key];
    assert.ok(c, `default channel ${key} exists`);
    const category = categories.find((cat) => cat.key === c.category);
    const merged = mergeOverwrites(category.overwrites ?? [], c.overwrites ?? []);
    const everyone = merged.find((o) => o.target === 'everyone');
    if (everyone && (everyone.deny & P.ViewChannel) === P.ViewChannel) assert.fail(`default channel ${key} is hidden from @everyone`);
    return !everyone || (everyone.deny & P.SendMessages) === 0n;
  });
  assert.ok(sendable.length >= 5, `only ${sendable.length} default channels allow sending`);
  for (const prompt of onboarding.prompts) {
    for (const option of prompt.options) {
      assert.ok(option.channels.length + option.roles.length > 0, `option ${option.title} unlocks something`);
      for (const r of option.roles) assert.ok(roles.some((x) => x.key === r));
      for (const c of option.channels) assert.ok(byKey[c]);
    }
  }
});

test('read-only channels deny every way of writing', () => {
  for (const key of ['welcome', 'rules', 'faq', 'tickets', 'contributing']) {
    const c = allChannels().find((x) => x.key === key);
    const category = categories.find((cat) => cat.key === c.category);
    const everyone = mergeOverwrites(category.overwrites ?? [], c.overwrites ?? []).find((o) => o.target === 'everyone');
    assert.equal(everyone.deny & writing, writing, key);
  }
});
