import { useId, useState, type ReactNode } from 'react';
import './TrainingTaskGroup.css';

export default function TrainingTaskGroup({
  children,
}: {
  children: ReactNode;
}) {
  const id = useId();
  const [expanded, setExpanded] = useState(true);
  return (
    <li className="training-task-group">
      <div className="training-group-header">
        <h2 id={`${id}-title`}>
          <button
            type="button"
            className="training-group-toggle"
            aria-expanded={expanded}
            aria-controls={`${id}-days`}
            onClick={() => setExpanded((value) => !value)}
          >
            <span className="training-group-chevron" aria-hidden="true">
              {expanded ? '⌄' : '›'}
            </span>
            Training tasks
          </button>
        </h2>
      </div>
      <ol
        id={`${id}-days`}
        className="training-todos training-task-days"
        aria-labelledby={`${id}-title`}
        hidden={!expanded}
      >
        {children}
      </ol>
    </li>
  );
}
