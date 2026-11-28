import { useState } from 'react';
import { useTranslation } from 'react-i18next';
import { Input } from '@/components/ui/Input';
import { Button } from '@/components/ui/Button';
import { desktopUsageUrl } from '@/services/api/desktopUsage';
import type { DesktopUsageConnection } from './desktopConnection';

export function DesktopUsageSettings({
  connection,
  onChange,
  disabled,
  className,
}: {
  connection: DesktopUsageConnection | null;
  onChange: (value: DesktopUsageConnection | null) => void;
  disabled: boolean;
  className?: string;
}) {
  const { t } = useTranslation();
  const [url, setUrl] = useState('http://127.0.0.1:8318');
  const [token, setToken] = useState('');
  const [error, setError] = useState(false);
  return (
    <details
      className={className}
      onKeyDown={(event) => {
        if (event.key === 'Escape') {
          event.currentTarget.open = false;
          event.currentTarget.querySelector('summary')?.focus();
        }
      }}
    >
      <summary>{t('usage.desktop_settings')}</summary>
      <div>
        <p>{t('usage.desktop_hint')}</p>
        <p>{t('usage.history_hint')}</p>
        {connection ? (
          <>
            <p>
              {connection.kind === 'plugin'
                ? t('usage.desktop_connected_plugin')
                : t('usage.desktop_connected', { url: connection.url })}
            </p>
            <Button disabled={disabled} onClick={() => onChange(null)}>
              {t('usage.desktop_disconnect')}
            </Button>
          </>
        ) : (
          <>
            <p>{t('usage.desktop_plugin_hint')}</p>
            <Button disabled={disabled} onClick={() => onChange({ kind: 'plugin' })}>
              {t('usage.desktop_use_plugin')}
            </Button>
            <form
              onSubmit={(event) => {
                event.preventDefault();
                try {
                  const normalized = desktopUsageUrl(url);
                  if (token.trim().length < 32) throw new Error('Invalid token');
                  onChange({ kind: 'helper', url: normalized, token: token.trim() });
                  setToken('');
                  setError(false);
                } catch {
                  setError(true);
                }
              }}
            >
              <Input
                label={t('usage.desktop_url')}
                value={url}
                onChange={(event) => setUrl(event.target.value)}
                disabled={disabled}
                required
              />
              <Input
                label={t('usage.desktop_token')}
                type="password"
                autoComplete="off"
                value={token}
                onChange={(event) => setToken(event.target.value)}
                disabled={disabled}
                required
              />
              {error && <p role="alert">{t('usage.desktop_invalid')}</p>}
              <Button type="submit" disabled={disabled}>
                {t('usage.desktop_connect')}
              </Button>
            </form>
          </>
        )}
        <p>{t('usage.retention')}</p>
      </div>
    </details>
  );
}
