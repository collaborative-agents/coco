/* eslint-disable react/require-default-props -- React 19 uses default function parameters. */
export default function TrainingTodo({
  title,
  complete = false,
  disabled = false,
  onClick,
}: {
  title: string;
  complete?: boolean;
  disabled?: boolean;
  onClick: () => void;
}) {
  return (
    <li>
      <button
        className={`training-todo${complete ? ' training-todo--complete' : ''}`}
        type="button"
        disabled={disabled}
        onClick={onClick}
        aria-label={complete ? `${title} — Complete` : title}
        aria-haspopup="dialog"
      >
        <span className="training-todo-check" aria-hidden="true">
          {complete ? '✓' : ''}
        </span>
        <span className="training-todo-copy">
          <strong>{title}</strong>
        </span>
        <span className="training-todo-chevron" aria-hidden="true">
          ›
        </span>
      </button>
    </li>
  );
}
