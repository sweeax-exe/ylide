// The messages the setup posts into the info channels, in English. Each
// function returns the messages of one channel, top to bottom; the setup edits
// them in place when the text here changes.
//
// ctx: { ch: channel key -> id, emojis: name -> id, files: name -> attachment name }

import { colors, links } from './theme.js';
import { button, container, gallery, row, section, separator, text, v2, ButtonStyle } from './components.js';

const ch = (ctx, key) => (ctx.ch[key] ? `<#${ctx.ch[key]}>` : `#${key}`);
const em = (ctx, name) => (ctx.emojis[name] ? `<:${name}:${ctx.emojis[name]}>` : '');

function linkButtons() {
  return row(
    button({ label: 'Download Ylide', url: links.website }),
    button({ label: 'Privacy', url: links.privacy }),
    links.github ? button({ label: 'Source code', url: links.github }) : null,
  );
}

export function welcome(ctx) {
  return [
    v2(
      [
        container(
          colors.qubit,
          gallery(`attachment://${ctx.files.banner}`),
          text(
            '# Welcome to Ylide\n' +
              'Ylide is an open-source AI coding IDE that runs models only on your own computer. ' +
              'Chat with your project, edit code inline and let a small team of agents plan, write and review changes, ' +
              'all through llama.cpp. No cloud, no account, no telemetry.',
          ),
          separator(),
          text(
            '### Find your way\n' +
              `- ${ch(ctx, 'faq')} answers to common questions\n` +
              `- ${ch(ctx, 'help')} ask the community\n` +
              `- ${ch(ctx, 'tickets')} report a bug or contact the team privately\n` +
              `- ${ch(ctx, 'ideas')} suggest features and vote on them\n` +
              `- ${ch(ctx, 'releases')} release notes for every version\n` +
              `- ${ch(ctx, 'general')} everything else about Ylide\n` +
              '- **Channels & Roles** pick your languages to unlock a chat in your own language',
          ),
          separator(),
          linkButtons(),
          text('-# Ylide runs on Windows 10 and 11 (x64). macOS and Linux will follow.'),
        ),
      ],
      { files: ['banner'] },
    ),
  ];
}

export function rules(ctx) {
  return [
    v2([
      container(
        colors.qubit,
        text('# Rules'),
        text(
          '1. **Be kind and constructive.** Critique ideas, not people. No harassment, hate speech or discrimination.\n' +
            `2. **Keep channels on topic.** Anything else goes to ${ch(ctx, 'offTopic')}.\n` +
            `3. **Ask in public.** Use ${ch(ctx, 'help')} instead of DMs; the answer helps the next person too. For private matters, open a ticket in ${ch(ctx, 'tickets')}.\n` +
            `4. **No spam or advertising.** No unsolicited ads, invite links or DMs. Your own Ylide projects are welcome in ${ch(ctx, 'showcase')}.\n` +
            '5. **Keep secrets out.** Never post API keys, tokens, passwords or personal data. Check log files before you share them.\n' +
            '6. **Nothing illegal or NSFW.** That includes pirated software and models you are not allowed to share.\n' +
            '7. **English in the main channels,** so everyone can follow. Every other language has its own chat: pick your languages under Channels & Roles.\n' +
            `8. **Follow Discord's [Terms of Service](${links.discordTerms}) and [Community Guidelines](${links.discordGuidelines}).**`,
        ),
        separator(),
        text(`-# Moderators may remove content or members that break these rules. To discuss a decision, open a ticket in ${ch(ctx, 'tickets')}.`),
      ),
    ]),
  ];
}

export function faq(ctx) {
  const qa = [
    ['Which systems does Ylide run on?', 'Windows 10 and 11 (x64). macOS and Linux will follow.'],
    [
      'Do I need a GPU?',
      'No, models also run on the CPU. NVIDIA, AMD and Intel GPUs are used through Vulkan; NVIDIA cards can add an optional CUDA pack for more speed.',
    ],
    ['How much memory do I need?', '16 GB of RAM or more is recommended. The hardware scan picks a model that fits your GPU, RAM and disk.'],
    [
      'Does Ylide send my code anywhere?',
      'No. Models run on your machine. The only network traffic is the model list update, the update check and the downloads you start; each can be switched off and is listed in the network log.',
    ],
    ['Which models can I use?', 'The curated catalog, your own GGUF files, or an OpenAI-compatible server you already run (Ollama, LM Studio, llama-server).'],
    ['Where is the log file?', '`%LOCALAPPDATA%\\app.ylide\\logs\\ylide.log`, and `ylide.previous.log` for the run before. Attach it to bug reports.'],
    ['How do I report a bug?', `Open a ticket in ${ch(ctx, 'tickets')} with **Report a bug**. The form asks for everything we need.`],
    ['Is Ylide free?', 'Yes. Ylide is open source under the Apache 2.0 license.'],
  ];
  return [
    v2([
      container(
        colors.qubit,
        text('# FAQ'),
        text(qa.map(([q, a]) => `**${q}**\n${a}`).join('\n\n')),
        separator(),
        text(`-# Missing something? Ask in ${ch(ctx, 'help')}.`),
      ),
    ]),
  ];
}

export function contributing(ctx) {
  return [
    v2([
      container(
        colors.brass,
        text(
          '# Contributing\n' +
            'Ylide is open source (Apache 2.0) and built by a small team. Code, model entries, translations and good bug reports all help.',
        ),
        separator(),
        text(
          '**Local first, private by default.** No feature may send user data anywhere.\n' +
            '**Nothing hidden.** Prompts, roles and settings the app uses stay visible and editable.\n' +
            '**Compatible licenses.** MIT, Apache 2.0, BSD and similar; no GPL in the shipped app.',
        ),
        separator(),
        text(
          (links.github
            ? `The code and the contribution guide are on GitHub. Talk to us in ${ch(ctx, 'dev')}`
            : `The repository goes public on GitHub soon. Until then, talk to us in ${ch(ctx, 'dev')}`) +
            `, or help translate the app in ${ch(ctx, 'translations')}.`,
        ),
        links.github ? row(button({ label: 'Source code', url: links.github })) : null,
        text('-# Contributors get the Contributor role.'),
      ),
    ]),
  ];
}

export function tickets(ctx) {
  const entry = (id, emojiName, title, description, buttonLabel) =>
    section(button({ id, label: buttonLabel, style: ButtonStyle.secondary }), `${em(ctx, emojiName)} **${title}**\n${description}`.trim());
  return [
    v2([
      container(
        colors.qubit,
        text(
          '## Contact the team\n' +
            `Open a private ticket: only you and the support team can see it. General questions are usually answered faster in ${ch(ctx, 'help')}.`,
        ),
        separator(),
        entry('ticket:open:bug', 'ylide_bug', 'Bug report', "Something in Ylide doesn't work as it should.", 'Report a bug'),
        entry('ticket:open:help', 'ylide_help', 'Support', 'A question that needs private details, such as log files.', 'Get help'),
        entry('ticket:open:idea', 'ylide_idea', 'Feature idea', `Posted publicly in ${ch(ctx, 'ideas')}, where others can vote.`, 'Suggest a feature'),
        entry('ticket:open:other', 'ylide_other', 'Something else', "Anything that doesn't fit above.", 'Contact us'),
        separator(),
        text(
          '-# Tickets stay on Discord: the Ylide bot keeps nothing about you anywhere else. ' +
            'Closed tickets are deleted after 48 hours; a transcript stays in a team-only channel.',
        ),
      ),
    ]),
  ];
}

/** Channel key -> messages. */
export const messages = { welcome, rules, faq, contributing, tickets };
