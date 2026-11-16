import { useRef, useState } from 'react';
import PiProviderSettings from '../chat/PiProviderSettings';
const ENDPOINT_OPTIONS = [
  ['hosted_vllm', 'OpenAI-compatible endpoint'],
  ['lm_studio', 'LM Studio (local)'],
  ['tinfoil', 'Tinfoil (confidential)'],
  ['tinker', 'Tinker'],
] as const;
interface ProviderOption {
  id: string;
  name: string;
  connected: boolean;
}
interface PiModel {
  provider: string;
  id: string;
  name: string;
  input?: string[];
}
const ENDPOINT_PROVIDERS = new Set(['hosted_vllm', 'lm_studio']);

export interface ModelDraft {
  id: string;
  label: string;
  provider: string;
  model: string;
  apiKey: string;
  baseUrl: string;
  catalogProvider?: string;
}

export interface ConnectionTestStatus {
  state: 'testing' | 'success' | 'error';
  message: string;
}

function ModelFields({
  value,
  onChange,
  sensing,
  onTest,
  testStatus,
  piModels,
  providers,
  onConnect,
}: {
  providers: ProviderOption[];
  onConnect: (provider: string) => void;
  piModels: PiModel[];
  value: ModelDraft;
  onChange: (next: ModelDraft) => void;
  sensing: boolean;
  onTest: () => void;
  testStatus: ConnectionTestStatus | undefined;
}) {
  const catalogProvider =
    value.catalogProvider ||
    (value.provider === 'pi' ? value.model.split('/')[1] : '') ||
    providers[0]?.id ||
    '';
  const selectedProvider = providers.find(
    (item) => item.id === catalogProvider,
  );
  const availableModels = piModels.filter(
    (item) =>
      item.provider === catalogProvider &&
      (!sensing || item.input?.includes('image')),
  );
  const legacyProvider =
    value.provider !== 'pi' &&
    !ENDPOINT_OPTIONS.some(([id]) => id === value.provider);
  const update = (field: keyof ModelDraft, next: string) =>
    onChange({ ...value, [field]: next });
  let modelPlaceholder = sensing
    ? 'Vision model ID (provider/model)'
    : 'Model ID (provider/model)';
  if (value.provider === 'hosted_vllm') {
    modelPlaceholder = 'Exact model ID returned by /v1/models';
  }
  return (
    <div className="ob-model-card">
      <div className="ob-model-card-title">
        {sensing ? 'Screen understanding model' : value.label || 'Chat model'}
      </div>
      {sensing && (
        <div className="ob-model-warning">
          This model receives screenshots. Choose a provider you trust.
        </div>
      )}
      {!sensing && (
        <input
          className="ob-custom-input"
          value={value.label}
          aria-label="Model display name"
          placeholder="Display name"
          onChange={(event) => update('label', event.target.value)}
        />
      )}
      <label className="coco-field">
        Provider
        <select
          className="ob-custom-input"
          aria-label={sensing ? 'Screen understanding provider' : 'Chat provider'}
          value={
            value.provider === 'pi'
              ? `catalog:${catalogProvider}`
              : value.provider
          }
          onChange={(event) => {
            const source = event.target.value;
            const catalog = source.startsWith('catalog:');
            onChange({
              ...value,
              provider: catalog ? 'pi' : source,
              catalogProvider: catalog ? source.slice(8) : undefined,
              model: '',
              apiKey: '',
              baseUrl: '',
            });
          }}
        >
          {ENDPOINT_OPTIONS.map(([id, label]) => (
            <option key={id} value={id}>
              {label}
            </option>
          ))}
          {value.provider === 'pi' &&
            !providers.some((item) => item.id === catalogProvider) && (
              <option value={`catalog:${catalogProvider}`}>
                {catalogProvider || 'Choose a provider…'}
              </option>
            )}
          {providers.map((item) => (
            <option key={item.id} value={`catalog:${item.id}`}>
              {item.name}
            </option>
          ))}
          {legacyProvider && (
            <option value={value.provider}>
              {(
                {
                  openai: 'OpenAI',
                  anthropic: 'Anthropic',
                  gemini: 'Google Gemini',
                  open_anonymity: 'Open Anonymity',
                } as Record<string, string>
              )[value.provider] || value.provider}{' '}
              (saved API connection)
            </option>
          )}
        </select>
      </label>
      {value.provider === 'pi' && (
        <div className="coco-actions">
          <span>
            {selectedProvider?.connected
              ? 'Connected'
              : 'Connect this provider to choose a model.'}
          </span>
          <button
            type="button"
            className="ob-model-add"
            onClick={() => onConnect(catalogProvider)}
          >
            {selectedProvider?.connected
              ? 'Manage connection'
              : `Connect ${selectedProvider?.name || 'provider'}`}
          </button>
        </div>
      )}
      {value.provider === 'pi' ? (
        <select
          className="ob-custom-input"
          aria-label={sensing ? 'Screen understanding model' : 'Chat model'}
          value={value.model}
          onChange={(event) => {
            const selected = piModels.find(
              (m) => `pi/${m.provider}/${m.id}` === event.target.value,
            );
            onChange({
              ...value,
              model: event.target.value,
              label: sensing ? value.label : selected?.name || value.label,
            });
          }}
        >
          <option value="">Choose a connected model…</option>
          {value.model &&
            !availableModels.some(
              (m) => `pi/${m.provider}/${m.id}` === value.model,
            ) && (
              <option value={value.model}>
                {value.model.replace(/^pi\/[^/]+\//, '')} (connect provider to
                use)
              </option>
            )}
          {availableModels.map((m) => (
            <option
              key={`${m.provider}/${m.id}`}
              value={`pi/${m.provider}/${m.id}`}
            >
              {m.name} · {m.provider}
            </option>
          ))}
        </select>
      ) : (
        <input
          className="ob-custom-input"
          value={value.model}
          aria-label={sensing ? 'Screen understanding model ID' : 'Chat model ID'}
          placeholder={modelPlaceholder}
          onChange={(event) => update('model', event.target.value)}
        />
      )}
      {ENDPOINT_PROVIDERS.has(value.provider) && (
        <input
          className="ob-custom-input"
          value={value.baseUrl}
          placeholder={
            value.provider === 'lm_studio'
              ? 'Host (default localhost:1234)'
              : 'OpenAI-compatible base URL, ending in /v1'
          }
          onChange={(event) => update('baseUrl', event.target.value)}
        />
      )}
      {value.provider !== 'lm_studio' && value.provider !== 'pi' && (
        <input
          className="ob-custom-input"
          type="password"
          value={value.apiKey}
          placeholder={
            value.provider === 'hosted_vllm' ? 'API key (optional)' : 'API key'
          }
          autoComplete="off"
          onChange={(event) => update('apiKey', event.target.value)}
        />
      )}
      <div className="ob-connection-test-row">
        <button
          type="button"
          className="ob-connection-test-btn"
          disabled={testStatus?.state === 'testing'}
          onClick={onTest}
        >
          {testStatus?.state === 'testing' ? 'Testing…' : 'Test connection'}
        </button>
        {testStatus?.state === 'success' && (
          <span className="ob-connection-test-success">
            {testStatus.message}
          </span>
        )}
        {testStatus?.state === 'error' && (
          <details className="ob-connection-test-error">
            <summary>Connection failed — show details</summary>
            <pre>{testStatus.message}</pre>
          </details>
        )}
      </div>
    </div>
  );
}

export default function ModelsStep({
  sensingEnabled,
  setSensingEnabled,
  sensing,
  setSensing,
  tutors,
  setTutors,
  defaultTutorId,
  setDefaultTutorId,
  instantSuggestionModelId,
  setInstantSuggestionModelId,
  error,
  testStatuses,
  onTest,
}: {
  sensingEnabled: boolean;
  setSensingEnabled: (enabled: boolean) => void;
  sensing: ModelDraft;
  setSensing: (next: ModelDraft) => void;
  tutors: ModelDraft[];
  setTutors: (next: ModelDraft[]) => void;
  defaultTutorId: string;
  instantSuggestionModelId: string;
  setInstantSuggestionModelId: (id: string) => void;
  setDefaultTutorId: (id: string) => void;
  error: string;
  testStatuses: Record<string, ConnectionTestStatus>;
  onTest: (role: 'sensing' | 'tutor', model: ModelDraft) => void;
}) {
  const [piStatus, setPiStatus] = useState<any>(null);
  const [accountProvider, setAccountProvider] = useState('');
  const accounts = useRef<HTMLDetailsElement>(null);
  const providers: ProviderOption[] = piStatus?.providers ?? [];
  const connectProvider = (provider: string) => {
    setAccountProvider(provider);
    if (accounts.current) {
      accounts.current.open = true;
      accounts.current.scrollIntoView?.({ block: 'nearest' });
      accounts.current.querySelector<HTMLSelectElement>('select')?.focus();
    }
  };
  const piModels: PiModel[] = (piStatus?.models ?? []).filter(
    (model: PiModel) =>
      piStatus.providers.some(
        (provider: any) => provider.id === model.provider && provider.connected,
      ),
  );
  const addConnection = (connection: ModelDraft) => {
    setTutors([...tutors, connection]);
    if (!defaultTutorId) setDefaultTutorId(connection.id);
  };
  const addModel = () =>
    addConnection({
      id: `model-${Date.now()}`,
      label: '',
      provider: 'hosted_vllm',
      model: '',
      apiKey: '',
      baseUrl: '',
    });
  const renderChatModel = (tutor: ModelDraft) => (
    <div key={tutor.id} className="ob-model-wrap">
      <ModelFields
        piModels={piModels}
        providers={providers}
        onConnect={connectProvider}
        value={tutor}
        sensing={false}
        onChange={(next) =>
          setTutors(tutors.map((item) => (item.id === tutor.id ? next : item)))
        }
        onTest={() => onTest('tutor', tutor)}
        testStatus={testStatuses[tutor.id]}
      />
      <div className="ob-model-actions">
        <label htmlFor={`default-${tutor.id}`}>
          <input
            id={`default-${tutor.id}`}
            type="radio"
            name="default-chat-model"
            checked={defaultTutorId === tutor.id}
            onChange={() => setDefaultTutorId(tutor.id)}
          />{' '}
          Default for new chats
        </label>
        <button
          type="button"
          className="ob-model-remove"
          aria-label={`Remove ${tutor.label || 'model'}`}
          onClick={() => {
            const next = tutors.filter((item) => item.id !== tutor.id);
            setTutors(next);
            if (instantSuggestionModelId === tutor.id)
              setInstantSuggestionModelId('');
            if (defaultTutorId === tutor.id)
              setDefaultTutorId(next[0]?.id || '');
          }}
        >
          Remove
        </button>
      </div>
    </div>
  );
  return (
    <>
      <section aria-labelledby="chat-models-heading">
        <h3 id="chat-models-heading" className="ob-model-section-title">
          Chat models
        </h3>
        <p className="ob-sub">
          Add models from any provider, then choose a default for new chats.
        </p>
        <details ref={accounts} className="ob-provider-disclosure">
          <summary className="ob-model-add">Manage provider accounts</summary>
          <PiProviderSettings
            onStatus={setPiStatus}
            selectedProvider={accountProvider}
            onProviderChange={setAccountProvider}
          />
        </details>
        {tutors.map(renderChatModel)}
        <button type="button" className="ob-model-add" onClick={addModel}>
          + Add model
        </button>
      </section>
      <h3 className="ob-model-section-title">Optional screen understanding</h3>
      <label className="coco-field">
        <span>
          <input
            type="checkbox"
            checked={sensingEnabled}
            onChange={(event) => setSensingEnabled(event.target.checked)}
          />{' '}
          Enable screen understanding (optional)
        </span>
      </label>
      <p className="ob-sub">
        You can use Coco for chat without a screen understanding model. Without this
        connection, proactive suggestions and self-evolving memory are
        unavailable. Connect a screen understanding model later when you have a provider you
        trust with your screen.
      </p>
      {sensingEnabled && (
        <>
          <label className="coco-field">
            Reuse a configured model for screen understanding
            <select
              className="ob-custom-input"
              value=""
              onChange={(event) => {
                const selected = tutors.find(
                  (item) => item.id === event.target.value,
                );
                if (selected)
                  setSensing({ ...selected, id: 'sensing', label: 'Screen understanding' });
              }}
            >
              <option value="">Choose a model or configure below…</option>
              {tutors
                .filter(
                  (item) =>
                    item.model &&
                    (item.provider !== 'pi' ||
                      piModels.some(
                        (m) =>
                          `pi/${m.provider}/${m.id}` === item.model &&
                          m.input?.includes('image'),
                      )),
                )
                .map((item) => (
                  <option key={item.id} value={item.id}>
                    {item.label}
                  </option>
                ))}
            </select>
          </label>
          <ModelFields
            piModels={piModels}
            providers={providers}
            onConnect={connectProvider}
            value={sensing}
            onChange={setSensing}
            sensing
            onTest={() => onTest('sensing', sensing)}
            testStatus={testStatuses.sensing}
          />
        </>
      )}
      {sensingEnabled && (
        <label className="coco-field">
          Instant suggestion model
          <select
            className="ob-custom-input"
            value={instantSuggestionModelId}
            onChange={(event) =>
              setInstantSuggestionModelId(event.target.value)
            }
          >
            <option value="">Use default chat model</option>
            {tutors.map((item) => (
              <option key={item.id} value={item.id}>
                {item.label || 'Unnamed model'}
              </option>
            ))}
          </select>
        </label>
      )}
      {error && <div className="ob-model-error">{error}</div>}
    </>
  );
}
