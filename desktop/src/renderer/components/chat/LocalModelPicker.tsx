import { useEffect, useState } from 'react';
import type { TutorModelOption } from './types';
import './LocalModelPicker.css';
import ThinkingPicker from './ThinkingPicker';
import {
  isHostedQwen,
  type ModelThinking,
} from '../../../shared/model-thinking';

export default function LocalModelPicker({
  value,
  disabled,
  onChange,
  refreshKey,
  thinking = 'default',
  onThinkingChange,
}: {
  value: string;
  disabled: boolean;
  onChange: (id: string) => void;
  refreshKey: boolean;
  thinking?: ModelThinking;
  onThinkingChange?: (value: ModelThinking) => void;
}) {
  const [models, setModels] = useState<TutorModelOption[]>([]);
  const [defaultModelId, setDefaultModelId] = useState('');
  const [nativeModel, setNativeModel] = useState('');
  const [nativeId, setNativeId] = useState('');
  const [capabilities, setCapabilities] = useState<
    Record<
      string,
      { thinkingLevels: ModelThinking[]; defaultThinking: ModelThinking }
    >
  >({});
  const [error, setError] = useState('');
  const [switching, setSwitching] = useState(false);
  useEffect(() => {
    let active = true;
    const refresh = () => {
      window.electron?.ipcRenderer
        .invoke('pi-provider', 'status')
        .then((result: any) => {
          if (active) {
            setCapabilities(
              Object.fromEntries(
                (result?.models ?? []).map((model: any) => [
                  `pi/${model.provider}/${model.id}`,
                  {
                    thinkingLevels: model.thinkingLevels ?? [],
                    defaultThinking: model.defaultThinking ?? 'off',
                  },
                ]),
              ),
            );
            setNativeId(
              result?.connection?.mode === 'native'
                ? `pi/${result.connection.provider}/${result.connection.model}`
                : '',
            );
            setNativeModel(
              result?.connection?.mode === 'native'
                ? `${result.connection.provider} / ${result.connection.model}`
                : '',
            );
          }
        })
        .catch(() => {});
      window.electron?.ipcRenderer
        .invoke('get-model-configuration')
        .then((config: any) => {
          if (active) {
            setModels(config?.tutors ?? []);
            setDefaultModelId(config?.defaultTutorId ?? '');
          }
        })
        .catch(() => {});
    };
    refresh();
    window.addEventListener('focus', refresh);
    return () => {
      active = false;
      window.removeEventListener('focus', refresh);
    };
  }, [refreshKey]);
  const selected = models.find(
    (model) => model.id === (value || defaultModelId),
  );
  const providerLabel =
    selected?.provider === 'pi'
      ? selected.model.split('/')[1]
      : selected?.provider;
  const modelLabel =
    selected?.provider === 'pi'
      ? selected.model.split('/').slice(2).join('/')
      : selected?.model;
  const capability =
    selected && isHostedQwen(selected.provider, selected.model)
      ? {
          thinkingLevels: ['off', 'on'] as ModelThinking[],
          defaultThinking: 'off' as ModelThinking,
        }
      : capabilities[selected?.model ?? nativeId];
  const supportedThinking = capability?.thinkingLevels.join(',');
  useEffect(() => {
    if (
      supportedThinking !== undefined &&
      thinking !== 'default' &&
      !supportedThinking.split(',').includes(thinking)
    )
      onThinkingChange?.('default');
  }, [supportedThinking, thinking, onThinkingChange]);
  const modelSelector = models.length ? (
    <select
      aria-label="Chat model"
      value={value || defaultModelId}
      title={
        selected
          ? `${selected.label}\nProvider: ${providerLabel}\nModel: ${modelLabel}${selected.baseUrl ? `\nEndpoint: ${selected.baseUrl}` : ''}`
          : 'Chat model'
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
  ) : (
    <span className="local-model-picker__native">{nativeModel}</span>
  );
  if (!models.length && !nativeModel) return null;
  return (
    <div className="tutor-model-picker" data-testid="composer-model-selector">
      {onThinkingChange &&
      capability?.thinkingLevels.some((level) => level !== 'off') ? (
        <ThinkingPicker
          modelLabel={selected?.label || nativeModel}
          modelSelector={modelSelector}
          value={thinking}
          levels={capability.thinkingLevels}
          defaultLevel={capability.defaultThinking}
          disabled={disabled || switching}
          onChange={onThinkingChange}
        />
      ) : (
        modelSelector
      )}
      {switching && <span role="status">Switching model…</span>}
      {error && <span role="alert">{error}</span>}
    </div>
  );
}
