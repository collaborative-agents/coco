import { useCallback, useEffect, useRef, useState } from 'react';
import type { TokenUsageRecord } from '../../../shared/token-usage';
import TokenUsageHeatmap, {
  buildTokenCalendar,
  localDayKey,
} from './TokenUsageHeatmap';

export function summarizeTokenUsage(
  requests: TokenUsageRecord[],
  period: string,
  now = new Date(),
) {
  const start = new Date(now);
  start.setHours(0, 0, 0, 0);
  if (period === 'week') start.setDate(start.getDate() - 6);
  const rows = requests.filter(
    (request) => period === 'all' || Date.parse(request.at) >= start.getTime(),
  );
  const models = new Map<
    string,
    { model: string; input: number; output: number; unavailable: number }
  >();
  rows
    .flatMap((request) => (request.models?.length ? request.models : [request]))
    .forEach((request) => {
      const row = models.get(request.model) ?? {
        model: request.model,
        input: 0,
        output: 0,
        unavailable: 0,
      };
      row.input += request.input ?? 0;
      row.output += request.output ?? 0;
      if (request.input === null || request.output === null)
        row.unavailable += 1;
      models.set(request.model, row);
    });
  return [...models.values()];
}

export default function TokenUsageSettings() {
  const [data, setData] = useState<{
    requests: TokenUsageRecord[];
    trackingSince: string;
  } | null>(null);
  const [selectedDay, setSelectedDay] = useState<string | null>(null);
  const [error, setError] = useState('');
  const revision = useRef(0);
  const load = useCallback(async () => {
    revision.current += 1;
    const request = revision.current;
    try {
      const value = await window.electron.ipcRenderer.invoke('token-usage');
      if (request !== revision.current) return;
      if (!Array.isArray(value?.requests))
        throw new Error('Token usage is unavailable.');
      setData(value);
      setError('');
    } catch {
      if (request !== revision.current) return;
      setData(null);
      setError('Could not load token usage. Please retry.');
    }
  }, []);
  useEffect(() => {
    load();
    const unsubscribe = window.electron?.ipcRenderer.on?.(
      'token-usage-changed',
      load,
    );
    return () => {
      revision.current += 1;
      unsubscribe?.();
    };
  }, [load]);
  const calendar = buildTokenCalendar(data?.requests ?? []);
  const visibleDays = new Set(
    calendar.filter((day) => day.active).map((day) => day.key),
  );
  const visibleRequests = (data?.requests ?? []).filter((request) => {
    const day = localDayKey(new Date(request.at));
    return selectedDay ? day === selectedDay : visibleDays.has(day);
  });
  const rows = summarizeTokenUsage(visibleRequests, 'all');
  return (
    <section
      className="settings-token-usage"
      aria-labelledby="token-usage-heading"
    >
      <h3 id="token-usage-heading" className="settings-heading">
        Token usage
      </h3>
      {error && (
        <p role="alert">
          {error}{' '}
          <button type="button" onClick={load}>
            Retry
          </button>
        </p>
      )}
      {!data && !error && <p role="status">Loading token usage…</p>}
      {data && (
        <>
          <TokenUsageHeatmap
            requests={data.requests}
            selected={selectedDay}
            onSelect={setSelectedDay}
          />
          {rows.length ? (
            <table className="token-usage-table">
              <caption>
                Usage by model · {selectedDay ? 'Selected day' : 'Last year'}
              </caption>
              <thead>
                <tr>
                  <th scope="col">Model</th>
                  <th scope="col">Input</th>
                  <th scope="col">Output</th>
                  <th scope="col">Total</th>
                </tr>
              </thead>
              <tbody>
                {rows.map((row) => (
                  <tr key={row.model}>
                    <th scope="row">
                      {row.model}
                      {row.unavailable ? ' (partial)' : ''}
                    </th>
                    <td>{row.input.toLocaleString()}</td>
                    <td>{row.output.toLocaleString()}</td>
                    <td>{(row.input + row.output).toLocaleString()}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          ) : (
            <p>No requests recorded in this period.</p>
          )}
        </>
      )}
    </section>
  );
}
