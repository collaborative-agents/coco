import { useEffect, useRef, useState } from 'react';
import ReactMarkdown from 'react-markdown';
import { createPortal } from 'react-dom';
import WorkspaceDialog from './chat/WorkspaceDialog';
import './chat/WorkspaceDialog.css';
import ActionTooltip from './chat/ActionTooltip';
import './PersonalizationKnowledge.css';
import { preferenceOutline } from './preference-outline';
import ContextGraph, { type ContextGroup } from './ContextGraph';

export interface ActivePersonalizationMemory {
  content: string;
  updatedAt?: number;
  error?: string;
}
interface ContextItem {
  id: number;
  text: string;
  reasoning: string;
  updatedAt: number;
  evidenceCount: number;
  evidence: Array<{ id: string; content: string; createdAt: number }>;
}
interface ContextPage {
  success: boolean;
  error?: string;
  items: ContextItem[];
  total: number;
  matchedTotal: number;
  groups: ContextGroup[];
  leaf: boolean;
  breadcrumbs: Array<{ label: string; count: number }>;
  grouping: string;
}
function dateLabel(value?: number) {
  return value
    ? new Date(value * 1000).toLocaleString(undefined, {
        month: 'short',
        day: 'numeric',
        year: 'numeric',
        hour: 'numeric',
        minute: '2-digit',
      })
    : '';
}
function EmptyState({
  title,
  children,
}: {
  title: string;
  children: React.ReactNode;
}) {
  return (
    <div className="knowledge-empty">
      <span aria-hidden>✧</span>
      <h3>{title}</h3>
      <p>{children}</p>
    </div>
  );
}

