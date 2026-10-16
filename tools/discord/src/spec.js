// The Ylide Discord server, described as data. The setup (src/setup) makes the
// live server match this: it creates what is missing and updates what differs,
// but never deletes roles, channels or messages it does not own.
//
// Overwrite targets are "everyone", "bot" or a role key from `roles`.

import { colors } from './theme.js';
import { bits, writing, ticketMember, botChannel } from './permissions.js';

export const ChannelType = { text: 0, voice: 2, category: 4, news: 5, forum: 15 };

// The languages of ylide.app. English is the language of the main channels;
// every other language has its own chat. Members pick their language roles in
// onboarding, and each role unlocks its chat (the team sees all of them).
// Topics and onboarding descriptions are written in the language itself.
export const languages = [
  { code: 'en', role: 'English', option: 'All main channels are in English.' },
  {
    code: 'de',
    role: 'Deutsch',
    channel: 'deutsch',
    option: 'Schaltet #deutsch frei.',
    topic: 'Der deutschsprachige Chat. Für Fragen zu Ylide gibt es #help, für Privates #tickets.',
  },
  {
    code: 'es',
    role: 'Español',
    channel: 'español',
    option: 'Desbloquea #español.',
    topic: 'El chat en español. Para preguntas sobre Ylide, usa #help; para asuntos privados, #tickets.',
  },
  {
    code: 'fr',
    role: 'Français',
    channel: 'français',
    option: 'Débloque #français.',
    topic: 'Le chat en français. Pour les questions sur Ylide, utilise #help ; pour les sujets privés, #tickets.',
  },
  {
    code: 'pt',
    role: 'Português',
    channel: 'português',
    option: 'Desbloqueia #português.',
    topic: 'O chat em português. Para dúvidas sobre o Ylide, use #help; para assuntos privados, #tickets.',
  },
  { code: 'ru', role: 'Русский', channel: 'русский', option: 'Открывает канал #русский.', topic: 'Чат на русском языке. Вопросы о Ylide задавайте в #help, личные — в #tickets.' },
  { code: 'ar', role: 'العربية', channel: 'العربية', option: 'يفتح قناة #العربية.', topic: 'الدردشة باللغة العربية. للأسئلة حول Ylide استخدم #help، وللأمور الخاصة #tickets.' },
  {
    code: 'hi',
    role: 'हिन्दी',
    channel: 'हिन्दी',
    option: '#हिन्दी चैनल खोलता है।',
    topic: 'हिन्दी में चैट। Ylide से जुड़े सवालों के लिए #help और निजी मामलों के लिए #tickets का उपयोग करें।',
  },
  {
    code: 'id',
    role: 'Bahasa Indonesia',
    channel: 'bahasa-indonesia',
    option: 'Membuka #bahasa-indonesia.',
    topic: 'Obrolan dalam Bahasa Indonesia. Untuk pertanyaan tentang Ylide, gunakan #help; untuk hal pribadi, #tickets.',
  },
  { code: 'ja', role: '日本語', channel: '日本語', option: '#日本語 チャンネルが表示されます。', topic: '日本語のチャットです。Ylide についての質問は #help、個別の相談は #tickets へどうぞ。' },
  { code: 'ko', role: '한국어', channel: '한국어', option: '#한국어 채널이 열립니다.', topic: '한국어 채팅입니다. Ylide 관련 질문은 #help, 개인적인 문의는 #tickets를 이용하세요.' },
  { code: 'zh', role: '中文', channel: '中文', option: '解锁 #中文 频道。', topic: '中文聊天频道。关于 Ylide 的问题请到 #help，私人事务请使用 #tickets。' },
];

// Top to bottom, as in the member list. All roles sit below the bot's own role.
export const roles = [
  // The person who runs Ylide. The setup gives it to the server owner.
  { key: 'founder', name: 'Founder', color: colors.warning, hoist: true, mentionable: false, permissions: bits('Administrator') },
  { key: 'maintainer', name: 'Maintainer', color: colors.qubit, hoist: true, mentionable: false, permissions: bits('Administrator') },
  {
    key: 'moderator',
    name: 'Moderator',
    color: colors.violet,
    hoist: true,
    mentionable: true,
    permissions: bits(
      'KickMembers',
      'BanMembers',
      'ModerateMembers',
      'ManageMessages',
      'PinMessages',
      'ManageThreads',
      'ManageNicknames',
      'ViewAuditLog',
      'MentionEveryone',
      'MuteMembers',
      'DeafenMembers',
      'MoveMembers',
      'BypassSlowmode',
      'CreateEvents',
      'ManageEvents',
    ),
  },
  // ManageThreads lets Support tag and close forum posts and see the /ticket command.
  { key: 'support', name: 'Support', color: colors.success, hoist: true, mentionable: true, permissions: bits('ManageThreads') },
  { key: 'contributor', name: 'Contributor', color: colors.brass, hoist: true, mentionable: false, permissions: 0n },
  { key: 'bots', name: 'Bots', color: colors.text3, hoist: false, mentionable: false, permissions: 0n },
  // Self-assigned in onboarding.
  { key: 'releasePings', name: 'Release pings', color: 0, hoist: false, mentionable: false, permissions: 0n },
  ...languages.map((l) => ({ key: `lang_${l.code}`, name: l.role, color: 0, hoist: false, mentionable: false, permissions: 0n })),
];

