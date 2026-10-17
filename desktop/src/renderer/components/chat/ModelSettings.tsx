import type React from 'react';
import { S } from './styles';
import type { TutorModelOption, ConnectionTestStatus } from './types';
import { MODEL_PROVIDER_OPTIONS, MODEL_ENDPOINT_PROVIDERS } from './constants';

interface Props {
  routerManaged: boolean;
  modelConfigLoading: boolean;
  modelLoadError: string;
  sensingModel: TutorModelOption;
  setSensingModel: React.Dispatch<React.SetStateAction<TutorModelOption>>;
  modelCredentials: Record<string, string>;
  setModelCredentials: React.Dispatch<
    React.SetStateAction<Record<string, string>>
  >;
  connectionTests: Record<string, ConnectionTestStatus>;
  testSettingsModelConnection: (
    role: 'sensing' | 'tutor',
    model: TutorModelOption,
  ) => Promise<void>;
  tutorModels: TutorModelOption[];
  setTutorModels: React.Dispatch<React.SetStateAction<TutorModelOption[]>>;
  defaultTutorModelId: string;
  setDefaultTutorModelId: React.Dispatch<React.SetStateAction<string>>;
  saveModelSettings: () => Promise<void>;
  modelSavedFlash: boolean;
  modelSaveError: string;
}

