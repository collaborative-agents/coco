import { useState } from 'react';
import PiProviderSettings from '../chat/PiProviderSettings';
const MODEL_PROVIDERS = [
  ['pi', 'Connected through Pi'],
  ['gemini', 'Google Gemini'],
  ['openai', 'OpenAI'],
  ['anthropic', 'Anthropic'],
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
        {sensing ? 'Sensitive sensing model' : value.label || 'Tutor model'}
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
          placeholder="Display name, e.g. Claude Sonnet"
          onChange={(event) => update('label', event.target.value)}
        />
      )}
      <select
        className="ob-custom-input"
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
        {MODEL_PROVIDERS.map(([id, label]) => (
          <option key={id} value={id}>
            {label}
          </option>
        ))}
      </select>
      {value.provider === 'pi' ? (
        <select
          className="ob-custom-input"
          aria-label={sensing ? 'Sensing Pi model' : 'Tutor Pi model'}
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
  const updateTutor = (index: number, next: ModelDraft) =>
    setTutors(tutors.map((item, i) => (i === index ? next : item)));
  const addTutor = () => {
    const id = `tutor-${Date.now()}`;
    setTutors([
      ...tutors,
      {
        id,
        label: '',
        provider: 'anthropic',
        model: '',
        apiKey: '',
        baseUrl: '',
      },
    ]);
  };
  return (
    <>
      <PiProviderSettings onStatus={setPiStatus} />
      <p className="ob-sub">
        The sensing model reads your screen to detect when help may be useful
        and curate context. Tutor models generate proactive suggestions and chat
        responses only when needed.
      </p>
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
      <div className="ob-model-section-title">Tutor models</div>
      {tutors.map((tutor, index) => (
        <div key={tutor.id} className="ob-model-wrap">
          <ModelFields
            piModels={piModels}
            value={tutor}
            sensing={false}
            onChange={(next) => updateTutor(index, next)}
            onTest={() => onTest('tutor', tutor)}
            testStatus={testStatuses[tutor.id]}
          />
          <div className="ob-model-actions">
            <label htmlFor={`default-${tutor.id}`}>
              <input
                id={`default-${tutor.id}`}
                type="radio"
                name="default-tutor"
                checked={defaultTutorId === tutor.id}
                onChange={() => setDefaultTutorId(tutor.id)}
              />{' '}
              Default for new chats
            </label>
            {tutors.length > 1 && (
              <button
                type="button"
                className="ob-model-remove"
                onClick={() => {
                  const next = tutors.filter((item) => item.id !== tutor.id);
                  setTutors(next);
                  if (instantSuggestionModelId === tutor.id)
                    setInstantSuggestionModelId('');
                  if (defaultTutorId === tutor.id)
                    setDefaultTutorId(next[0].id);
                }}
              >
                Remove
              </button>
            )}
          </div>
        </div>
      ))}
      <button type="button" className="ob-model-add" onClick={addTutor}>
        + Add another tutor model
      </button>
      <label className="coco-field">
        Instant suggestion model
        <select
          className="ob-custom-input"
          value={instantSuggestionModelId}
          onChange={(event) => setInstantSuggestionModelId(event.target.value)}
        >
          <option value="">Use default chat model</option>
          {tutors.map((item) => (
            <option key={item.id} value={item.id}>
              {item.label || 'Unnamed model'}
            </option>
          ))}
        </select>
      </label>
      {error && <div className="ob-model-error">{error}</div>}
    </>
  );
}
