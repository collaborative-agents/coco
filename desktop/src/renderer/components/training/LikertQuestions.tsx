import { useEffect, useId, useState } from 'react';
import './LikertQuestions.css';

const questionsPerPage = (total: number) => {
  if (window.innerHeight < 700) return 1;
  return window.innerWidth < 600 ? 2 : total;
};

export default function LikertQuestions({
  questions,
  options,
  answers,
  disabled,
  onChange,
}: {
  questions: { id: string; text: string }[];
  options: readonly { value: number; label: string }[];
  answers: Record<string, number>;
  disabled: boolean;
  onChange: (id: string, value: number) => void;
}) {
  const prefix = useId();
  const [pageSize, setPageSize] = useState(() =>
    questionsPerPage(questions.length),
  );
  const [page, setPage] = useState(0);
  useEffect(() => {
    const update = () => {
      setPageSize(questionsPerPage(questions.length));
      setPage(0);
    };
    window.addEventListener('resize', update);
    return () => window.removeEventListener('resize', update);
  }, [questions.length]);
  const pages = Math.ceil(questions.length / pageSize);
  const start = Math.min(page, pages - 1) * pageSize;
  return (
    <div className="likert-questions">
      <p className="likert-key" id={`${prefix}-key`}>
        {options.map((option) => (
          <span key={option.value}>
            {option.value} = {option.label}
          </span>
        ))}
      </p>
      {questions.slice(start, start + pageSize).map((question, index) => (
        <div
          className="likert-row"
          key={question.id}
          role="radiogroup"
          aria-labelledby={`${prefix}-${question.id}`}
          aria-describedby={`${prefix}-key`}
        >
          <div className="likert-question" id={`${prefix}-${question.id}`}>
            {start + index + 1}. {question.text}
          </div>
          <div className="likert-options">
            {options.map((option) => (
              <label
                key={option.value}
                title={option.label}
                htmlFor={`${prefix}-${question.id}-${option.value}`}
              >
                <input
                  id={`${prefix}-${question.id}-${option.value}`}
                  type="radio"
                  name={`${prefix}-${question.id}`}
                  value={option.value}
                  checked={answers[question.id] === option.value}
                  disabled={disabled}
                  aria-label={`${option.value} — ${option.label}`}
                  onChange={() => onChange(question.id, option.value)}
                />
                <span aria-hidden="true">{option.value}</span>
              </label>
            ))}
          </div>
        </div>
      ))}
      {pages > 1 && (
        <nav className="likert-pages" aria-label="Rating questions">
          <button
            type="button"
            disabled={disabled || page === 0}
            onClick={() => setPage((value) => value - 1)}
          >
            Previous questions
          </button>
          <span aria-live="polite">
            {pageSize === 1
              ? start + 1
              : `${start + 1}–${Math.min(start + pageSize, questions.length)}`}{' '}
            of {questions.length}
          </span>
          <button
            type="button"
            disabled={disabled || page === pages - 1}
            onClick={() => setPage((value) => value + 1)}
          >
            Next questions
          </button>
        </nav>
      )}
    </div>
  );
}
