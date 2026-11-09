import {
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  type ComponentProps,
} from 'react';
import { createPortal } from 'react-dom';
import Markdown from 'react-markdown';
import remarkGfm from 'remark-gfm';
import activityHighlights from './activity-highlights';
import subscribeCocoSleepMode from '../../services/coco-sleep-mode';
import {
  cleanObservation,
  type ActivityRecord,
  type InstantSuggestion,
  type SupportDimension,
} from '../observation-types';
import cocoIcon from '../../../../assets/icon.png';
import './ObservationInspector.css';

const activityMarkdownComponents: ComponentProps<
  typeof Markdown
>['components'] = {
  a: ({ children, href }) => (
    <a href={href} target="_blank" rel="noreferrer">
      {children}
    </a>
  ),
};

function scrollActivity(area: HTMLDivElement, top: number) {
  if (typeof area.scrollTo === 'function') {
    area.scrollTo({
      top,
      behavior: window.matchMedia?.('(prefers-reduced-motion: reduce)').matches
        ? 'auto'
        : 'smooth',
    });
  } else {
    area.scrollTop = top;
  }
}

function age(ts: number, now: number) {
  const seconds = Math.max(0, Math.floor(now / 1000 - ts));
  if (seconds < 60) return 'Just now';
  if (seconds < 3600) return `${Math.floor(seconds / 60)} min ago`;
  if (seconds < 86400) return `${Math.floor(seconds / 3600)} hr ago`;
  return new Date(ts * 1000).toLocaleDateString();
}

const supportDimensionTags: Record<
  SupportDimension,
  { label: string; description: string }
> = {
  execution: {
    label: 'Execution',
    description: 'Remove a blocker or get work done.',
  },
  judgment: {
    label: 'Judgment',
    description: 'Check information or make a better decision.',
  },
  learning: {
    label: 'Learning',
    description: 'Build understanding or a skill.',
  },
  attention: {
    label: 'Attention',
    description: 'Stay on track with priorities and follow-ups.',
  },
  motivation: {
    label: 'Motivation',
    description: 'Keep going, recognize progress, or take a break.',
  },
};

function SuggestionTags({ suggestion }: { suggestion: InstantSuggestion }) {
  const dimensions = [...new Set(suggestion.dimensions ?? [])]
    .filter((dimension) =>
      Object.prototype.hasOwnProperty.call(supportDimensionTags, dimension),
    )
    .slice(0, 2);
  return (
    <span
      className="activity-suggestion-tags"
      role="list"
      aria-label="Suggestion tags"
    >
      {dimensions.map((dimension) => (
        <span
          key={dimension}
          role="listitem"
          className={`activity-suggestion-tag activity-suggestion-tag--${dimension}`}
          title={supportDimensionTags[dimension].description}
        >
          {supportDimensionTags[dimension].label}
        </span>
      ))}
      <span
        className="activity-suggestion-tag activity-suggestion-tag--format"
        role="listitem"
      >
        {suggestion.kind === 'delegate' ? 'AI prompt' : 'Ready to use'}
      </span>
    </span>
  );
}

function ActivityEntryContent({
  record,
  suggestionsOnly,
}: {
  record: ActivityRecord;
  suggestionsOnly: boolean;
}) {
  const suggestion = record.proactive_support?.suggestion;
  const observation = (
    <div className="activity-markdown">
      <Markdown
        remarkPlugins={[remarkGfm, activityHighlights]}
        skipHtml
        disallowedElements={['img']}
        components={activityMarkdownComponents}
      >
        {cleanObservation(record.observation)}
      </Markdown>
    </div>
  );
  const suggestionHeading = suggestion && (
    <>
      <span className="activity-suggestion-label">Coco suggested</span>
      <span className="activity-suggestion-title">{suggestion.title}</span>
      <SuggestionTags suggestion={suggestion} />
    </>
  );
  const suggestionContent = suggestion && (
    <div className="activity-markdown activity-suggestion-content">
      <Markdown
        remarkPlugins={[remarkGfm]}
        skipHtml
        disallowedElements={['img']}
        components={activityMarkdownComponents}
      >
        {(suggestion.kind === 'delegate'
          ? suggestion.prompt
          : suggestion.body) || suggestion.copyText}
      </Markdown>
    </div>
  );

  if (suggestionsOnly && suggestion) {
    return (
      <>
        <div className="activity-suggestion-main">
          <h3>{suggestionHeading}</h3>
          {suggestionContent}
        </div>
        <details className="activity-observation-context">
          <summary>Related observation</summary>
          {observation}
        </details>
      </>
    );
  }
  return (
    <>
      {observation}
      {suggestion && (
        <details className="activity-suggestion">
          <summary>{suggestionHeading}</summary>
          {suggestionContent}
        </details>
      )}
    </>
  );
}

