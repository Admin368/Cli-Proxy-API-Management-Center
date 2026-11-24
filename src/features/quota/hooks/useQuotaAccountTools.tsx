import { useCallback } from 'react';
import { useTranslation } from 'react-i18next';
import { useAuthFilesData } from '@/features/authFiles/hooks/useAuthFilesData';
import { useAuthFilesModels } from '@/features/authFiles/hooks/useAuthFilesModels';
import { useAuthFilesPrefixProxyEditor } from '@/features/authFiles/hooks/useAuthFilesPrefixProxyEditor';
import { AuthFileModelsModal } from '@/features/authFiles/components/AuthFileModelsModal';
import { AuthFileDetailsSheet } from '@/features/authFiles/components/AuthFileDetailsSheet';
import { invalidateAuthFileDerivedCaches } from '@/features/authFiles/cacheInvalidation';
import { getAuthFileRefreshKey } from '@/features/authFiles/manualRefresh';
import {
  isRuntimeOnlyAuthFile,
  normalizeProviderKey,
  supportsAuthFileManualRefresh,
} from '@/features/authFiles/constants';
import { Button } from '@/components/ui/Button';
import { ToggleSwitch } from '@/components/ui/ToggleSwitch';
import {
  IconDownload,
  IconModelCluster,
  IconRefreshCw,
  IconSettings,
  IconTrash2,
} from '@/components/ui/icons';
import { useConfigStore, useNotificationStore } from '@/stores';
import { copyToClipboard } from '@/utils/clipboard';
import type { AuthFileItem } from '@/types';
import styles from '../components/QuotaAccountTools.module.scss';

export function useQuotaAccountTools(disabled: boolean, reload: () => Promise<void>) {
  const { t } = useTranslation();
  const models = useAuthFilesModels();
  const config = useConfigStore((state) => state.config);
  const mutated = useCallback(
    (names?: string[]) => {
      invalidateAuthFileDerivedCaches(models.invalidateModels, names);
      void reload();
    },
    [models.invalidateModels, reload]
  );
  // This hook does not auto-load inventory; only explicit account actions use its handlers.
  const data = useAuthFilesData({ onFilesMutated: mutated });
  const editor = useAuthFilesPrefixProxyEditor({
    disableControls: disabled,
    loadFiles: reload,
    onFilesMutated: mutated,
  });
  const copy = async (text: string) => {
    const success = await copyToClipboard(text);
    useNotificationStore
      .getState()
      .showNotification(
        t(success ? 'notification.link_copied' : 'notification.copy_failed'),
        success ? 'success' : 'error'
      );
  };
  const busy =
    data.deleting !== null ||
    Object.values(data.manualRefreshing).some(Boolean) ||
    Object.values(data.statusUpdating).some(Boolean) ||
    Boolean(editor.prefixProxyEditor?.saving);
  const actionsFor = (file: AuthFileItem) => {
    const runtime = isRuntimeOnlyAuthFile(file);
    const key = getAuthFileRefreshKey(file);
    const pending =
      data.manualRefreshing[key] || data.statusUpdating[key] || data.deleting === file.name;
    const blocked = disabled || Boolean(pending);
    return (
      <div className={styles.tools}>
        {(!runtime || normalizeProviderKey(String(file.type)) === 'aistudio') && (
          <Button
            size="sm"
            variant="secondary"
            disabled={blocked}
            onClick={() => {
              void useConfigStore
                .getState()
                .fetchConfig()
                .catch(() => {});
              void models.showModels(file);
            }}
            title={t('auth_files.models_button')}
          >
            <IconModelCluster size={13} />
            {t('auth_files.models_button')}
          </Button>
        )}
        {!runtime && (
          <>
            {supportsAuthFileManualRefresh(file.type ?? file.provider) && (
              <Button
                size="sm"
                variant="secondary"
                disabled={blocked || file.disabled}
                onClick={() => void data.handleManualRefresh(file)}
                aria-label={t('auth_files.manual_refresh_button')}
                title={t('auth_files.manual_refresh_button')}
              >
                <IconRefreshCw size={13} />
              </Button>
            )}
            <Button
              size="sm"
              variant="secondary"
              disabled={blocked}
              onClick={() => void data.handleDownload(file.name)}
              aria-label={t('auth_files.download_button')}
              title={t('auth_files.download_button')}
            >
              <IconDownload size={13} />
            </Button>
            <Button
              size="sm"
              variant="secondary"
              disabled={blocked}
              onClick={() => void editor.openPrefixProxyEditor(file)}
              aria-label={t('auth_files.prefix_proxy_button')}
              title={t('auth_files.prefix_proxy_button')}
            >
              <IconSettings size={13} />
            </Button>
            <Button
              size="sm"
              variant="danger"
              disabled={blocked}
              onClick={() => data.handleDelete(file.name)}
              aria-label={t('auth_files.delete_button')}
              title={t('auth_files.delete_button')}
            >
              <IconTrash2 size={13} />
            </Button>
            <span className={styles.enabled}>
              <span>{t('auth_files.status_toggle_label')}</span>
              <ToggleSwitch
                checked={!file.disabled}
                disabled={blocked}
                ariaLabel={t('auth_files.card_toggle', { name: file.name })}
                onChange={(enabled) => void data.handleStatusToggle(file, enabled).then(reload)}
              />
            </span>
          </>
        )}
      </div>
    );
  };
  const dialogs = (
    <>
      <AuthFileModelsModal
        open={models.modelsModalOpen}
        fileName={models.modelsFileName}
        fileType={models.modelsFileType}
        loading={models.modelsLoading}
        error={models.modelsError}
        models={models.modelsList}
        excluded={config?.oauthExcludedModels ?? {}}
        onClose={models.closeModelsModal}
        onCopyText={(text) => void copy(text)}
      />
      <AuthFileDetailsSheet
        disableControls={disabled}
        editor={editor.prefixProxyEditor}
        updatedText={editor.prefixProxyUpdatedText}
        dirty={editor.prefixProxyDirty}
        onClose={editor.closePrefixProxyEditor}
        onCopyText={copy}
        onSave={() => void editor.handlePrefixProxySave()}
        onChange={editor.handlePrefixProxyChange}
      />
    </>
  );
  return { actionsFor, dialogs, busy };
}
