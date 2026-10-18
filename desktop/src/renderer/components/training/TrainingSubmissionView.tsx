import { useEffect, useState } from 'react';
import {
  DAILY_REFLECTION_OPEN_QUESTIONS,
  DAILY_REFLECTION_RATING_QUESTIONS,
} from '../../../shared/study';
import { SELF_EFFICACY_SCALE } from '../../../shared/post-assessment';
import type { TrainingSubmission } from '../../../shared/training-submission';
import { api } from './training-api';
import './TrainingSubmissionView.css';

export default function TrainingSubmissionView({ day }: { day: number }) {
  const [submission, setSubmission] = useState<TrainingSubmission | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const [retry, setRetry] = useState(0);
  useEffect(() => {
    let active = true;
    setLoading(true);
    setError('');
    setSubmission(null);
    api('study-task-submission', day)
      .then((result: TrainingSubmission | null) => {
        if (active) setSubmission(result);
        return undefined;
      })
      .finally(() => {
        if (active) setLoading(false);
      })
      .catch((reason: unknown) => {
        if (active)
          setError(reason instanceof Error ? reason.message : String(reason));
      });
    return () => {
      active = false;
    };
  }, [day, retry]);
  const ratingKeys = ['q1', 'q2', 'q3', 'q4', 'q5'] as const;
  const writingKeys = ['q6', 'q7', 'q8'] as const;
  return (
    <section className="training-submission" aria-label="Your submission">
      <h3>Your submission</h3>
      {loading && <p role="status">Loading your submission…</p>}
      {error && (
        <div role="alert" className="training-error">
          {error}{' '}
          <button type="button" onClick={() => setRetry((value) => value + 1)}>
            Retry submission
          </button>
        </div>
      )}
      {!loading && !error && !submission && (
        <p>
          This task is complete, but its saved submission isn’t available on
          this device.
        </p>
      )}
      {submission && (
        <>
          <h4>Screenshot</h4>
          {submission.screenshotDataUrl ? (
            <img
              className="training-submission-screenshot"
              src={submission.screenshotDataUrl}
              alt="Your submitted screenshot"
            />
          ) : (
            <p>Your screenshot isn’t available on this device.</p>
          )}
          <h4>Your reflection</h4>
          <dl>
            {DAILY_REFLECTION_RATING_QUESTIONS.map((question, index) => {
              const value = submission.answers[ratingKeys[index]];
              return (
                <div key={question}>
                  <dt>{question}</dt>
                  <dd>
                    {value} —{' '}
                    {
                      SELF_EFFICACY_SCALE.find(
                        (option) => option.value === value,
                      )?.label
                    }
                  </dd>
                </div>
              );
            })}
            {DAILY_REFLECTION_OPEN_QUESTIONS.map((question, index) => (
              <div key={question}>
                <dt>{question}</dt>
                <dd>{submission.answers[writingKeys[index]]}</dd>
              </div>
            ))}
          </dl>
        </>
      )}
    </section>
  );
}
