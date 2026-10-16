// Picks the UI language: "System" or one of the languages Ylide speaks, each
// shown by its own name so anyone can find theirs.

import { languageName, languages } from '../i18n';
import { Select } from './ui';

export function LanguageSelect({ value, systemLabel, label, onChange }: { value: string | null | undefined; systemLabel: string; label: string; onChange: (language: string | null) => void }) {
  const current = value && (languages as readonly string[]).includes(value) ? value : 'system';
  return (
    <Select aria-label={label} value={current} onChange={(e) => onChange(e.target.value === 'system' ? null : e.target.value)}>
      <option value="system">{systemLabel}</option>
      {languages.map((code) => (
        <option key={code} value={code} lang={code}>
          {languageName(code)}
        </option>
      ))}
    </Select>
  );
}
