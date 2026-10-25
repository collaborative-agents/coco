import './Settings.css';
import { useEffect, useState } from 'react';

const invoke = (action: string, payload?: unknown) =>
  window.electron.ipcRenderer.invoke('pi-provider', action, payload);

export default function PiProviderSettings({
  onStatus,
}: {
  onStatus?: (status: any) => void;
}) {
  const [status, setStatus] = useState<any>(null);
  const [provider, setProvider] = useState('');
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
          onStatus?.(next);
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
  }, [onStatus]);
  useEffect(() => {
    setAnswer('');
  }, [status?.flow?.prompt?.id]);
  const act = async (action: string, payload?: unknown) => {
    setError('');
    setPending(true);
    try {
      await invoke(action, payload);
      const next = await invoke('status');
      setStatus(next);
      onStatus?.(next);
    } catch (err) {
      setError(String(err));
    } finally {
      setPending(false);
    }
  };
  if (!status) return <p role="status">{error || 'Loading Pi providers…'}</p>;
  const selected = status.providers.find((p: any) => p.id === provider);
  const prompt = status.flow?.prompt;
  const busy = pending || status.flow?.busy;
  return (
    <section className="ob-model-card pi-provider-settings">
      <h3>Connected providers</h3>
      <p>
        Sign in once through Pi, then choose its models for chat, sensing, or
        instant suggestions below. Credentials stay with Pi.
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
      {error && <p role="alert">{error}</p>}
    </section>
  );
}