export default function ModelSettings({
  routerManaged,
  modelConfigLoading,
  modelLoadError,
  sensingModel,
  setSensingModel,
  modelCredentials,
  setModelCredentials,
  connectionTests,
  testSettingsModelConnection,
  tutorModels,
  setTutorModels,
  defaultTutorModelId,
  setDefaultTutorModelId,
  saveModelSettings,
  modelSavedFlash,
  modelSaveError,
}: Props) {
  return (
    <section className="workspace-settings-section">
      <div style={S.groupLabel}>Models &amp; providers</div>
      <div style={S.helpText}>
        {routerManaged
          ? 'Models use the managed CoCo Router. Personal API keys are not required; the sensing model is fixed, while Gemini tutor models remain configurable.'
          : 'Models connect directly using the provider, endpoint, and API key entered here. Saving bypasses the managed router and restarts the sensing and tutor services.'}
      </div>
      {modelConfigLoading && (
        <div style={{ ...S.helpText, marginTop: 8 }}>
          Loading model settings…
        </div>
      )}
      {modelLoadError && (
        <div
          style={{
            color: '#b45309',
            fontSize: 'var(--coco-text-secondary)',
            margin: '8px 0',
          }}
        >
          {modelLoadError}
        </div>
      )}
      <div style={S.customForm}>
        <select
          style={S.customInput}
          value={sensingModel.provider}
          disabled={routerManaged}
          onChange={(event) =>
            setSensingModel({
              ...sensingModel,
              provider: event.target.value,
            })
          }
        >
          {MODEL_PROVIDER_OPTIONS.map(([id, label]) => (
            <option key={id} value={id}>
              {label}
            </option>
          ))}
        </select>
        <input
          style={S.customInput}
          value={sensingModel.model}
          disabled={routerManaged}
          placeholder={
            sensingModel.provider === 'hosted_vllm'
              ? 'Exact model ID returned by /v1/models'
              : 'Vision-capable sensing model'
          }
          onChange={(event) =>
            setSensingModel({
              ...sensingModel,
              model: event.target.value,
            })
          }
        />
        {!routerManaged &&
          MODEL_ENDPOINT_PROVIDERS.has(sensingModel.provider) && (
            <input
              style={S.customInput}
              value={sensingModel.baseUrl ?? ''}
              placeholder={
                sensingModel.provider !== 'lm_studio'
                  ? 'OpenAI-compatible base URL, ending in /v1'
                  : 'LM Studio host'
              }
              onChange={(event) =>
                setSensingModel({
                  ...sensingModel,
                  baseUrl: event.target.value,
                })
              }
            />
          )}
        {!routerManaged && sensingModel.provider !== 'lm_studio' && (
          <input
            style={S.customInput}
            type="password"
            value={modelCredentials[`sensing:${sensingModel.provider}`] ?? ''}
            placeholder={
              sensingModel.provider === 'hosted_vllm'
                ? 'Endpoint API key (optional; blank keeps the saved key)'
                : 'Replace sensing API key (leave blank to keep it)'
            }
            onChange={(event) =>
              setModelCredentials((current) => ({
                ...current,
                [`sensing:${sensingModel.provider}`]: event.target.value,
              }))
            }
          />
        )}
        <div style={S.connectionTestRow}>
          <button
            type="button"
            style={{
              ...S.connectionTestButton,
              ...(connectionTests.sensing?.state === 'testing'
                ? S.sendBtnDisabled
                : {}),
            }}
            aria-label="Test sensing model connection"
            disabled={connectionTests.sensing?.state === 'testing'}
            onClick={() =>
              void testSettingsModelConnection('sensing', sensingModel)
            }
          >
            {connectionTests.sensing?.state === 'testing'
              ? 'Testing…'
              : 'Test connection'}
          </button>
          {connectionTests.sensing?.state === 'success' && (
            <span style={S.connectionTestSuccess}>
              {connectionTests.sensing.message}
            </span>
          )}
          {connectionTests.sensing?.state === 'error' && (
            <details style={S.connectionTestError}>
              <summary>Connection failed — show details</summary>
              <pre style={S.connectionTestErrorText}>
                {connectionTests.sensing.message}
              </pre>
            </details>
          )}
        </div>
      </div>

      <div style={S.helpText}>
        Tutor models answer in chat. Configure multiple models, choose a
        default, and switch between them anytime.
      </div>
      {tutorModels.map((model, index) => (
        <div key={model.id} style={S.customForm}>
          <input
            style={S.customInput}
            value={model.label}
            placeholder="Display name"
            onChange={(event) =>
              setTutorModels((current) =>
                current.map((item, i) =>
                  i === index ? { ...item, label: event.target.value } : item,
                ),
              )
            }
          />
          <select
            style={S.customInput}
            value={model.provider}
            disabled={routerManaged}
            onChange={(event) =>
              setTutorModels((current) =>
                current.map((item, i) =>
                  i === index
                    ? { ...item, provider: event.target.value }
                    : item,
                ),
              )
            }
          >
            {(routerManaged
              ? MODEL_PROVIDER_OPTIONS.filter(([id]) => id === 'gemini')
              : MODEL_PROVIDER_OPTIONS
            ).map(([id, label]) => (
              <option key={id} value={id}>
                {label}
              </option>
            ))}
          </select>
          <input
            style={S.customInput}
            value={model.model}
            placeholder={
              model.provider === 'hosted_vllm'
                ? 'Exact model ID returned by /v1/models'
                : 'Tutor model ID'
            }
            onChange={(event) =>
              setTutorModels((current) =>
                current.map((item, i) =>
                  i === index ? { ...item, model: event.target.value } : item,
                ),
              )
            }
          />
          {!routerManaged && MODEL_ENDPOINT_PROVIDERS.has(model.provider) && (
            <input
              style={S.customInput}
              value={model.baseUrl ?? ''}
              placeholder={
                model.provider !== 'lm_studio'
                  ? 'OpenAI-compatible base URL, ending in /v1'
                  : 'LM Studio host'
              }
              onChange={(event) =>
                setTutorModels((current) =>
                  current.map((item, i) =>
                    i === index
                      ? { ...item, baseUrl: event.target.value }
                      : item,
                  ),
                )
              }
            />
          )}
          {!routerManaged && model.provider !== 'lm_studio' && (
            <input
              style={S.customInput}
              type="password"
              value={modelCredentials[`tutor:${model.provider}`] ?? ''}
              placeholder={
                model.provider === 'hosted_vllm'
                  ? 'Endpoint API key (optional; blank keeps the saved key)'
                  : 'Replace tutor API key (leave blank to keep it)'
              }
              onChange={(event) =>
                setModelCredentials((current) => ({
                  ...current,
                  [`tutor:${model.provider}`]: event.target.value,
                }))
              }
            />
          )}
          <div
            style={{
              display: 'flex',
              justifyContent: 'space-between',
              fontSize: 'var(--coco-text-secondary)',
            }}
          >
            <label htmlFor={`workspace-default-model-${model.id}`}>
              <input
                id={`workspace-default-model-${model.id}`}
                type="radio"
                checked={defaultTutorModelId === model.id}
                onChange={() => setDefaultTutorModelId(model.id)}
              />{' '}
              Default
            </label>
            {tutorModels.length > 1 && (
              <button
                type="button"
                style={{
                  border: 'none',
                  background: 'none',
                  color: 'var(--coco-color-danger)',
                  cursor: 'pointer',
                }}
                onClick={() => {
                  const next = tutorModels.filter(
                    (item) => item.id !== model.id,
                  );
                  setTutorModels(next);
                  if (defaultTutorModelId === model.id)
                    setDefaultTutorModelId(next[0].id);
                }}
              >
                Remove
              </button>
            )}
          </div>
          <label style={S.toggleRow}>
            <input
              type="checkbox"
              checked={model.supportsAudio}
              onChange={(event) =>
                setTutorModels((current) =>
                  current.map((item) =>
                    item.id === model.id
                      ? { ...item, supportsAudio: event.target.checked }
                      : item,
                  ),
                )
              }
            />{' '}
            Supports audio input
          </label>
          <div style={S.connectionTestRow}>
            <button
              type="button"
              style={{
                ...S.connectionTestButton,
                ...(connectionTests[model.id]?.state === 'testing'
                  ? S.sendBtnDisabled
                  : {}),
              }}
              aria-label={`Test ${model.label || 'tutor model'} connection`}
              disabled={connectionTests[model.id]?.state === 'testing'}
              onClick={() => void testSettingsModelConnection('tutor', model)}
            >
              {connectionTests[model.id]?.state === 'testing'
                ? 'Testing…'
                : 'Test connection'}
            </button>
            {connectionTests[model.id]?.state === 'success' && (
              <span style={S.connectionTestSuccess}>
                {connectionTests[model.id].message}
              </span>
            )}
            {connectionTests[model.id]?.state === 'error' && (
              <details style={S.connectionTestError}>
                <summary>Connection failed — show details</summary>
                <pre style={S.connectionTestErrorText}>
                  {connectionTests[model.id].message}
                </pre>
              </details>
            )}
          </div>
        </div>
      ))}
      <button
        type="button"
        style={{ ...S.addBtn, marginBottom: 12 }}
        onClick={() => {
          const id = `tutor-${Date.now()}`;
          setTutorModels((current) => [
            ...current,
            {
              id,
              label: '',
              provider: routerManaged ? 'gemini' : 'anthropic',
              model: '',
              supportsAudio: false,
            },
          ]);
        }}
      >
        + Add tutor model
      </button>
      <div style={{ ...S.saveRow, marginBottom: 14 }}>
        <button
          type="button"
          style={S.saveBtn}
          disabled={modelConfigLoading}
          onClick={saveModelSettings}
        >
          Save model settings
        </button>
        {modelSavedFlash && <span style={S.saved}>✓ Saved</span>}
      </div>
      {modelSaveError && (
        <div
          style={{
            color: 'var(--coco-color-danger)',
            fontSize: 'var(--coco-text-secondary)',
            marginBottom: 12,
          }}
        >
          {modelSaveError}
        </div>
      )}
    </section>
  );
}
