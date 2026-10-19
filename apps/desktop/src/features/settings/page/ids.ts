// Section ids (DOM ids) of both views, used by the navigation and by links
// between the views.

export const SETTINGS_SECTIONS = {
  general: 'settings-general',
  editor: 'settings-editor',
  chat: 'settings-chat',
  agents: 'settings-agents',
  network: 'settings-network',
  advanced: 'settings-advanced',
} as const;

export const SKILL_SECTIONS = {
  installed: 'skills-installed',
  recommended: 'skills-recommended',
  project: 'skills-project',
  usage: 'skills-usage',
} as const;

export const MODEL_SECTIONS = {
  active: 'models-active',
  installed: 'models-installed',
  downloads: 'models-downloads',
  catalog: 'models-catalog',
  runtimes: 'models-runtimes',
  registry: 'models-registry',
} as const;
