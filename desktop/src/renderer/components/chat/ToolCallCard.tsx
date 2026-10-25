import React from 'react';
import type { TutorToolCall } from '../observation-types';
import toolSummary from './tool-summary';
import './ToolActivity.css';
import QuestionCard from './QuestionCard';
import { S } from './styles';

export function ToolCallCard({
  call,
  interactive = false,
  grouped = false,
}: {
  call: TutorToolCall;
  interactive?: boolean;
  grouped?: boolean;
}) {
  if (call.name === 'ask_user_question')
    return <QuestionCard call={call} interactive={interactive} />;
  const rawDetails = (
    <div className="tool-activity-details">
      <div className="tool-activity-caption">Full tool call · JSON</div>
      <pre className="agent-tool-output">{JSON.stringify(call, null, 2)}</pre>
    </div>
  );
  const status = (
    <span className={`tool-activity-status ${call.status}`}>
      {call.status === 'running'
        ? 'Working…'
        : call.status === 'error'
          ? 'Failed'
          : 'Done'}
    </span>
  );
  if (grouped) {
    return (
      <details className="tool-activity-call">
        <summary>
          <span className="tool-activity-description">{call.name}</span>
          {status}
          <span className="tool-activity-detail-label">Details</span>
        </summary>
        {rawDetails}
      </details>
    );
  }
  if (
    !['observe_screen', 'get_user_context', 'get_recent_observations'].includes(
      call.name,
    )
  ) {
    return (
      <details className="tool-activity-call">
        <summary>
          <span className="tool-activity-description">{toolSummary(call)}</span>
          {status}
          <span className="tool-activity-detail-label">Details</span>
        </summary>
        {rawDetails}
      </details>
    );
  }
  if (call.name === 'observe_screen') {
    const observation = call.result?.observation?.trim();
    return (
      <div style={S.toolCard}>
        <div style={S.toolHeader}>
          <span style={S.toolIcon}>▣</span>
          <span>Current screen</span>
          <span
            style={{
              ...S.toolStatus,
              ...(call.status === 'error' ? S.toolStatusError : {}),
            }}
          >
            {call.status === 'running'
              ? 'Observing…'
              : call.status === 'error'
                ? 'Unavailable'
                : 'Observed'}
          </span>
        </div>
        {call.arguments?.focus && (
          <div style={S.toolArgs}>{call.arguments.focus}</div>
        )}
        {call.result?.error && (
          <div style={{ ...S.toolArgs, ...S.toolStatusError }}>
            {call.result.error}
          </div>
        )}
        {observation && (
          <details style={S.toolDetails}>
            <summary>View screen observation</summary>
            <div style={S.toolObservation}>{observation}</div>
          </details>
        )}
      </div>
    );
  }

  const query = call.arguments?.query?.trim();
  const start = call.arguments?.start_hh_mm_ago;
  const end = call.arguments?.end_hh_mm_ago;
  const results = call.result?.results ?? [];
  const count = call.result?.count ?? results.length;
  const windowLabel =
    start || end ? `${start ?? 'any'} → ${end ?? 'now'} ago` : 'most recent';

  return (
    <div style={S.toolCard}>
      <div style={S.toolHeader}>
        <span style={S.toolIcon}>⌕</span>
        <span>{call.name}</span>
        <span
          style={{
            ...S.toolStatus,
            ...(call.status === 'error' ? S.toolStatusError : {}),
          }}
        >
          {call.status === 'running'
            ? 'Searching…'
            : call.status === 'error'
              ? 'Failed'
              : `${count} found`}
        </span>
      </div>
      <div style={S.toolArgs}>
        {query ? `“${query}”` : 'Recent memory'} · {windowLabel} · limit{' '}
        {call.arguments?.limit ?? 3} · evidence{' '}
        {call.arguments?.evidence_limit ?? 1}
      </div>
      {call.result?.error && <div style={S.toolArgs}>{call.result.error}</div>}
      {results.length > 0 && (
        <details style={S.toolDetails}>
          <summary>View retrieved memory</summary>
          {results.map((result, index) => (
            <div
              key={result.id ?? `${call.id}-${index}`}
              style={S.toolObservation}
            >
              {result.updated_at && (
                <div
                  style={{
                    color: 'var(--coco-color-text-subtle)',
                    fontSize: 'var(--coco-text-caption)',
                  }}
                >
                  {new Date(result.updated_at).toLocaleString()}
                </div>
              )}
              <div>{result.text}</div>
              {result.evidence?.map((observation, evidenceIndex) => (
                <div
                  key={observation.id ?? `${call.id}-${index}-${evidenceIndex}`}
                  style={{
                    color: 'var(--coco-color-text-muted)',
                    marginTop: 4,
                  }}
                >
                  Evidence: {observation.content}
                </div>
              ))}
            </div>
          ))}
        </details>
      )}
    </div>
  );
}

ToolCallCard.defaultProps = { interactive: false, grouped: false };