const readOnly = [{ target: 'everyone', allow: 0n, deny: writing }];
const staffPosts = [{ target: 'moderator', allow: bits('SendMessages', 'ManageMessages', 'PinMessages'), deny: 0n }];
const staffArea = [
  { target: 'everyone', allow: 0n, deny: bits('ViewChannel') },
  { target: 'support', allow: bits('ViewChannel'), deny: 0n },
  { target: 'moderator', allow: bits('ViewChannel'), deny: 0n },
  { target: 'bot', allow: botChannel, deny: 0n },
];
const ticketArea = [
  { target: 'everyone', allow: 0n, deny: bits('ViewChannel') },
  { target: 'support', allow: ticketMember | bits('ManageMessages', 'PinMessages'), deny: 0n },
  { target: 'moderator', allow: ticketMember | bits('ManageMessages', 'PinMessages'), deny: 0n },
  { target: 'bot', allow: botChannel, deny: 0n },
];

// Forum flag: a post must have at least one tag.
const REQUIRE_TAG = 1 << 4;

export const categories = [
  {
    key: 'start',
    name: 'Start',
    overwrites: readOnly,
    channels: [
      { key: 'welcome', name: 'welcome', type: 'text', topic: 'Start here: what Ylide is and where to find things.' },
      { key: 'rules', name: 'rules', type: 'text', topic: 'The rules of this server. By taking part you accept them.' },
      { key: 'announcements', name: 'announcements', type: 'news', topic: 'News about Ylide.', overwrites: staffPosts },
      {
        key: 'releases',
        name: 'releases',
        type: 'news',
        topic: 'Release notes for every Ylide version. Follow this channel to get them in your own server.',
        overwrites: staffPosts,
      },
    ],
  },
  {
    key: 'community',
    name: 'Community',
    channels: [
      // Reuses the starter text channel Discord creates with a new server (named in the creator's language).
      { key: 'general', name: 'general', type: 'text', topic: 'Talk about Ylide, local models and coding.', aliases: ['allgemein'] },
      {
        key: 'showcase',
        name: 'showcase',
        type: 'forum',
        topic: 'Show what you built with Ylide: one post per project, with a screenshot or a short clip. Feedback welcome, self-promotion beyond that is not.',
        layout: 'gallery',
        tags: [{ name: 'App' }, { name: 'Tool' }, { name: 'Game' }, { name: 'Website' }, { name: 'Setup' }, { name: 'Other' }],
      },
      { key: 'offTopic', name: 'off-topic', type: 'text', topic: 'Anything else. Keep it friendly.' },
      { key: 'lounge', name: 'Lounge', type: 'voice' },
    ],
  },
  {
    key: 'languages',
    name: 'Languages',
    overwrites: [
      { target: 'everyone', allow: 0n, deny: bits('ViewChannel') },
      { target: 'support', allow: bits('ViewChannel'), deny: 0n },
      { target: 'moderator', allow: bits('ViewChannel'), deny: 0n },
    ],
    channels: languages
      .filter((l) => l.channel)
      .map((l) => ({
        key: `lang_${l.code}`,
        name: l.channel,
        type: 'text',
        topic: l.topic,
        overwrites: [{ target: `lang_${l.code}`, allow: bits('ViewChannel'), deny: 0n }],
      })),
  },
  {
    key: 'help',
    name: 'Help',
    overwrites: [{ target: 'support', allow: bits('ManageMessages', 'ManageThreads', 'PinMessages'), deny: 0n }],
    channels: [
      { key: 'faq', name: 'faq', type: 'text', topic: 'Answers to common questions. Read these first.', overwrites: readOnly },
      {
        key: 'help',
        name: 'help',
        type: 'forum',
        topic:
          'Ask the community. One post per problem, with your Ylide version, Windows version and GPU. Search first: someone may have solved it already. The team marks answered posts as Solved.',
        flags: REQUIRE_TAG,
        tags: [
          { name: 'Installation' },
          { name: 'Models' },
          { name: 'GPU and performance' },
          { name: 'Agents' },
          { name: 'Editor' },
          { name: 'Updates' },
          { name: 'Solved', moderated: true },
        ],
      },
      {
        key: 'ideas',
        name: 'ideas',
        type: 'forum',
        topic:
          'Suggest a feature and vote with a reaction. One idea per post: describe the problem first, then your idea. The team sets the status tags.',
        flags: REQUIRE_TAG,
        reaction: '👍',
        rateLimit: 300,
        tags: [
          { name: 'New' },
          { name: 'Planned', moderated: true },
          { name: 'In progress', moderated: true },
          { name: 'Shipped', moderated: true },
          { name: 'Declined', moderated: true },
          { name: 'Duplicate', moderated: true },
          { name: 'Editor' },
          { name: 'Chat' },
          { name: 'Agents' },
          { name: 'Models' },
          { name: 'Performance' },
          { name: 'Website' },
        ],
      },
      { key: 'tickets', name: 'tickets', type: 'text', topic: 'Contact the team privately: bug reports, support and anything else.', overwrites: readOnly },
    ],
  },
  {
    key: 'development',
    name: 'Development',
    channels: [
      { key: 'contributing', name: 'contributing', type: 'text', topic: 'How to contribute to Ylide.', overwrites: readOnly },
      { key: 'dev', name: 'dev', type: 'text', topic: 'Working on Ylide itself: architecture, pull requests, builds.' },
      { key: 'translations', name: 'translations', type: 'text', topic: 'Help translate the app and the website into your language.' },
    ],
  },
  // The bot creates and removes the ticket channels in these two.
  { key: 'openTickets', name: 'Open tickets', overwrites: ticketArea, channels: [] },
  { key: 'closedTickets', name: 'Closed tickets', overwrites: ticketArea, channels: [] },
  {
    key: 'team',
    name: 'Team',
    overwrites: staffArea,
    channels: [
      { key: 'teamChat', name: 'team-chat', type: 'text', topic: 'For the team only.' },
      {
        key: 'ticketLog',
        name: 'ticket-log',
        type: 'text',
        topic: 'Opened, claimed and closed tickets, with transcripts. Written by the bot.',
        overwrites: [
          { target: 'support', allow: 0n, deny: writing },
          { target: 'moderator', allow: 0n, deny: writing },
        ],
      },
      {
        key: 'modLog',
        name: 'mod-log',
        type: 'text',
        topic: 'AutoMod alerts and Discord community updates.',
        overwrites: [{ target: 'support', allow: 0n, deny: bits('ViewChannel') }],
      },
      { key: 'teamVoice', name: 'Team voice', type: 'voice' },
    ],
  },
];

