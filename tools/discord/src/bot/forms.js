// The forms (Discord modals) behind the buttons of the ticket panel. A modal
// holds at most five fields; every field is a Label with one input.

import { colors } from '../theme.js';
import { fileUpload, label, select, textInput } from '../components.js';

export const ticketTypes = {
  bug: { prefix: 'bug', title: 'Bug report', modalTitle: 'Report a bug', color: colors.danger, emoji: 'ylide_bug' },
  help: { prefix: 'help', title: 'Support request', modalTitle: 'Get help', color: colors.qubit, emoji: 'ylide_help' },
  other: { prefix: 'other', title: 'Request', modalTitle: 'Contact the team', color: colors.text2, emoji: 'ylide_other' },
};

export const ideaAreas = ['Editor', 'Chat', 'Agents', 'Models', 'Performance', 'Website', 'Other'];

const versionInput = (version, required) =>
  label('Ylide version', 'Shown in Settings > About Ylide', textInput({ id: 'version', max: 20, value: version, placeholder: '0.1.4', required }));

const filesInput = (description) => label('Attachments', description, fileUpload({ id: 'files', max: 3 }));

// Each field: [custom id, label shown in the ticket]. The order is the order in the ticket.
export const fields = {
  bug: [
    ['summary', 'Summary'],
    ['version', 'Ylide version'],
    ['system', 'Windows and GPU'],
    ['steps', 'Steps to reproduce'],
  ],
  help: [
    ['topic', 'Topic'],
    ['version', 'Ylide version'],
    ['question', 'Question'],
    ['tried', 'What I tried'],
  ],
  other: [
    ['subject', 'Subject'],
    ['message', 'Message'],
  ],
  idea: [
    ['title', 'Title'],
    ['area', 'Area'],
    ['problem', 'The problem'],
    ['idea', 'The idea'],
  ],
};

/** Modal JSON for a ticket type or "idea". `version` pre-fills the version field. */
export function modal(type, { version } = {}) {
  const forms = {
    bug: [
      label('Summary', 'What went wrong, in one sentence', textInput({ id: 'summary', max: 120, placeholder: 'The model download stops at 99 %' })),
      versionInput(version, true),
      label(
        'Windows and GPU',
        'Windows version, graphics card and driver, if you know it',
        textInput({ id: 'system', max: 200, placeholder: 'Windows 11 24H2, RTX 4070 12 GB, driver 581.57' }),
      ),
      label(
        'Steps to reproduce',
        'What did you do, what did you expect, what happened instead?',
        textInput({ id: 'steps', paragraph: true, max: 2000, placeholder: '1. Open …\n2. Click …\nExpected: …\nActual: …' }),
      ),
      filesInput('Optional: the log file from Settings > About Ylide. Check it for private data first.'),
    ],
    help: [
      label(
        'Topic',
        null,
        select({
          id: 'topic',
          placeholder: 'Choose a topic',
          options: ['Installation', 'Models and downloads', 'GPU and performance', 'Agents and chat', 'Editor', 'Updates', 'Something else'],
        }),
      ),
      versionInput(version, false),
      label('Your question', null, textInput({ id: 'question', paragraph: true, max: 2000 })),
      label('What have you tried?', 'Optional', textInput({ id: 'tried', paragraph: true, max: 1000, required: false })),
      filesInput('Optional: screenshots or log files'),
    ],
    other: [
      label('Subject', null, textInput({ id: 'subject', max: 100 })),
      label('Message', null, textInput({ id: 'message', paragraph: true, max: 2500 })),
      filesInput('Optional'),
    ],
    idea: [
      label('Title', 'A short name for your idea', textInput({ id: 'title', max: 90, placeholder: 'Pin chats to a project' })),
      label('Area', null, select({ id: 'area', placeholder: 'Which part of Ylide?', options: ideaAreas })),
      label('The problem', 'What are you trying to do, and what gets in the way?', textInput({ id: 'problem', paragraph: true, max: 1200 })),
      label('Your idea', 'How could Ylide solve it?', textInput({ id: 'idea', paragraph: true, max: 1500 })),
    ],
  };
  const title = type === 'idea' ? 'Suggest a feature' : ticketTypes[type].modalTitle;
  return { custom_id: type === 'idea' ? 'idea:form' : `ticket:form:${type}`, title, components: forms[type] };
}

/**
 * Reads a submitted form into [{ label, value }] in ticket order.
 * `read(id)` returns the text or the selected values of one field.
 */
export function readForm(type, read) {
  return fields[type].map(([id, labelText]) => {
    const raw = read(id);
    const value = Array.isArray(raw) ? raw.join(', ') : (raw ?? '');
    return { id, label: labelText, value: value.trim() };
  });
}
