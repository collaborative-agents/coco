import { useEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import type {
  AgentContextSnapshot,
  ContextCategory,
} from '../../../shared/agent-context';
import { S } from './styles';
import './ContextViewer.css';
import ActionTooltip from './ActionTooltip';

const colors = [
  '#668bd1',
  '#8d78bf',
  '#53a59b',
  '#c49b52',
  '#c47c8b',
  '#7893a6',
];
const number = (value: number) => Math.round(value).toLocaleString();

function Category({ category }: { category: ContextCategory }) {
  return (
    <details className="context-category">
      <summary>
        {category.label}
        <span>≈ {number(category.tokens)} tokens</span>
      </summary>
      {category.children?.map((child) => (
        <Category key={child.id} category={child} />
      ))}
      {category.entries?.map((entry, index) => (
        // Entries have no stable IDs; their order belongs to this snapshot.
        // eslint-disable-next-line react/no-array-index-key
        <div className="context-entry" key={index}>
          <div>
            {entry.breadcrumb.join(' › ')} · ≈ {number(entry.tokens)} tokens
          </div>
          <pre>{entry.text}</pre>
        </div>
      ))}
    </details>
  );
}

function ContextDialog({
  sessionId,
  onClose,
}: {
  sessionId: string | null;
  onClose: () => void;
}) {
  const dialog = useRef<HTMLDialogElement>(null);
  const [snapshot, setSnapshot] = useState<AgentContextSnapshot | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  useEffect(() => {
    dialog.current?.showModal();
  }, []);
  useEffect(() => {
    let disposed = false;
    setLoading(true);
    setError('');
    async function readContext() {
      try {
        const value = await window.electron?.ipcRenderer.invoke(
          'get-agent-context',
          sessionId,
        );
        if (!disposed) setSnapshot(value ?? null);
      } catch (reason) {
        if (!disposed)
          setError(reason instanceof Error ? reason.message : String(reason));
      } finally {
        if (!disposed) setLoading(false);
      }
    }
    readContext();
    return () => {
      disposed = true;
    };
  }, [sessionId]);
  const total = snapshot?.estimatedTokens ?? 0;
  const capacity = snapshot?.reported?.contextWindow;
  const scale = Math.max(total, capacity ?? 0, 1);
  return createPortal(
    <dialog
      ref={dialog}
      className="context-dialog"
      aria-labelledby="context-view-title"
      onCancel={onClose}
      onClose={onClose}
    >
      <header>
        <h2 id="context-view-title">What Coco Has as Context</h2>
        <button type="button" onClick={onClose} aria-label="Close context">
          ×
        </button>
      </header>
      <div className="context-body" aria-busy={loading}>
        {error && <p role="alert">Could not load context: {error}</p>}
        {!error && loading && <p role="status">Reading context…</p>}
        {!error && !loading && snapshot && (
          <>
            <div className="context-total">
              <strong>≈ {number(total)} tokens</strong>
              {capacity ? ` / ${number(capacity)} configured capacity` : ''}
            </div>
            <div
              className="context-usage-bar"
              aria-label="Estimated context composition"
            >
              {snapshot.categories.map((category, index) => (
                <span
                  key={category.id}
                  title={`${category.label}: ≈ ${number(category.tokens)} tokens`}
                  style={{
                    width: `${(category.tokens / scale) * 100}%`,
                    background: colors[index % colors.length],
                  }}
                />
              ))}
            </div>
            <div className="context-legend">
              {snapshot.categories.map((category, index) => (
                <span key={category.id}>
                  <i style={{ background: colors[index % colors.length] }} />
                  {category.label}
                </span>
              ))}
            </div>
            {snapshot.categories.map((category) => (
              <Category key={category.id} category={category} />
            ))}
          </>
        )}
        {!error && !loading && !snapshot && (
          <p>Send a message in this session to view its context.</p>
        )}
      </div>
    </dialog>,
    document.body,
  );
}

export default function ContextViewer({
  sessionId,
}: {
  sessionId: string | null;
}) {
  const [open, setOpen] = useState(false);
  const button = useRef<HTMLButtonElement>(null);
  return (
    <>
      <ActionTooltip label="View conversation context">
        <button
          ref={button}
          type="button"
          className="chat-composer-context"
          aria-label="Context"
          style={{
            ...S.finishTaskBtn,
            background: 'var(--coco-color-surface-subtle)',
            color: 'var(--coco-color-text-secondary)',
          }}
          onClick={() => setOpen(true)}
          aria-haspopup="dialog"
        >
          <svg
            className="chat-composer-context-icon"
            aria-hidden="true"
            width="18"
            height="18"
            viewBox="0 0 24 24"
            fill="none"
            stroke="currentColor"
            strokeWidth="1.8"
            strokeLinecap="round"
            strokeLinejoin="round"
          >
            <path d="m12 3 9 5-9 5-9-5 9-5Z M3 12l9 5 9-5 M3 16l9 5 9-5" />
          </svg>
          <span className="chat-composer-action-label">Context</span>
        </button>
      </ActionTooltip>
      {open && (
        <ContextDialog
          key={sessionId}
          sessionId={sessionId}
          onClose={() => {
            setOpen(false);
            button.current?.focus();
          }}
        />
      )}
    </>
  );
}