// Server settings. Community needs a rules channel, an updates channel, at
// least verified e-mail addresses and the media filter for all members.
export const guild = {
  description: 'Your Local IDE: an open-source AI coding IDE that runs models on your own computer.',
  verificationLevel: 2, // registered on Discord for more than five minutes
  explicitContentFilter: 2, // scan media from all members
  defaultNotifications: 1, // only @mentions
  preferredLocale: 'en-US',
  rulesChannel: 'rules',
  updatesChannel: 'modLog',
  safetyAlertsChannel: 'modLog',
  icon: 'assets/server-icon.png',
};

// Discord's own onboarding: every public channel is a default channel. The
// first question hands out the language roles (and with them the language
// chats), the second the release pings.
export const onboarding = {
  defaultChannels: [
    'welcome',
    'rules',
    'announcements',
    'releases',
    'general',
    'showcase',
    'offTopic',
    'lounge',
    'faq',
    'help',
    'ideas',
    'tickets',
    'contributing',
    'dev',
    'translations',
  ],
  prompts: [
    {
      title: 'Which languages do you speak?',
      singleSelect: false,
      required: true,
      options: languages.map((l) => ({ title: l.role, description: l.option, emoji: null, channels: [], roles: [`lang_${l.code}`] })),
    },
    {
      title: 'Do you want a ping for new releases?',
      singleSelect: true,
      required: false,
      options: [
        {
          title: 'Yes, ping me',
          description: 'Get a notification in #releases when a new Ylide version is out.',
          emoji: '🔔',
          channels: ['releases'],
          roles: ['releasePings'],
        },
      ],
    },
  ],
};

// Discord AutoMod rules (they run inside Discord, also when the bot is offline).
// Alerts go to #mod-log; the team is exempt.
export const automod = [
  { name: 'Ylide: mention spam', trigger: 5, metadata: { mention_total_limit: 6, mention_raid_protection_enabled: true }, timeout: 600 },
  { name: 'Ylide: suspected spam', trigger: 3, metadata: {} },
  { name: 'Ylide: slurs and sexual content', trigger: 4, metadata: { presets: [2, 3], allow_list: [] } },
  {
    name: 'Ylide: invite links',
    trigger: 1,
    metadata: { keyword_filter: [], regex_patterns: ['(?i)(discord\\.gg|discord(app)?\\.com/invite)/[a-z0-9-]+'], allow_list: [] },
  },
];
// The permanent invite the website links to.
export const invite = { channel: 'welcome' };

export const automodExempt = { roles: ['founder', 'maintainer', 'moderator'], channels: ['teamChat', 'ticketLog', 'modLog'] };

/** All channel specs with their category key, in sidebar order. */
export function allChannels() {
  return categories.flatMap((category) => category.channels.map((channel) => ({ ...channel, category: category.key })));
}
