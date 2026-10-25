import { useEffect, useState } from 'react';
import type { TutorModelOption } from './types';
import './LocalModelPicker.css';

export default function LocalModelPicker({
  value,
  disabled,
  onChange,
  refreshKey,
}: {
  value: string;
  disabled: boolean;
  onChange: (id: string) => void;
  refreshKey: boolean;
}) {
  const [models, setModels] = useState<TutorModelOption[]>([]);
  const [nativeModel, setNativeModel] = useState('');
  const [error, setError] = useState('');
  const [switching, setSwitching] = useState(false);
  useEffect(() => {
    let active = true;
    window.electron?.ipcRenderer
      .invoke('pi-provider', 'status')
      .then((result: any) => {
        if (active)
          setNativeModel(
            result?.connection?.mode === 'native'
              ? `${result.connection.provider} / ${result.connection.model}`
              : '',
          );
      })
      .catch(() => {});
    window.electron?.ipcRenderer
      .invoke('get-model-configuration')
      .then((config: any) => {
        if (active) setModels(config?.tutors ?? []);
      })
      .catch(() => {});
    return () => {
      active = false;
    };
  }, [refreshKey]);
  const selected = models.find((model) => model.id === value);
  if (nativeModel)
    return (
      <div className="tutor-model-picker">
        <span className="local-model-picker__native" title={nativeModel}>
          Pi · {nativeModel}
        </span>
      </div>
    );
  if (!models.length) return null;
  return (
    <div className="tutor-model-picker" data-testid="composer-model-selector">
      <select
        aria-label="Tutor model"
        value={value}
        title={
          selected
            ? `${selected.label}\nProvider: ${selected.provider}\nModel: ${selected.model}${selected.baseUrl ? `\nEndpoint: ${selected.baseUrl}` : ''}`
            : 'Tutor model'
        }
        disabled={disabled || switching}
        onChange={async (event) => {
          setSwitching(true);
          setError('');
          try {
            const result = (await window.electron?.ipcRenderer.invoke(
              'set-chat-model',
              { modelId: event.target.value },
            )) as { success?: boolean; modelId?: string; error?: string };
            if (!result?.success || !result.modelId)
              throw new Error(result?.error ?? 'Could not change model.');
            onChange(result.modelId);
          } catch (err) {
            setError(String(err));
          } finally {
            setSwitching(false);
          }
        }}
      >
        {models.map((model) => (
          <option key={model.id} value={model.id}>
            {model.label}
          </option>
        ))}
      </select>
      {switching && <span role="status">Switching model…</span>}
      {error && <span role="alert">{error}</span>}
    </div>
  );
}
