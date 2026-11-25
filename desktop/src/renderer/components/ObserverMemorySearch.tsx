import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import ReactMarkdown from 'react-markdown';
import remarkGfm from 'remark-gfm';
import WorkspaceDialog from './chat/WorkspaceDialog';
import './chat/WorkspaceDialog.css';
import memoryCitations from './memory-citations';
import type { ObserverMemorySearchResult } from '../../shared/observer-memory';

type Answer = Extract<ObserverMemorySearchResult, { success: true }>;

export function useObserverMemorySearch() {
  const [submitted, setSubmitted] = useState('');
  const [answer, setAnswer] = useState<Answer | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const revision = useRef(0);
  useEffect(
    () => () => {
      revision.current += 1;
    },
    [],
  );

  const clear = useCallback(() => {
    revision.current += 1;
    setAnswer(null);
    setError('');
    setBusy(false);
  }, []);

  const search = async (question: string) => {
    if (!question.trim() || busy) return;
    revision.current += 1;
    const { current } = revision;
    setBusy(true);
    setSubmitted(question.trim());
    setAnswer(null);
    setError('');
    try {
      const result = (await window.electron?.ipcRenderer.invoke(
        'search-observer-memory',
        { question: question.trim() },
      )) as ObserverMemorySearchResult | undefined;
      if (revision.current !== current) return;
      if (!result?.success)
        throw new Error(
          result?.error || 'Memory search is unavailable. Please try again.',
        );
      setAnswer(result);
    } catch (err) {
      if (revision.current === current) setError((err as Error).message);
    } finally {
      if (revision.current === current) setBusy(false);
    }
  };

  return { submitted, answer, busy, error, search, clear };
}