function MemoryActions({
  text,
  label,
  onSave,
  renderStatement,
}: {
  text: string;
  label: string;
  onSave: (value: string | null) => Promise<void>;
  renderStatement: (actions: React.ReactNode) => React.ReactNode;
}) {
  const [mode, setMode] = useState<'view' | 'edit' | 'delete'>('view');
  const [draft, setDraft] = useState(text);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const editor = useRef<HTMLSpanElement>(null);
  useEffect(() => {
    if (mode === 'edit' && editor.current) {
      editor.current.textContent = draft;
      editor.current.focus();
    }
    // Initialize once; background refreshes must not replace the user's draft.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [mode]);
  // Freeze the original version and save callback while the editor is open.
  const save = useRef(onSave);
  const begin = (next: 'edit' | 'delete') => {
    save.current = onSave;
    setDraft(text);
    setError('');
    setMode(next);
  };
  const submit = async (value: string | null) => {
    setBusy(true);
    setError('');
    try {
      await save.current(value);
      setMode('view');
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setBusy(false);
    }
  };
  const actions = (
    <span className="memory-inline-actions">
      <button
        type="button"
        className="memory-inline-action"
        aria-label="Edit"
        title={`Edit ${label}`}
        onClick={() => begin('edit')}
      >
        <svg
          width="14"
          height="14"
          viewBox="0 0 24 24"
          fill="none"
          stroke="currentColor"
          strokeWidth="1.7"
          strokeLinecap="round"
          strokeLinejoin="round"
          aria-hidden="true"
        >
          <path d="m16 3 5 5M4 15 16 3a2.1 2.1 0 0 1 5 5L9 20l-6 1z" />
        </svg>
      </button>
      <button
        type="button"
        className="memory-inline-action"
        aria-label="Delete"
        title={`Delete ${label}`}
        onClick={() => begin('delete')}
      >
        <svg
          width="14"
          height="14"
          viewBox="0 0 24 24"
          fill="none"
          stroke="currentColor"
          strokeWidth="1.7"
          strokeLinecap="round"
          strokeLinejoin="round"
          aria-hidden="true"
        >
          <path d="M3 6h18M9 6V3h6v3M5 6l1 15h12l1-15M10 10v7M14 10v7" />
        </svg>
      </button>
    </span>
  );
  return (
    <div className="memory-actions">
      {mode !== 'edit' && renderStatement(actions)}
      {mode === 'edit' && (
        <p className="memory-inline-editor">
          <span
            ref={editor}
            role="textbox"
            aria-label={`Edit ${label}`}
            aria-multiline="true"
            aria-disabled={busy}
            contentEditable={busy ? false : 'plaintext-only'}
            suppressContentEditableWarning
            className="memory-editable-statement"
            onInput={(e) =>
              setDraft(
                e.currentTarget.innerText ?? e.currentTarget.textContent ?? '',
              )
            }
            onKeyDown={(e) => {
              if (busy || e.nativeEvent.isComposing) return;
              if (e.key === 'Escape') {
                e.preventDefault();
                setMode('view');
                setError('');
              }
              if (
                e.key === 'Enter' &&
                (e.metaKey || e.ctrlKey) &&
                draft.trim()
              ) {
                e.preventDefault();
                void submit(draft.trim());
              }
            }}
          />
          <span className="memory-inline-actions">
            <button
              type="button"
              className="memory-inline-action"
              aria-label="Save"
              title="Save"
              disabled={busy || !draft.trim()}
              onClick={() => void submit(draft.trim())}
            >
              <svg
                width="14"
                height="14"
                viewBox="0 0 24 24"
                fill="none"
                stroke="currentColor"
                strokeWidth="1.7"
                strokeLinecap="round"
                strokeLinejoin="round"
                aria-hidden="true"
              >
                <path d="m5 12 4 4L19 6" />
              </svg>
            </button>
            <button
              type="button"
              className="memory-inline-action"
              aria-label="Cancel"
              title="Cancel"
              disabled={busy}
              onClick={() => {
                setMode('view');
                setError('');
              }}
            >
              <svg
                width="14"
                height="14"
                viewBox="0 0 24 24"
                fill="none"
                stroke="currentColor"
                strokeWidth="1.7"
                strokeLinecap="round"
                aria-hidden="true"
              >
                <path d="m6 6 12 12M18 6 6 18" />
              </svg>
            </button>
          </span>
          {busy && (
            <span role="status" className="memory-saving">
              Saving…
            </span>
          )}
        </p>
      )}
      {error && mode !== 'delete' && (
        <p role="alert" className="personalization-error">
          {error}
        </p>
      )}
      {mode === 'delete' &&
        createPortal(
          <WorkspaceDialog
            open
            title={`Delete this ${label}?`}
            className="memory-delete-dialog"
            busy={busy}
            onClose={() => {
              if (!busy) {
                setMode('view');
                setError('');
              }
            }}
          >
            <p className="memory-delete-description">
              This will remove it from Coco’s memory. This can’t be undone.
            </p>
            <p className="memory-delete-preview">
              {draft.length > 180 ? `${draft.slice(0, 177).trimEnd()}…` : draft}
            </p>
            {error && (
              <p role="alert" className="personalization-error">
                {error}
              </p>
            )}
            <div className="memory-delete-buttons">
              <button
                type="button"
                disabled={busy}
                onClick={() => {
                  setMode('view');
                  setError('');
                }}
              >
                Cancel
              </button>
              <button
                type="button"
                className="memory-delete-confirm"
                aria-label="Delete permanently"
                disabled={busy}
                onClick={() => void submit(null)}
              >
                {busy ? 'Deleting…' : 'Delete'}
              </button>
            </div>
          </WorkspaceDialog>,
          document.body,
        )}
    </div>
  );
}

export function LearnedPreferences({
  memory,
  pendingCount,
  onReview,
  onChanged,
}: {
  memory?: ActivePersonalizationMemory;
  pendingCount: number;
  onReview: () => void;
  onChanged?: () => Promise<void>;
}) {
  const [query, setQuery] = useState('');
  const [category, setCategory] = useState('All');
  const [notice, setNotice] = useState('');
  const sections = preferenceOutline(memory?.content ?? '');
  const visible = sections
    .map((section) => ({
      ...section,
      items: section.items.filter((item) =>
        item.markdown
          .toLocaleLowerCase()
          .includes(query.trim().toLocaleLowerCase()),
      ),
    }))
    .filter(
      (section) =>
        section.items.length &&
        (category === 'All' || section.title === category),
    );
  return (
    <div className="knowledge-page">
      {notice && <p role="status">{notice}</p>}
      {pendingCount > 0 && (
        <button className="knowledge-review-banner" onClick={onReview}>
          <span>
            <strong>
              {pendingCount} new{' '}
              {pendingCount === 1 ? 'preference' : 'preferences'} to review
            </strong>
            <small>Decide what becomes part of Coco’s understanding.</small>
          </span>
          <span>
            Review update <span aria-hidden>→</span>
          </span>
        </button>
      )}
      {memory?.error ? (
        <p role="alert" className="personalization-error">
          {memory.error}
        </p>
      ) : !memory ? (
        <p role="status">Loading learned preferences…</p>
      ) : !memory.content.trim() ? (
        <EmptyState title="A little more you, over time">
          Approved preferences will appear here. You can explore what Coco is
          learning and review its next update in Learning &amp; review.
        </EmptyState>
      ) : (
        <>
          <div className="knowledge-toolbar">
            <label className="knowledge-search">
              <input
                aria-label="Search learned preferences"
                placeholder="Search preferences"
                value={query}
                onChange={(e) => setQuery(e.target.value)}
                type="search"
              />
            </label>
            <span className="knowledge-meta">
              <span className="knowledge-active-dot" /> In use
              <ActionTooltip label="Only approved preferences appear here. Your own memory notes stay in Settings → Memory.">
                <button
                  type="button"
                  className="knowledge-info"
                  aria-label="About learned preferences"
                >
                  <svg
                    width="16"
                    height="16"
                    viewBox="0 0 24 24"
                    fill="none"
                    stroke="currentColor"
                    strokeWidth="1.7"
                    strokeLinecap="round"
                    aria-hidden="true"
                  >
                    <circle cx="12" cy="12" r="9" />
                    <path d="M12 11v6M12 7h.01" />
                  </svg>
                </button>
              </ActionTooltip>
              {memory.updatedAt && (
                <small>Updated {dateLabel(memory.updatedAt)}</small>
              )}
            </span>
          </div>
          <nav
            className="preference-categories"
            aria-label="Preference categories"
          >
            {Array.from(
              new Set([
                'All',
                ...sections.map((section) => section.title),
                category,
              ]),
            ).map((title) => (
              <button
                key={title}
                type="button"
                aria-pressed={category === title}
                onClick={() => setCategory(title)}
              >
                {title}
                <span>
                  {title === 'All'
                    ? sections.reduce(
                        (sum, section) => sum + section.items.length,
                        0,
                      )
                    : (sections.find((section) => section.title === title)
                        ?.items.length ?? 0)}
                </span>
              </button>
            ))}
          </nav>
          <div className="preference-sections">
            {visible.map((section) => (
              <section key={section.title} className="preference-section">
                <h3>
                  {section.title} <span>{section.items.length}</span>
                </h3>
                <div className="preference-grid">
                  {section.items.map((item) => (
                    <details className="preference-item" key={item.id}>
                      <summary>
                        <span className="preference-preview">
                          {item.preview}
                        </span>
                        <span className="preference-disclosure">
                          Full preference
                          {item.examples > 0
                            ? ` · ${item.examples} examples`
                            : ''}
                          <span aria-hidden>⌄</span>
                        </span>
                      </summary>
                      <div className="preference-detail">
                        <MemoryActions
                          text={item.markdown}
                          label="preference"
                          renderStatement={(actions) => (
                            <ReactMarkdown
                              components={{
                                p: ({ node, children }) => (
                                  <p>
                                    {children}
                                    {node?.position?.start.line === 1
                                      ? actions
                                      : null}
                                  </p>
                                ),
                              }}
                              allowedElements={[
                                'h1',
                                'h2',
                                'h3',
                                'p',
                                'ul',
                                'ol',
                                'li',
                                'strong',
                                'em',
                                'code',
                                'blockquote',
                              ]}
                              unwrapDisallowed
                            >
                              {item.markdown}
                            </ReactMarkdown>
                          )}
                          onSave={async (value) => {
                            const original = memory.content;
                            const replacement =
                              value === null ? '' : `- ${value}\n\n`;
                            let content =
                              original.slice(0, item.start) +
                              replacement +
                              original.slice(item.end);
                            if (!preferenceOutline(content).length)
                              content = '';
                            const result =
                              (await window.electron.ipcRenderer.invoke(
                                'save-active-preferences',
                                { expected: original, content },
                              )) as {
                                success: boolean;
                                error?: string;
                                warning?: string;
                              };
                            if (!result?.success)
                              throw new Error(
                                result?.error ||
                                  'Preference could not be saved.',
                              );
                            setNotice(result.warning || '');
                            await onChanged?.();
                          }}
                        />
                      </div>
                    </details>
                  ))}
                </div>
              </section>
            ))}
          </div>
          {!visible.length && (
            <EmptyState title="No matching preferences">
              Try a different word or clear your search.
            </EmptyState>
          )}
        </>
      )}
    </div>
  );
}

export function ObserverContext() {
  const [query, setQuery] = useState('');
  const [trail, setTrail] = useState<string[]>([]);
  const [version, setVersion] = useState(0);
  const [page, setPage] = useState<ContextPage | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const request = useRef(0);
  useEffect(() => {
    let inFlight = false;
    setLoading(true);
    setError('');
    const load = async (background = false) => {
      if (inFlight) return;
      inFlight = true;
      const current = ++request.current;
      try {
        const result = (await window.electron?.ipcRenderer.invoke(
          'get-observer-context',
          { query, groupBy: 'topic', trail },
        )) as ContextPage | undefined;
        if (request.current !== current) return;
        if (!result?.success)
          throw new Error(
            result?.error ||
              'Saved context could not be loaded. Please try again.',
          );
        if (
          !Array.isArray(result.groups) ||
          typeof result.matchedTotal !== 'number' ||
          typeof result.leaf !== 'boolean' ||
          !Array.isArray(result.breadcrumbs)
        ) {
          throw new Error('Restart Coco to load the updated context explorer.');
        }
        setPage(result);
        setError('');
      } catch (err) {
        // Keep the current graph and expanded evidence in place during a
        // background refresh. A failed refresh retries on the next interval.
        if (request.current === current && !background)
          setError((err as Error).message);
      } finally {
        if (request.current === current) setLoading(false);
        inFlight = false;
      }
    };
    const refreshVisible = () => {
      if (document.visibilityState === 'visible') void load(true);
    };
    const initial = window.setTimeout(() => void load(), 250);
    const interval = window.setInterval(refreshVisible, 30_000);
    window.addEventListener('focus', refreshVisible);
    document.addEventListener('visibilitychange', refreshVisible);
    return () => {
      window.clearTimeout(initial);
      window.clearInterval(interval);
      window.removeEventListener('focus', refreshVisible);
      document.removeEventListener('visibilitychange', refreshVisible);
      request.current += 1;
    };
  }, [query, version, trail]);
  return (
    <div className="knowledge-page">
      <div className="knowledge-toolbar">
        <label className="knowledge-search">
          <input
            aria-label="Search observer context"
            type="search"
            maxLength={200}
            placeholder="Search tasks, projects, and routines"
            value={query}
            onChange={(e) => {
              setQuery(e.target.value);
              setTrail([]);
            }}
          />
        </label>
      </div>
      <nav className="context-breadcrumbs" aria-label="Context path">
        <button
          type="button"
          onClick={() => setTrail([])}
          aria-current={!trail.length ? 'location' : undefined}
        >
          All context
        </button>
        {(page?.breadcrumbs ?? [])
          .slice(0, trail.length)
          .map((crumb, index) => (
            <span key={index}>
              <span aria-hidden>›</span>
              <button
                type="button"
                onClick={() => setTrail(trail.slice(0, index + 1))}
                aria-current={
                  index === trail.length - 1 ? 'location' : undefined
                }
              >
                {crumb.label}
                <small>{crumb.count.toLocaleString()}</small>
              </button>
            </span>
          ))}
      </nav>
      {page && page.total > 0 && !page.leaf && !error && !loading && (
        <ContextGraph
          key={query + JSON.stringify(trail)}
          groups={page.groups}
          total={page.total}
          focusLabel={page.breadcrumbs.at(-1)?.label ?? 'All context'}
          onBack={trail.length ? () => setTrail(trail.slice(0, -1)) : undefined}
          onSelect={(id) => setTrail([...trail, id])}
        />
      )}
      {loading ? (
        <div className="knowledge-loading" role="status">
          Loading saved context…
        </div>
      ) : error ? (
        <div className="knowledge-empty" role="alert">
          <h3>Context is unavailable</h3>
          <p>{error}</p>
          <button
            className="knowledge-button"
            onClick={() => setVersion((v) => v + 1)}
          >
            Try again
          </button>
          {trail.length > 0 && (
            <button className="knowledge-button" onClick={() => setTrail([])}>
              Back to overview
            </button>
          )}
        </div>
      ) : !page?.total ? (
        <EmptyState
          title={
            trail.length
              ? 'No insights in this group'
              : query
                ? 'No matching context'
                : 'Your context starts here'
          }
        >
          {trail.length
            ? 'Use the breadcrumbs to explore another group.'
            : query
              ? 'Try a different word or clear your search.'
              : 'As the observer learns about your activity, its curated context and supporting observations will appear here.'}
        </EmptyState>
      ) : !page.leaf ? null : (
        <>
          <div className="context-selection-heading">
            <h3>{page.breadcrumbs.at(-1)?.label ?? 'Saved insights'}</h3>
            {trail.length > 0 && (
              <button
                className="knowledge-button"
                onClick={() => setTrail(trail.slice(0, -1))}
              >
                Back one level
              </button>
            )}
          </div>
          <div className="knowledge-results" role="status">
            {page.total} saved {page.total === 1 ? 'insight' : 'insights'}
            {query ? ' matching your search' : ''}
          </div>
          <div className="knowledge-context-list">
            {page.items.map((item) => (
              <details className="context-insight" key={item.id}>
                <summary>
                  <span>
                    {item.text.length > 180
                      ? `${item.text.slice(0, 177).replace(/\s+\S*$/, '')}…`
                      : item.text}
                  </span>
                  <small>
                    {dateLabel(item.updatedAt)}
                    <span aria-hidden>⌄</span>
                  </small>
                </summary>
                <div className="context-insight-body">
                  <div className="knowledge-card-meta">
                    <span>Observer context</span>
                    <time
                      dateTime={new Date(item.updatedAt * 1000).toISOString()}
                    >
                      {dateLabel(item.updatedAt)}
                    </time>
                  </div>
                  <MemoryActions
                    text={item.text}
                    label="insight"
                    renderStatement={(actions) => (
                      <p className="knowledge-context-text">
                        {item.text}
                        {actions}
                      </p>
                    )}
                    onSave={async (text) => {
                      const result = (await window.electron.ipcRenderer.invoke(
                        'change-observer-insight',
                        { id: item.id, expected: item.text, text },
                      )) as { success: boolean; error?: string };
                      if (!result?.success)
                        throw new Error(
                          result?.error || 'Insight could not be saved.',
                        );
                      // Keep the current branch and expanded cards mounted. Rebuilding
                      // the graph here can move an edited insight to a different group.
                      request.current += 1;
                      setPage(
                        (current) =>
                          current && {
                            ...current,
                            items:
                              text === null
                                ? current.items.filter(
                                    (entry) => entry.id !== item.id,
                                  )
                                : current.items.map((entry) =>
                                    entry.id === item.id
                                      ? {
                                          ...entry,
                                          text,
                                          updatedAt: Date.now() / 1000,
                                        }
                                      : entry,
                                  ),
                            total: current.total - (text === null ? 1 : 0),
                            matchedTotal:
                              current.matchedTotal - (text === null ? 1 : 0),
                            breadcrumbs: current.breadcrumbs.map((crumb) => ({
                              ...crumb,
                              count: crumb.count - (text === null ? 1 : 0),
                            })),
                          },
                      );
                    }}
                  />
                  <details>
                    <summary>
                      Why Coco remembers this{' '}
                      <span>
                        {item.evidenceCount}{' '}
                        {item.evidenceCount === 1
                          ? 'observation'
                          : 'observations'}
                      </span>
                    </summary>
                    <div className="knowledge-evidence">
                      {item.reasoning && (
                        <div>
                          <h3>Reasoning</h3>
                          <p>{item.reasoning}</p>
                        </div>
                      )}
                      <h3>
                        Supporting observations
                        {item.evidenceCount > item.evidence.length
                          ? ` · latest ${item.evidence.length}`
                          : ''}
                      </h3>
                      {item.evidence.length ? (
                        item.evidence.map((e) => (
                          <blockquote key={e.id}>
                            <time>{dateLabel(e.createdAt)}</time>
                            <p>{e.content}</p>
                          </blockquote>
                        ))
                      ) : (
                        <p>No supporting observations are available.</p>
                      )}
                    </div>
                  </details>
                </div>
              </details>
            ))}
          </div>
        </>
      )}
    </div>
  );
}
