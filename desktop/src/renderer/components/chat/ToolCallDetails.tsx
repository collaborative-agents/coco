import { useId, useState } from 'react';
import type { TutorToolCall } from '../observation-types';
import CodeWindow from './CodeWindow';

function CommandExplanation({
  tool,
  source,
}: {
  tool: string;
  source: string;
}) {
  const [visible, setVisible] = useState(false);
  const [explanation, setExplanation] = useState('');
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState('');
  const explanationId = useId();
  const explain = async () => {
    if (explanation) {
      setVisible(!visible);
      return;
    }
    setVisible(true);
    setLoading(true);
    setError('');
    try {
      const result = await window.electron?.ipcRenderer.invoke(
        'explain-tool-command',
        { tool, source },
      );
      if (!result?.explanation) throw new Error('Explanation unavailable');
      setExplanation(result.explanation);
    } catch {
      setError('Could not explain this command. Try again.');
    } finally {
      setLoading(false);
    }
  };
  let buttonLabel = visible && explanation ? 'Hide explanation' : 'Explain';
  if (loading) buttonLabel = 'Explaining…';
  return (
    <>
      <button
        type="button"
        onClick={explain}
        disabled={loading}
        aria-expanded={visible}
        aria-controls={explanationId}
      >
        {buttonLabel}
      </button>
      {visible && (
        <div
          id={explanationId}
          className="tool-command-explanation"
          role="status"
        >
          {loading ? 'Explaining this command…' : error || explanation}
        </div>
      )}
    </>
  );
}

function DetailValue({
  name,
  value,
  tool,
  input,
}: {
  name: string;
  value: unknown;
  tool: string;
  input: boolean;
}) {
  const [expanded, setExpanded] = useState(false);
  const source =
    typeof value === 'string'
      ? value
      : (JSON.stringify(value, null, 2) ?? String(value));
  const lines = source.split('\n');
  const preview = lines
    .slice(0, 4)
    .map((line) => (line.length > 160 ? `${line.slice(0, 160)}…` : line))
    .join('\n');
  const hiddenLines = Math.max(0, lines.length - 4);
  const truncated = hiddenLines > 0 || lines.some((line) => line.length > 160);
  const label = name
    .replace(/_/g, ' ')
    .replace(/^./, (char) => char.toUpperCase());
  let language = typeof value === 'string' ? 'text' : 'json';
  if (/^(command|cmd|script|code|source|content|new_text|newText)$/.test(name))
    language = 'auto';
  if (/^(command|cmd)$/.test(name) && tool === 'bash') language = 'bash';
  return (
    <section className="tool-detail-field">
      <div className="tool-detail-field-header">
        <span>{label}</span>
        {!truncated &&
          input &&
          /^(command|cmd|script|code|source)$/.test(name) && (
            <CommandExplanation key={source} tool={tool} source={source} />
          )}
      </div>
      <pre>{preview || '(empty)'}</pre>
      {truncated && (
        <button
          className="tool-detail-expand"
          type="button"
          onClick={() => setExpanded(true)}
          aria-label={`Show full ${label.toLowerCase()}`}
        >
          {hiddenLines > 0 ? `+ ${hiddenLines} lines` : 'Show full content'}
          <span aria-hidden="true"> ↗</span>
        </button>
      )}
      {expanded && (
        <CodeWindow
          title={`${tool} · ${label}`}
          source={source}
          language={language}
          onClose={() => setExpanded(false)}
        />
      )}
    </section>
  );
}

export default function ToolCallDetails({ call }: { call: TutorToolCall }) {
  const inputs = Object.entries(call.arguments ?? {});
  const outputs = Object.entries(call.result ?? {}).filter(
    ([name, value]) => name !== 'llm_metrics' && value !== undefined,
  );
  return (
    <div className="tool-activity-details">
      <div className="tool-activity-caption">{call.name} · Input</div>
      {inputs.length ? (
        inputs.map(([name, value]) => (
          <DetailValue
            key={name}
            name={name}
            value={value}
            tool={call.name}
            input
          />
        ))
      ) : (
        <p>No input required.</p>
      )}
      {outputs.length > 0 && (
        <div className="tool-activity-caption">Result</div>
      )}
      {outputs.map(([name, value]) => (
        <DetailValue
          key={name}
          name={name}
          value={value}
          tool={call.name}
          input={false}
        />
      ))}
    </div>
  );
}