export default function ObservationInspector({
  onOpen,
}: {
  onOpen: () => void;
}) {
  const [open, setOpen] = useState(false);
  const [sleeping, setSleeping] = useState<boolean | null>(null);
  const [records, setRecords] = useState<ActivityRecord[]>([]);
  const [suggestionsOnly, setSuggestionsOnly] = useState(false);
  const suggestions = useMemo(
    () => records.filter((record) => record.proactive_support?.suggestion),
    [records],
  );
  const feedRecords = suggestionsOnly ? suggestions : records;
  const [visibleCount, setVisibleCount] = useState(40);
  const [loaded, setLoaded] = useState(false);
  const [error, setError] = useState('');
  const [position, setPosition] = useState({ left: 72, top: 100 });
  const panel = useRef<HTMLDivElement>(null);
  const scrollArea = useRef<HTMLDivElement>(null);
  const [selectedTime, setSelectedTime] = useState<number | 'now'>('now');
  const [jumpTime, setJumpTime] = useState<number | null>(null);
  const [now, setNow] = useState(Date.now());
  const trigger = useRef<HTMLButtonElement>(null);
  const closeButton = useRef<HTMLButtonElement>(null);

  useEffect(() => subscribeCocoSleepMode(setSleeping), []);
  useEffect(() => {
    const ipc = window.electron?.ipcRenderer;
    let disposed = false;
    let revision = 0;
    let refreshTimer: ReturnType<typeof setTimeout> | undefined;
    const remove = ipc?.on('observation-update', (value: unknown) => {
      const record = value as ActivityRecord;
      if (!record?.observation?.trim()) return;
      revision += 1;
      setRecords((previous) => [
        {
          ...record,
          ts: record.ts ?? Date.now() / 1000,
          proactive_support:
            record.proactive_support ??
            previous.find(
              (item) =>
                record.observation_id &&
                item.observation_id === record.observation_id,
            )?.proactive_support,
        },
        ...previous.filter(
          (item) =>
            !record.observation_id ||
            item.observation_id !== record.observation_id,
        ),
      ]);
      setLoaded(true);
      setError('');
    });
    const refresh = () => {
      const initialRevision = revision;
      return ipc
        ?.invoke('get-observation-inspector')
        .then((rows: ActivityRecord[]) => {
          if (!disposed) {
            if (!Array.isArray(rows)) throw new Error();
            setRecords((current) => {
              const seen = new Set<string>();
              const saved = new Map(
                rows.map((row) => [
                  row.observation_id ?? `${row.ts}:${row.observation}`,
                  row,
                ]),
              );
              return [
                ...current.map((row) => ({
                  ...row,
                  proactive_support:
                    saved.get(
                      row.observation_id ?? `${row.ts}:${row.observation}`,
                    )?.proactive_support ?? row.proactive_support,
                })),
                ...rows,
              ]
                .filter((row) => {
                  const key =
                    row.observation_id ?? `${row.ts}:${row.observation}`;
                  if (seen.has(key)) return false;
                  seen.add(key);
                  return true;
                })
                .sort((a, b) => b.ts - a.ts);
            });
            setLoaded(true);
            setError('');
          }
          return undefined;
        })
        .catch(() => {
          if (!disposed && initialRevision === revision) {
            setError(
              'Observations could not be loaded. New observations will appear when available.',
            );
            setLoaded(true);
          }
          return undefined;
        });
    };
    refresh();
    const removeChanged = ipc?.on('activity-history-changed', () => {
      clearTimeout(refreshTimer);
      refreshTimer = setTimeout(() => {
        refresh();
      }, 300);
    });
    return () => {
      disposed = true;
      clearTimeout(refreshTimer);
      if (typeof remove === 'function') remove();
      if (typeof removeChanged === 'function') removeChanged();
    };
  }, []);

  useLayoutEffect(() => {
    if (!open) return undefined;
    const place = () => {
      const rect = trigger.current?.getBoundingClientRect();
      if (!rect) return;
      setPosition({
        left: Math.min(rect.right + 12, Math.max(8, window.innerWidth - 392)),
        top: Math.min(rect.top, Math.max(8, window.innerHeight - 240)),
      });
    };
    place();
    window.addEventListener('resize', place);
    return () => window.removeEventListener('resize', place);
  }, [open]);

  useEffect(() => {
    if (!open) return undefined;
    closeButton.current?.focus();
    setNow(Date.now());
    const escape = (event: KeyboardEvent) => {
      if (event.key === 'Escape') {
        event.stopPropagation();
        setOpen(false);
        trigger.current?.focus();
      }
    };
    const outside = (event: Event) => {
      const target = event.target as Node;
      if (
        !panel.current?.contains(target) &&
        !trigger.current?.contains(target)
      ) {
        setOpen(false);
      }
    };
    document.addEventListener('keydown', escape, true);
    document.addEventListener('pointerdown', outside);
    document.addEventListener('focusin', outside);
    return () => {
      document.removeEventListener('keydown', escape, true);
      document.removeEventListener('pointerdown', outside);
      document.removeEventListener('focusin', outside);
    };
  }, [open]);

  useEffect(() => {
    const timer = window.setInterval(() => setNow(Date.now()), 15000);
    return () => window.clearInterval(timer);
  }, []);

  const today = new Date(now).toDateString();
  const hourStart = (ts: number) => {
    const date = new Date(ts * 1000);
    date.setMinutes(0, 0, 0);
    return date.getTime() / 1000;
  };
  const timeLabel = (ts: number) => {
    const date = new Date(ts * 1000);
    const time = date.toLocaleTimeString([], {
      hour: '2-digit',
      minute: '2-digit',
      hour12: false,
    });
    return date.toDateString() === new Date(now).toDateString()
      ? `${time} today`
      : `${date.toLocaleDateString([], { month: 'short', day: 'numeric', year: 'numeric' })} ${time}`;
  };
  // Index all available history, independent of feed pagination. Compress long
  // idle gaps while retaining room to select dense periods of activity.
  const times = [
    ...new Set(feedRecords.map((record) => hourStart(record.ts))),
  ].sort((a, b) => b - a);
  const suggestionCounts = new Map<number, number>();
  suggestions.forEach((record) => {
    const time = hourStart(record.ts);
    suggestionCounts.set(time, (suggestionCounts.get(time) ?? 0) + 1);
  });

  let timelineDistance = 0;
  const timePositions = times.map((time, index) => {
    const previous = index ? times[index - 1] : now / 1000;
    timelineDistance += Math.log2(2 + Math.max(0, previous - time) / 3600);
    return timelineDistance;
  });

  useLayoutEffect(() => {
    if (jumpTime === null || !open) return;
    const index = feedRecords.findIndex(
      (record) => hourStart(record.ts) === jumpTime,
    );
    if (index < 0) {
      setJumpTime(null);
      return;
    }
    if (index >= visibleCount) {
      setVisibleCount(index + 40);
      return;
    }
    const area = scrollArea.current;
    const entry = area?.querySelector<HTMLElement>(
      `[data-activity-index="${index}"]`,
    );
    if (area && entry) {
      scrollActivity(
        area,
        area.scrollTop +
          entry.getBoundingClientRect().top -
          area.getBoundingClientRect().top -
          16,
      );
    }
    setJumpTime(null);
  }, [jumpTime, open, feedRecords, visibleCount]);

  const latest = records[0];
  const observing =
    sleeping === false &&
    !error &&
    Boolean(latest) &&
    now / 1000 - latest.ts < 300;
  let activityStatus = 'Waiting for an update';
  if (observing) activityStatus = 'Observing';
  if (sleeping) activityStatus = 'Paused';
  if (error) activityStatus = 'Unavailable';
  let emptyText = 'Your recent activity will appear here.';
  if (sleeping) emptyText = 'Activity is paused while Coco is asleep.';
  if (!loaded) emptyText = 'Loading your activity…';
  if (error) emptyText = 'Your activity is unavailable right now.';
  if (suggestionsOnly && loaded && !error) {
    emptyText = 'No suggestions yet. Coco’s suggestions will appear here.';
  }
  const close = () => {
    setOpen(false);
    trigger.current?.focus();
  };

  return (
    <>
      <div className="workspace-logo">
        <button
          ref={trigger}
          type="button"
          className="activity-logo-button"
          title={`Your activity · ${activityStatus}`}
          aria-label="Your activity"
          aria-expanded={open}
          aria-haspopup="dialog"
          aria-controls="observation-inspector"
          onMouseEnter={onOpen}
          onClick={() => {
            if (!open) {
              setSelectedTime('now');
              setJumpTime(null);
              onOpen?.();
            }
            setOpen(!open);
          }}
        >
          <img src={cocoIcon} alt="" />
          <svg
            className={`activity-logo-more${observing ? ' is-observing' : ''}`}
            viewBox="0 0 16 6"
            aria-hidden="true"
          >
            <circle cx="3" cy="3" r="1.2" />
            <circle cx="8" cy="3" r="1.2" />
            <circle cx="13" cy="3" r="1.2" />
          </svg>
        </button>
      </div>
      {open &&
        createPortal(
          <div
            ref={panel}
            id="observation-inspector"
            className="activity-popover"
            role="dialog"
            aria-modal="false"
            aria-labelledby="activity-popover-title"
            style={{
              left: position.left,
              top: position.top,
              maxHeight: `calc(100dvh - ${position.top + 16}px)`,
            }}
          >
            <header className="activity-popover-header">
              <div className="activity-heading">
                <h2 id="activity-popover-title">Your activity</h2>
              </div>
              <span className="activity-live-status">{activityStatus}</span>
              <button
                ref={closeButton}
                type="button"
                className="activity-close"
                aria-label="Close activity"
                onClick={close}
              >
                <svg viewBox="0 0 16 16" aria-hidden="true">
                  <path d="m4 4 8 8M12 4l-8 8" />
                </svg>
              </button>
            </header>
            <div
              className="activity-filters"
              role="group"
              aria-label="Show activity"
            >
              <button
                type="button"
                aria-pressed={!suggestionsOnly}
                onClick={() => {
                  setSuggestionsOnly(false);
                  setVisibleCount(40);
                  setSelectedTime('now');
                  setJumpTime(null);
                  if (scrollArea.current) scrollArea.current.scrollTop = 0;
                }}
              >
                All activity
              </button>
              <button
                type="button"
                className="activity-filter-suggestions"
                aria-label="All suggestions"
                aria-pressed={suggestionsOnly}
                onClick={() => {
                  setSuggestionsOnly(true);
                  setVisibleCount(40);
                  setSelectedTime('now');
                  setJumpTime(null);
                  if (scrollArea.current) scrollArea.current.scrollTop = 0;
                }}
              >
                <span className="activity-suggestion-dot" aria-hidden="true" />
                All suggestions{' '}
                <span className="activity-filter-count">
                  {suggestions.length}
                </span>
              </button>
            </div>
            <div className="activity-timeline-layout">
              <nav
                className="activity-time-index"
                aria-label="Activity timeline"
              >
                <button
                  type="button"
                  aria-label="Now"
                  className="activity-index-now"
                  aria-current={selectedTime === 'now' ? 'time' : undefined}
                  onClick={() => {
                    setSelectedTime('now');
                    setJumpTime(null);
                    if (scrollArea.current)
                      scrollActivity(scrollArea.current, 0);
                  }}
                >
                  <span className="activity-index-tooltip">Now</span>
                </button>
                <div className="activity-index-hours">
                  {times.map((time, index) => (
                    <button
                      key={time}
                      type="button"
                      aria-label={`Jump to ${timeLabel(time)}${
                        suggestionCounts.has(time)
                          ? ` · ${suggestionCounts.get(time)} Coco suggestion${suggestionCounts.get(time) === 1 ? '' : 's'}`
                          : ''
                      }`}
                      className={
                        suggestionCounts.has(time)
                          ? 'has-suggestions'
                          : undefined
                      }
                      aria-current={selectedTime === time ? 'time' : undefined}
                      style={{
                        top: `${(timePositions[index] / timelineDistance) * 100}%`,
                      }}
                      onClick={() => {
                        setSelectedTime(time);
                        setJumpTime(time);
                      }}
                    >
                      <span className="activity-index-tooltip">
                        {timeLabel(time)}
                        {suggestionCounts.has(time) &&
                          ` · ${suggestionCounts.get(time)} suggestion${suggestionCounts.get(time) === 1 ? '' : 's'}`}
                      </span>
                    </button>
                  ))}
                </div>
              </nav>
              <div
                ref={scrollArea}
                className="activity-popover-content"
                onScroll={(event) => {
                  const { scrollTop, scrollHeight, clientHeight } =
                    event.currentTarget;
                  const area = event.currentTarget;
                  if (scrollTop <= 1) setSelectedTime('now');
                  else {
                    const top = area.getBoundingClientRect().top + 16;
                    const entry = Array.from(
                      area.querySelectorAll<HTMLElement>(
                        '[data-activity-index]',
                      ),
                    ).find((item) => item.getBoundingClientRect().bottom > top);
                    const record = entry
                      ? feedRecords[Number(entry.dataset.activityIndex)]
                      : undefined;
                    if (record) setSelectedTime(hourStart(record.ts));
                  }
                  if (scrollHeight - scrollTop - clientHeight < 160) {
                    setVisibleCount((count) =>
                      Math.min(feedRecords.length, count + 40),
                    );
                  }
                }}
              >
                {feedRecords.length === 0 ? (
                  <p className="activity-empty">{emptyText}</p>
                ) : (
                  <ol
                    className="activity-feed"
                    aria-label={
                      suggestionsOnly ? 'All suggestions' : 'Recent activity'
                    }
                  >
                    {feedRecords.slice(0, visibleCount).map((record, index) => (
                      <li
                        data-activity-index={index}
                        className={`${index === 0 ? 'is-latest' : ''}${record.proactive_support?.suggestion ? ' has-suggestion' : ''}`}
                        key={record.observation_id ?? `${record.ts}-${index}`}
                      >
                        <div className="activity-feed-entry">
                          <div className="activity-entry-meta">
                            {index === 0 && (
                              <span className="activity-latest-label">
                                Latest
                              </span>
                            )}
                            <time
                              dateTime={new Date(
                                record.ts * 1000,
                              ).toISOString()}
                              title={new Date(
                                record.ts * 1000,
                              ).toLocaleString()}
                            >
                              {new Date(record.ts * 1000).toDateString() ===
                              today
                                ? new Date(record.ts * 1000).toLocaleTimeString(
                                    [],
                                    { hour: 'numeric', minute: '2-digit' },
                                  )
                                : `${age(record.ts, now)} · ${new Date(record.ts * 1000).toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' })}`}
                            </time>
                          </div>
                          <ActivityEntryContent
                            record={record}
                            suggestionsOnly={suggestionsOnly}
                          />
                        </div>
                      </li>
                    ))}
                  </ol>
                )}
              </div>
            </div>
          </div>,
          document.body,
        )}
    </>
  );
}
