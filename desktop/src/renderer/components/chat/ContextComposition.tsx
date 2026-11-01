import type { AgentContextSnapshot } from '../../../shared/agent-context';
import './ContextViewer.css';

const colors = [
  '#668bd1',
  '#8d78bf',
  '#53a59b',
  '#c49b52',
  '#c47c8b',
  '#7893a6',
];
const number = (value: number) => Math.round(value).toLocaleString();

export default function ContextComposition({
  snapshot,
}: {
  snapshot: AgentContextSnapshot;
}) {
  const total = snapshot.estimatedTokens;
  const capacity = snapshot.reported?.contextWindow;
  const scale = Math.max(total, capacity ?? 0, 1);
  return (
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
    </>
  );
}