export default function ObserverMemorySearch({
  state,
}: {
  state: ReturnType<typeof useObserverMemorySearch>;
}) {
  const { answer, busy, error } = state;
  const [selectedNumber, setSelectedNumber] = useState<number | null>(null);
  const [zoomed, setZoomed] = useState(false);
  useEffect(() => {
    setSelectedNumber(null);
    setZoomed(false);
  }, [answer]);
  const selected = answer?.sources.find(
    (source) => source.number === selectedNumber,
  );
  const openSource = useCallback((number: number) => {
    setSelectedNumber(number);
    setZoomed(false);
  }, []);
  const markdown = useMemo(
    () =>
      answer ? (
        <ReactMarkdown
          skipHtml
          remarkPlugins={[
            remarkGfm,
            [
              memoryCitations,
              { numbers: answer.sources.map((source) => source.number) },
            ],
          ]}
          disallowedElements={['img']}
          components={{
            // Memoization preserves the citation DOM while the viewer changes.
            // eslint-disable-next-line react/no-unstable-nested-components
            a: ({ children, href }) => {
              const match = href?.match(/^#screen-source-(\d+)$/);
              const source =
                match &&
                answer.sources.find((item) => item.number === Number(match[1]));
              return source ? (
                <button
                  type="button"
                  className="observer-memory-citation"
                  aria-label={`View source ${source.number}`}
                  title={`Screen captured ${source.time}`}
                  onClick={() => openSource(source.number)}
                >
                  {children}
                </button>
              ) : (
                <a href={href} target="_blank" rel="noreferrer">
                  {children}
                </a>
              );
            },
          }}
        >
          {answer.answer}
        </ReactMarkdown>
      ) : null,
    [answer, openSource],
  );
  return (
    <section
      className="observer-memory-search"
      aria-label="Memory search results"
    >
      {busy && (
        <div className="observer-memory-progress" role="status">
          <div className="observer-memory-progress-heading">
            <span className="observer-memory-progress-icon" aria-hidden="true">
              <svg
                width="20"
                height="20"
                viewBox="0 0 24 24"
                fill="none"
                stroke="currentColor"
                strokeWidth="1.6"
              >
                <circle cx="10.5" cy="10.5" r="6.5" />
                <path d="m16 16 4.5 4.5" />
              </svg>
            </span>
            <div>
              <h3>Searching your memory</h3>
              <p>Finding relevant screens and reading the evidence…</p>
            </div>
            <span className="observer-memory-progress-dot" aria-hidden="true" />
          </div>
          <div className="observer-memory-progress-track" aria-hidden="true">
            <span />
          </div>
          <div className="observer-memory-progress-preview" aria-hidden="true">
            <div className="observer-memory-progress-lines">
              <span />
              <span />
              <span />
            </div>
            <span className="observer-memory-progress-caption">
              Connecting details from your screen history
            </span>
          </div>
        </div>
      )}
      {error && (
        <p className="observer-memory-error" role="alert">
          {error}
        </p>
      )}
      {answer && (
        <article className="observer-memory-answer" aria-label="Memory answer">
          <header className="observer-memory-answer-header">
            <div className="observer-memory-report-heading">
              <svg
                aria-hidden="true"
                width="18"
                height="18"
                viewBox="0 0 24 24"
                fill="none"
                stroke="currentColor"
                strokeWidth="1.5"
              >
                <path d="M14 3H6a1 1 0 0 0-1 1v16a1 1 0 0 0 1 1h12a1 1 0 0 0 1-1V8z" />
                <path d="M14 3v5h5M9 12h6M9 16h6" />
              </svg>
              <span>From your screen history</span>
            </div>
            {answer.sources.length > 0 && (
              <button
                type="button"
                className="observer-memory-source-count"
                onClick={() => openSource(answer.sources[0].number)}
              >
                {answer.sources.length}{' '}
                {answer.sources.length === 1 ? 'source' : 'sources'} ↗
              </button>
            )}
          </header>
          <div className="observer-memory-markdown">{markdown}</div>
          {answer.sources.length > 0 ? (
            <section
              className="observer-memory-sources"
              aria-label="Supporting screenshots"
            >
              <span className="observer-memory-sources-label">
                Retrieved screens
              </span>
              <div className="observer-memory-source-cards">
                {answer.sources.map((source) => (
                  <button
                    type="button"
                    key={source.number}
                    className="observer-memory-source-card"
                    onClick={() => openSource(source.number)}
                    aria-label={`Open screenshot ${source.number}, captured ${source.time}`}
                  >
                    <img src={source.imageUrl} alt="" loading="lazy" />
                    <span>
                      <strong>Screen {source.number}</strong>
                      <time dateTime={new Date(source.ts * 1000).toISOString()}>
                        {source.time}
                      </time>
                    </span>
                  </button>
                ))}
              </div>
            </section>
          ) : (
            <p className="observer-memory-description">
              No supporting screenshots were found.
            </p>
          )}
        </article>
      )}
      {selected &&
        answer &&
        createPortal(
          <WorkspaceDialog
            open
            title={`Screen ${selected.number}`}
            className="observer-memory-viewer"
            onClose={() => setSelectedNumber(null)}
            headerAction={
              <button
                type="button"
                className="observer-memory-zoom"
                aria-pressed={zoomed}
                onClick={() => setZoomed(!zoomed)}
              >
                {zoomed ? 'Fit to view' : 'Actual size'}
              </button>
            }
          >
            <p className="observer-memory-capture-time">
              Captured{' '}
              <time dateTime={new Date(selected.ts * 1000).toISOString()}>
                {selected.time}
              </time>
            </p>
            <div
              className={`observer-memory-image-stage${zoomed ? ' is-zoomed' : ''}`}
            >
              <img
                src={selected.imageUrl}
                alt={`Source ${selected.number}, captured ${selected.time}`}
              />
            </div>
            <nav
              className="observer-memory-filmstrip"
              aria-label="Retrieved screenshots"
            >
              {answer.sources.map((source) => (
                <button
                  type="button"
                  key={source.number}
                  aria-label={`Show source ${source.number}`}
                  aria-current={
                    source.number === selected.number ? 'true' : undefined
                  }
                  onClick={() => openSource(source.number)}
                >
                  <img src={source.imageUrl} alt="" />
                  <span>Screen {source.number}</span>
                </button>
              ))}
            </nav>
          </WorkspaceDialog>,
          document.body,
        )}
    </section>
  );
}
