import { useLayoutEffect, useRef, type KeyboardEvent } from 'react';
import type { TokenUsageRecord } from '../../../shared/token-usage';
import './TokenUsageHeatmap.css';

export function localDayKey(date: Date) {
  return `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, '0')}-${String(date.getDate()).padStart(2, '0')}`;
}

export function buildTokenCalendar(
  requests: TokenUsageRecord[],
  now = new Date(),
) {
  const end = new Date(now);
  end.setHours(0, 0, 0, 0);
  const start = new Date(end);
  start.setDate(start.getDate() - 364);
  const gridStart = new Date(start);
  gridStart.setDate(gridStart.getDate() - gridStart.getDay());
  const totals = new Map<string, { tokens: number; missing: boolean }>();
  requests.forEach((request) => {
    const key = localDayKey(new Date(request.at));
    const total = totals.get(key) ?? { tokens: 0, missing: false };
    const parts = request.models?.length ? request.models : [request];
    parts.forEach((part) => {
      total.tokens += (part.input ?? 0) + (part.output ?? 0);
      total.missing ||= part.input === null || part.output === null;
    });
    totals.set(key, total);
  });
  const days = [];
  const cursor = new Date(gridStart);
  while (cursor <= end || days.length % 7 !== 0) {
    const key = localDayKey(cursor);
    days.push({
      date: new Date(cursor),
      key,
      active: cursor >= start && cursor <= end,
      ...(totals.get(key) ?? { tokens: 0, missing: false }),
    });
    cursor.setDate(cursor.getDate() + 1);
  }
  const max = Math.max(
    1,
    ...days.filter((day) => day.active).map((day) => day.tokens),
  );
  return days.map((day) => ({
    ...day,
    level: day.tokens ? Math.max(1, Math.ceil((day.tokens / max) * 4)) : 0,
  }));
}

export default function TokenUsageHeatmap({
  requests,
  selected,
  onSelect,
}: {
  requests: TokenUsageRecord[];
  selected: string | null;
  onSelect: (day: string | null) => void;
}) {
  const scrollRef = useRef<HTMLDivElement>(null);
  useLayoutEffect(() => {
    const viewport = scrollRef.current;
    if (viewport) viewport.scrollLeft = viewport.scrollWidth;
  }, []);
  const days = buildTokenCalendar(requests);
  const total = days
    .filter((day) => day.active)
    .reduce((sum, day) => sum + day.tokens, 0);
  const move = (event: KeyboardEvent<HTMLButtonElement>, index: number) => {
    const offsets: Record<string, number> = {
      ArrowLeft: -7,
      ArrowRight: 7,
      ArrowUp: -1,
      ArrowDown: 1,
    };
    if (!(event.key in offsets)) return;
    event.preventDefault();
    const target = index + offsets[event.key];
    event.currentTarget.parentElement
      ?.querySelector<HTMLButtonElement>(`[data-day-index="${target}"]`)
      ?.focus();
  };
  return (
    <div className="token-calendar">
      <p className="token-calendar-title">
        <strong>{total.toLocaleString()}</strong> tokens in the last year
      </p>
      <div className="token-calendar-frame">
        <div
          ref={scrollRef}
          className="token-calendar-scroll"
          role="region"
          aria-label="Daily token usage calendar; scroll horizontally to see the full year"
        >
          <div
            className="token-calendar-chart"
            style={{
              gridTemplateColumns: `32px repeat(${days.length / 7}, minmax(10px, 1fr))`,
            }}
          >
            {days.map(
              (day, index) =>
                day.active &&
                day.date.getDate() === 1 && (
                  <span
                    className="token-calendar-month"
                    key={`month-${day.key}`}
                    style={{
                      gridColumn: Math.floor(index / 7) + 2,
                      gridRow: 1,
                    }}
                  >
                    {day.date.toLocaleDateString(undefined, { month: 'short' })}
                  </span>
                ),
            )}
            {['Mon', 'Wed', 'Fri'].map((label, index) => (
              <span
                key={label}
                className="token-calendar-weekday"
                style={{ gridColumn: 1, gridRow: index * 2 + 3 }}
              >
                {label}
              </span>
            ))}
            {days.map((day, index) => {
              const label = `${day.date.toLocaleDateString(undefined, { month: 'long', day: 'numeric', year: 'numeric' })}: ${day.tokens.toLocaleString()}${day.missing ? ' known' : ''} tokens${day.missing ? '; some usage unavailable' : ''}`;
              const style = {
                gridColumn: Math.floor(index / 7) + 2,
                gridRow: (index % 7) + 2,
              };
              return day.active ? (
                <button
                  key={day.key}
                  type="button"
                  className="token-calendar-day"
                  data-level={day.level}
                  data-day-index={index}
                  style={style}
                  title={label}
                  aria-label={label}
                  aria-pressed={selected === day.key}
                  tabIndex={
                    day.key === (selected ?? localDayKey(new Date())) ? 0 : -1
                  }
                  onKeyDown={(event) => move(event, index)}
                  onClick={() =>
                    onSelect(selected === day.key ? null : day.key)
                  }
                />
              ) : (
                <span key={day.key} style={style} />
              );
            })}
          </div>
        </div>
        <div className="token-calendar-footer">
          <span>Choose a day to see its usage.</span>
          <div
            className="token-calendar-legend"
            aria-label="Lighter green means fewer tokens; darker green means more tokens"
          >
            <span>Less</span>
            {[0, 1, 2, 3, 4].map((level) => (
              <i key={level} data-level={level} />
            ))}
            <span>More</span>
          </div>
        </div>
      </div>
      {selected && (
        <div className="token-calendar-selection">
          <strong>
            {new Date(`${selected}T12:00:00`).toLocaleDateString(undefined, {
              month: 'long',
              day: 'numeric',
              year: 'numeric',
            })}
          </strong>
          <button type="button" onClick={() => onSelect(null)}>
            Show full year
          </button>
        </div>
      )}
    </div>
  );
}
