import { useEffect, useState } from 'react';
import type { ModelDraft, ConnectionTestStatus } from './ModelsStep';

export default function useModelSetup() {
  const [modelError, setModelError] = useState('');
  const [savingModels, setSavingModels] = useState(false);
  const [sensingEnabled, setSensingEnabled] = useState(false);
  const [sensingModel, setSensingModel] = useState<ModelDraft>({
    id: 'sensing',
    label: 'Screen understanding',
    provider: 'pi',
    model: '',
    apiKey: '',
    baseUrl: '',
  });
  const [tutorModels, setTutorModels] = useState<ModelDraft[]>([]);
  const [defaultTutorId, setDefaultTutorId] = useState('');
  const [instantSuggestionModelId, setInstantSuggestionModelId] = useState('');
  const [modelsLoaded, setModelsLoaded] = useState(false);
  const [savedDraft, setSavedDraft] = useState<string | null>(null);
  const draft = JSON.stringify({
    sensingEnabled,
    sensingModel,
    tutorModels,
    defaultTutorId,
    instantSuggestionModelId,
  });
  useEffect(() => {
    if (modelsLoaded && savedDraft === null) setSavedDraft(draft);
  }, [modelsLoaded, savedDraft, draft]);
  const [connectionTests, setConnectionTests] = useState<
    Record<string, ConnectionTestStatus>
  >({});

  const testModelConnection = async (
    role: 'sensing' | 'tutor',
    model: ModelDraft,
  ) => {
    const key = role === 'sensing' ? 'sensing' : model.id;
    if (!model.model.trim()) {
      setConnectionTests((current) => ({
        ...current,
        [key]: { state: 'error', message: 'Enter a model ID first.' },
      }));
      return;
    }
    setConnectionTests((current) => ({
      ...current,
      [key]: { state: 'testing', message: '' },
    }));
    const result = await window.electron?.ipcRenderer.invoke(
      'test-model-connection',
      {
        role,
        connection: {
          id: model.id,
          label: model.label || (role === 'sensing' ? 'Screen understanding' : 'Chat'),
          provider: model.provider,
          model: model.model,
          baseUrl: model.baseUrl,
        },
        apiKey: model.apiKey,
      },
    );
    const response = result as
      | {
          success?: boolean;
          message?: string;
          error?: string;
        }
      | undefined;
    setConnectionTests((current) => ({
      ...current,
      [key]: response?.success
        ? { state: 'success', message: response.message || 'Connected.' }
        : { state: 'error', message: response?.error || 'Connection failed.' },
    }));
  };

  useEffect(() => {
    window.electron?.ipcRenderer
      .invoke('get-model-configuration')
      .then(async (config: any) => {
        if (!config || !Array.isArray(config.tutors)) {
          const status = await window.electron?.ipcRenderer.invoke(
            'pi-provider',
            'status',
          );
          if (status?.connection?.mode === 'native') {
            const { provider, model } = status.connection;
            setTutorModels([
              {
                id: 'legacy-pi-chat',
                label: model,
                provider: 'pi',
                model: `pi/${provider}/${model}`,
                apiKey: '',
                baseUrl: '',
              },
            ]);
            setDefaultTutorId('legacy-pi-chat');
          }
          return undefined;
        }
        setSensingEnabled(Boolean(config.sensing));
        if (config.sensing)
          setSensingModel({
            ...config.sensing,
            model: String(config.sensing.model).replace(
              /^(?:hosted_vllm|tinker)\//,
              '',
            ),
            apiKey: '',
            baseUrl: config.sensing.baseUrl ?? '',
          });
        setTutorModels(
          config.tutors.map((item: any) => ({
            ...item,
            model: String(item.model).replace(/^(?:hosted_vllm|tinker)\//, ''),
            apiKey: '',
            baseUrl: item.baseUrl ?? '',
          })),
        );
        setDefaultTutorId(config.defaultTutorId);
        setInstantSuggestionModelId(config.instantSuggestionModelId || '');
        return undefined;
      })
      .catch(() => {})
      .finally(() => setModelsLoaded(true));
  }, []);

  const saveModels = async () => {
    try {
      if (sensingEnabled && !sensingModel.model.trim()) {
        setModelError('Enter a vision-capable screen understanding model.');
        return false;
      }
      if (!tutorModels.length) {
        setModelError(
          'Add a model for chat.',
        );
        return false;
      }
      if (
        tutorModels.some((item) => !item.label.trim() || !item.model.trim())
      ) {
        setModelError('Give every chat model a name and model ID.');
        return false;
      }
      setSavingModels(true);
      setModelError('');
      const credentials: Record<string, string> = {};
      if (sensingEnabled && sensingModel.apiKey.trim()) {
        credentials[`sensing:${sensingModel.provider}`] = sensingModel.apiKey;
      }
      tutorModels.forEach((item) => {
        if (item.apiKey.trim())
          credentials[
            item.provider === 'hosted_vllm'
              ? `tutor:${item.provider}:${item.id}`
              : `tutor:${item.provider}`
          ] = item.apiKey;
      });
      const result = await window.electron?.ipcRenderer.invoke(
        'save-model-configuration',
        {
          sensing: sensingEnabled
            ? {
                id: 'sensing',
                label: 'Screen understanding',
                provider: sensingModel.provider,
                model: sensingModel.model,
                baseUrl: sensingModel.baseUrl,
              }
            : null,
          tutors: tutorModels.map((item) => ({
            id: item.id,
            label: item.label,
            provider: item.provider,
            model: item.model,
            baseUrl: item.baseUrl,
          })),
          defaultTutorId,
          instantSuggestionModelId: instantSuggestionModelId || undefined,
          credentials,
        },
      );
      setSavingModels(false);
      if (!(result as { success?: boolean })?.success) {
        setModelError(
          (result as { error?: string })?.error ||
            'Could not save model configuration.',
        );
        return false;
      }

      // Capture the submitted draft so edits made during saving stay unsaved.
      setSavedDraft(draft);
      return true;
    } catch {
      setModelError('Could not save model configuration. Please try again.');
      return false;
    } finally {
      setSavingModels(false);
    }
  };
  return {
    savingModels,
    hasUnsavedChanges: savedDraft !== null && draft !== savedDraft,
    saveModels,
    modelProps: {
      sensingEnabled,
      setSensingEnabled,
      sensing: sensingModel,
      setSensing: setSensingModel,
      tutors: tutorModels,
      setTutors: setTutorModels,
      defaultTutorId,
      setDefaultTutorId,
      instantSuggestionModelId,
      setInstantSuggestionModelId,
      error: modelError,
      testStatuses: connectionTests,
      onTest: testModelConnection,
    },
  };
}
