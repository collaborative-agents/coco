import './Settings.css';
import { useEffect, useState } from 'react';

const invoke = (action: string, payload?: unknown) =>
  window.electron.ipcRenderer.invoke('pi-provider', action, payload);

export default function PiProviderSettings() {
  const [status, setStatus] = useState<any>(null);
  const [provider, setProvider] = useState('');
  const [model, setModel] = useState('');
  const [answer, setAnswer] = useState('');
  const [error, setError] = useState('');
  const [pending, setPending] = useState(false);
  useEffect(() => {
    let mounted = true;
    let timer: ReturnType<typeof setTimeout>;
    const refresh = async () => {
      try {
        const next = await invoke('status');
        if (!next?.connection || !Array.isArray(next.providers))
          throw new Error('Provider status unavailable.');
        if (mounted) {
          setStatus(next);
          setProvider(
            (current) =>
              current ||
              next.connection.provider ||
              next.providers.find((p: any) => p.oauth)?.id ||
              '',
          );
          setModel((current) => current || next.connection.model || '');
        }
      } catch {
        if (mounted) setError('Could not load Pi providers.');
      }
      if (mounted) timer = setTimeout(refresh, 1000);
    };
    void refresh();
    return () => {
      mounted = false;
      clearTimeout(timer);
      void invoke('cancel').catch(() => {});
    };
  }, []);
  useEffect(() => {
    setAnswer('');
  }, [status?.flow?.prompt?.id]);
  const act = async (action: string, payload?: unknown) => {
    setError('');
    setPending(true);
    try {
      await invoke(action, payload);
      setStatus(await invoke('status'));
    } catch (err) {
      setError(String(err));
    } finally {
      setPending(false);
    }
  };
  if (!status) return <p role="status">{error || 'Loading Pi providers…'}</p>;
  const selected = status.providers.find((p: any) => p.id === provider);
  const models = status.models.filter((m: any) => m.provider === provider);
  const prompt = status.flow?.prompt;
  const busy = pending || status.flow?.busy;
  return (
    <section className="ob-model-card pi-provider-settings">
      <h3>Agent connection</h3>
      <p>
        Active:{' '}
        {status.connection.mode === 'native'
          ? `Pi · ${status.connection.provider} / ${status.connection.model}`
          : 'Coco local model bridge'}
      </p>
      <p>
        Pi connects directly to your provider using its native login. Native
        chat works without Python services. Screen sensing, proactive
        suggestions, and voice transcription need the Coco model configuration
        below. Pi’s file and command tools work independently; Coco’s screen and
        memory tools are available when its local service is running.
      </p>
      <label className="coco-field">
        Pi provider
        <span className="coco-select-wrap">
          <select
            className="coco-select"
            value={provider}
            disabled={busy}
            onChange={(e) => {
              setProvider(e.target.value);
              setModel('');
            }}
          >
            {status.providers.map((p: any) => (
              <option key={p.id} value={p.id}>
                {p.name}
                {p.connected ? ' — connected' : ''}
              </option>
            ))}
          </select>
        </span>
      </label>
      <div className="coco-actions">
        {selected?.oauth && (
          <button
            className="coco-button"
            type="button"
            disabled={busy}
            onClick={() => act('login', { provider, type: 'oauth' })}
          >
            {selected.oauth}
          </button>
        )}
        {selected?.apiKey && (
          <button
            className="coco-button"
            type="button"
            disabled={busy}
            onClick={() => act('login', { provider, type: 'api_key' })}
          >
            Enter API key
          </button>
        )}
        {selected?.connected && (
          <button
            className="coco-button"
            type="button"
            disabled={busy}
            onClick={() => act('logout', { provider })}
          >
            Sign out
          </button>
        )}
      </div>
      {status.flow && <p role="status">{status.flow.message}</p>}
      {prompt && (
        <div>
          <label className="coco-field">
            {prompt.message}
            {prompt.type === 'select' ? (
              <span className="coco-select-wrap">
                <select
                  className="coco-select"
                  value={answer}
                  onChange={(e) => setAnswer(e.target.value)}
                >
                  <option value="">Choose…</option>
                  {prompt.options.map((o: any) => (
                    <option key={o.id} value={o.id}>
                      {o.label}
                    </option>
                  ))}
                </select>
              </span>
            ) : (
              <input
                className="ob-custom-input"
                type={
                  prompt.type === 'secret' || prompt.type === 'manual_code'
                    ? 'password'
                    : 'text'
                }
                autoComplete="off"
                value={answer}
                placeholder={prompt.placeholder}
                onChange={(e) => setAnswer(e.target.value)}
              />
            )}
          </label>
          <button
            className="coco-button"
            type="button"
            disabled={pending || !answer}
            onClick={() => {
              void act('answer', { id: prompt.id, value: answer });
              setAnswer('');
            }}
          >
            Continue login
          </button>
        </div>
      )}
      {status.flow?.busy && (
        <button
          className="coco-button"
          type="button"
          onClick={() => act('cancel')}
        >
          Cancel login
        </button>
      )}
      <button
        className="coco-button"
        type="button"
        disabled={busy}
        onClick={() => act('refresh', { provider })}
      >
        Refresh models
      </button>
      <label className="coco-field">
        Pi model
        <span className="coco-select-wrap">
          <select
            className="coco-select"
            value={model}
            disabled={busy}
            onChange={(e) => setModel(e.target.value)}
          >
            <option value="">Choose a model…</option>
            {models.map((m: any) => (
              <option key={m.id} value={m.id}>
                {m.name}
              </option>
            ))}
          </select>
        </span>
      </label>
      <button
        className="coco-button coco-button--primary"
        type="button"
        disabled={busy || !model}
        onClick={() => act('save', { mode: 'native', provider, model })}
      >
        Use native Pi
      </button>{' '}
      <button
        className="coco-button"
        type="button"
        disabled={busy}
        onClick={() => act('save', { mode: 'coco' })}
      >
        Use Coco bridge
      </button>
      {error && <p role="alert">{error}</p>}
    </section>
  );
}
