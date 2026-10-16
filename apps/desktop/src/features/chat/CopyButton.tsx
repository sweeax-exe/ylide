import { Check, Copy } from 'lucide-react';
import { useEffect, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { IconButton } from '../../components/ui';
import { reportError } from '../../lib/errors';

/** Copies `text`; the icon confirms for a moment. */
export function CopyButton({ text, label }: { text: string; label: string }) {
  const { t } = useTranslation('chat');
  const [copied, setCopied] = useState(false);

  useEffect(() => {
    if (!copied) return;
    const timer = setTimeout(() => setCopied(false), 1500);
    return () => clearTimeout(timer);
  }, [copied]);

  const copy = () => {
    navigator.clipboard.writeText(text).then(() => setCopied(true), reportError);
  };

  return (
    <IconButton label={copied ? t('common:actions.copied') : label} onClick={copy}>
      {copied ? <Check size={14} /> : <Copy size={14} />}
    </IconButton>
  );
}
