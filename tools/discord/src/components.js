// Small builders for Discord's message components (Components V2) and modal
// components, as plain JSON. Plain JSON keeps the setup's comparison with the
// live messages simple. Reference: https://docs.discord.com/developers/components/reference

export const IS_COMPONENTS_V2 = 1 << 15;
export const EPHEMERAL = 1 << 6;

export const ButtonStyle = { primary: 1, secondary: 2, success: 3, danger: 4, link: 5 };

export const container = (accent, ...components) => ({ type: 17, accent_color: accent, components: components.flat().filter(Boolean) });
export const text = (content) => ({ type: 10, content });
export const separator = (big = false, divider = true) => ({ type: 14, divider, spacing: big ? 2 : 1 });
export const gallery = (...urls) => ({ type: 12, items: urls.map((url) => ({ media: { url } })) });
export const section = (accessory, ...texts) => ({ type: 9, components: texts.map(text), accessory });
export const thumbnail = (url, description) => ({ type: 11, media: { url }, ...(description ? { description } : {}) });
export const row = (...components) => ({ type: 1, components: components.flat().filter(Boolean) });

/** An emoji reference for a component, from the application emoji table. */
export const emoji = (emojis, name) => (emojis[name] ? { id: emojis[name], name } : undefined);

export function button({ id, label, style = ButtonStyle.secondary, emoji: e, url, disabled }) {
  const b = { type: 2, style: url ? ButtonStyle.link : style, label };
  if (url) b.url = url;
  else b.custom_id = id;
  if (e) b.emoji = e;
  if (disabled) b.disabled = true;
  return b;
}

// Modal parts. A Label wraps exactly one input; a modal takes at most five.
export const label = (labelText, description, component) => ({
  type: 18,
  label: labelText,
  ...(description ? { description } : {}),
  component,
});

export function textInput({ id, paragraph = false, placeholder, value, required = true, min, max }) {
  const input = { type: 4, custom_id: id, style: paragraph ? 2 : 1, required };
  if (placeholder) input.placeholder = placeholder;
  if (value) input.value = value;
  if (min !== undefined) input.min_length = min;
  if (max !== undefined) input.max_length = max;
  return input;
}

export function select({ id, options, placeholder, required = true }) {
  return {
    type: 3,
    custom_id: id,
    required,
    ...(placeholder ? { placeholder } : {}),
    options: options.map((o) => (typeof o === 'string' ? { label: o, value: o } : o)),
  };
}

export const fileUpload = ({ id, max = 3, required = false }) => ({ type: 19, custom_id: id, min_values: 0, max_values: max, required });

/** Message payload for a Components V2 message. */
export const v2 = (components, extra = {}) => ({ flags: IS_COMPONENTS_V2, components, allowed_mentions: { parse: [] }, ...extra });
