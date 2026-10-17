const MODEL_PROVIDERS = [
  ['gemini', 'Google Gemini'],
  ['openai', 'OpenAI'],
  ['anthropic', 'Anthropic'],
  ['tinker', 'Tinker'],
  ['tinfoil', 'Tinfoil (confidential)'],
  ['hosted_vllm', 'OpenAI-compatible endpoint'],
  ['lm_studio', 'LM Studio (local)'],
] as const;
const ENDPOINT_PROVIDERS = new Set(['hosted_vllm', 'lm_studio']);

export interface ModelDraft {
  id: string;
  label: string;
  provider: string;
  model: string;
  apiKey: string;
  baseUrl: string;
  supportsAudio?: boolean;
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
  routerManaged,
}: {
  value: ModelDraft;
  onChange: (next: ModelDraft) => void;
  sensing: boolean;
  onTest: () => void;
  testStatus: ConnectionTestStatus | undefined;
  routerManaged: boolean;
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
        disabled={routerManaged && sensing}
        onChange={(event) => update('provider', event.target.value)}
      >
        {MODEL_PROVIDERS.map(([id, label]) => (
          <option key={id} value={id}>
            {label}
          </option>
        ))}
      </select>
      <input
        className="ob-custom-input"
        value={value.model}
        disabled={routerManaged && sensing}
        placeholder={modelPlaceholder}
        onChange={(event) => update('model', event.target.value)}
      />
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
      {!routerManaged && value.provider !== 'lm_studio' && (
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
      {!sensing && (
        <label className="ob-default-model">
          <input
            type="checkbox"
            checked={value.supportsAudio === true}
            onChange={(event) =>
              onChange({ ...value, supportsAudio: event.target.checked })
            }
          />{' '}
          Supports audio input
        </label>
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
  error,
  testStatuses,
  onTest,
  routerManaged,
}: {
  sensing: ModelDraft;
  setSensing: (next: ModelDraft) => void;
  tutors: ModelDraft[];
  setTutors: (next: ModelDraft[]) => void;
  defaultTutorId: string;
  setDefaultTutorId: (id: string) => void;
  error: string;
  testStatuses: Record<string, ConnectionTestStatus>;
  onTest: (role: 'sensing' | 'tutor', model: ModelDraft) => void;
  routerManaged: boolean;
}) {
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
      <p className="ob-sub">
        The sensing model reads your screen to detect when help may be useful
        and curate context. Tutor models generate proactive suggestions and chat
        responses only when needed.
      </p>
      {routerManaged && (
        <div className="ob-model-warning">
          Models are provided through the CoCo Router. No personal API key is
          required.
        </div>
      )}
      <ModelFields
        value={sensing}
        onChange={setSensing}
        sensing
        onTest={() => onTest('sensing', sensing)}
        testStatus={testStatuses.sensing}
        routerManaged={routerManaged}
      />
      <div className="ob-model-section-title">Tutor models</div>
      {tutors.map((tutor, index) => (
        <div key={tutor.id} className="ob-model-wrap">
          <ModelFields
            value={tutor}
            sensing={false}
            onChange={(next) => updateTutor(index, next)}
            onTest={() => onTest('tutor', tutor)}
            testStatus={testStatuses[tutor.id]}
            routerManaged={routerManaged}
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
      {error && <div className="ob-model-error">{error}</div>}
    </>
  );
}
