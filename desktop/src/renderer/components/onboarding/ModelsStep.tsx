import { useState } from 'react';
import PiProviderSettings from '../chat/PiProviderSettings';
const ADDITIONAL_PROVIDERS = [
  ['tinker', 'Tinker'],
  ['tinfoil', 'Tinfoil (confidential)'],
  ['hosted_vllm', 'OpenAI-compatible endpoint'],
  ['lm_studio', 'LM Studio (local)'],
] as const;
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
}: {
  piModels: PiModel[];
  value: ModelDraft;
  onChange: (next: ModelDraft) => void;
  sensing: boolean;
  onTest: () => void;
  testStatus: ConnectionTestStatus | undefined;
}) {
  const legacyProvider =
    value.provider !== 'pi' &&
    !ADDITIONAL_PROVIDERS.some(([id]) => id === value.provider);
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
        {sensing ? 'Sensing model' : value.label || 'Additional model'}
      </div>
      {sensing && (
        <div className="ob-model-warning">
          This model receives screenshots. Choose a vision-capable model and a
          provider you trust.
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
      {legacyProvider && (
        <p className="ob-sub">
          Existing direct connection. You can keep using it or connect this
          provider through Pi above.
        </p>
      )}
      {(sensing || value.provider !== 'pi') && (
        <select
          className="ob-custom-input"
          aria-label={sensing ? 'Sensing provider' : 'Additional provider'}
          value={value.provider}
          onChange={(event) =>
            onChange({
              ...value,
              provider: event.target.value,
              model: '',
              apiKey: '',
              baseUrl: '',
            })
          }
        >
          {sensing && <option value="pi">Connected through Pi</option>}
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
              (existing connection)
            </option>
          )}
          {ADDITIONAL_PROVIDERS.map(([id, label]) => (
            <option key={id} value={id}>
              {label}
            </option>
          ))}
        </select>
      )}
      {value.provider === 'pi' ? (
        <select
          className="ob-custom-input"
          aria-label={sensing ? 'Sensing Pi model' : 'Chat Pi model'}
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
            !piModels.some(
              (m) => `pi/${m.provider}/${m.id}` === value.model,
            ) && (
              <option value={value.model}>
                {value.model} (connect provider to use)
              </option>
            )}
          {piModels
            .filter((m) => !sensing || m.input?.includes('image'))
            .map((m) => (
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
          aria-label={sensing ? 'Sensing model ID' : 'Additional model ID'}
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
  const addAdditional = () =>
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
      <section aria-labelledby="pi-connections-heading">
        <h3 id="pi-connections-heading" className="ob-model-section-title">
          Pi connections
        </h3>
        <p className="ob-sub">
          Connect OpenAI, Anthropic, Google, and other Pi providers, then add
          the models you want in Coco chat.
        </p>
        <details className="ob-provider-disclosure">
          <summary className="ob-model-add">Connect a provider</summary>
          <PiProviderSettings onStatus={setPiStatus} />
        </details>
        {tutors.filter((item) => item.provider === 'pi').map(renderChatModel)}
        <label className="coco-field">
          Add a Pi model to chat
          <select
            className="ob-custom-input"
            value=""
            onChange={(event) => {
              const selected = piModels.find(
                (model) =>
                  `pi/${model.provider}/${model.id}` === event.target.value,
              );
              if (!selected) return;
              addConnection({
                id: `pi-${Date.now()}`,
                label: selected.name,
                provider: 'pi',
                model: event.target.value,
                apiKey: '',
                baseUrl: '',
              });
            }}
          >
            <option value="">Choose a connected model…</option>
            {piModels
              .filter(
                (model) =>
                  !tutors.some(
                    (item) => item.model === `pi/${model.provider}/${model.id}`,
                  ),
              )
              .map((model) => (
                <option
                  key={`${model.provider}/${model.id}`}
                  value={`pi/${model.provider}/${model.id}`}
                >
                  {model.name} · {model.provider}
                </option>
              ))}
          </select>
        </label>
        {!piModels.length && (
          <p className="ob-sub">
            Connect a provider above to load its models. Additional connections
            below also work without Pi.
          </p>
        )}
      </section>
      <section aria-labelledby="additional-connections-heading">
        <h3
          id="additional-connections-heading"
          className="ob-model-section-title"
        >
          Additional model connections
        </h3>
        <p className="ob-sub">
          Add Tinker, Tinfoil, LM Studio, or a custom OpenAI-compatible endpoint.
          These models appear alongside Pi models in the chat picker.
        </p>
        {tutors.filter((item) => item.provider !== 'pi').map(renderChatModel)}
        <button type="button" className="ob-model-add" onClick={addAdditional}>
          + Add model connection
        </button>
      </section>
      <h3 className="ob-model-section-title">Optional sensing</h3>
      <label className="coco-field">
        <span>
          <input
            type="checkbox"
            checked={sensingEnabled}
            onChange={(event) => setSensingEnabled(event.target.checked)}
          />{' '}
          Enable screen sensing (optional)
        </span>
      </label>
      <p className="ob-sub">
        You can use Coco for chat without a sensing model. Without this
        connection, proactive suggestions and self-evolving memory are
        unavailable. Connect a sensing model later when you have a provider you
        trust with your screen.
      </p>
      {sensingEnabled && (
        <>
          <label className="coco-field">
            Reuse a configured model for sensing
            <select
              className="ob-custom-input"
              value=""
              onChange={(event) => {
                const selected = tutors.find(
                  (item) => item.id === event.target.value,
                );
                if (selected)
                  setSensing({ ...selected, id: 'sensing', label: 'Sensing' });
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
