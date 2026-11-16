import { useState } from 'react';

export interface ContextGroup {
  id: string;
  label: string;
  count: number;
}
export default function ContextGraph({
  groups,
  total,
  focusLabel,
  onBack,
  onSelect,
}: {
  groups: ContextGroup[];
  total: number;
  focusLabel: string;
  onBack?: () => void;
  onSelect: (id: string) => void;
}) {
  const [page, setPage] = useState(0);
  const pageCount = Math.max(1, Math.ceil(groups.length / 8));
  const currentPage = Math.min(page, pageCount - 1);
  const visible = groups.slice(currentPage * 8, currentPage * 8 + 8);
  const rows = Math.max(2, Math.ceil(visible.length / 2));
  const centerY = rows * 50;
  return (
    <section className="context-map" aria-label="Observer context graph">
      <div className="context-map-heading">
        <div>
          <h3>{focusLabel}</h3>
          <p>Choose a group to explore further.</p>
        </div>
        <span>{groups.length} groups</span>
      </div>
      <div
        className="context-map-canvas"
        style={{ gridTemplateRows: `repeat(${rows}, 100px)` }}
      >
        <svg
          className="context-map-edges"
          viewBox={`0 0 800 ${rows * 100}`}
          preserveAspectRatio="none"
          aria-hidden="true"
        >
          {visible.map((group, index) => {
            const side = index % 2;
            const y = 50 + Math.floor(index / 2) * 100;
            return (
              <path
                key={group.id}
                d={`M400 ${centerY} C${side ? 510 : 290} ${centerY}, ${side ? 510 : 290} ${y}, ${side ? 650 : 150} ${y}`}
              />
            );
          })}
        </svg>
        <button
          className="context-map-root"
          onClick={onBack}
          disabled={!onBack}
          aria-label={onBack ? 'Back one level' : 'All context'}
        >
          <strong>{total.toLocaleString()}</strong>
          <span>{focusLabel}</span>
          <small>{onBack ? 'Back one level' : 'Select a group'}</small>
        </button>
        {visible.map((group, index) => (
          <button
            key={group.id}
            className="context-map-node"
            style={{
              gridColumn: index % 2 ? 3 : 1,
              gridRow: Math.floor(index / 2) + 1,
            }}
            onClick={() => onSelect(group.id)}
          >
            <span className="context-map-count">
              {group.count.toLocaleString()}
            </span>
            <span>{group.label}</span>
          </button>
        ))}
      </div>
      {pageCount > 1 && (
        <div className="knowledge-pagination">
          <button
            className="knowledge-button"
            disabled={currentPage === 0}
            onClick={() => setPage(currentPage - 1)}
          >
            Previous groups
          </button>
          <span>
            {currentPage + 1} / {pageCount}
          </span>
          <button
            className="knowledge-button"
            disabled={currentPage + 1 >= pageCount}
            onClick={() => setPage(currentPage + 1)}
          >
            More groups
          </button>
        </div>
      )}
    </section>
  );
}
