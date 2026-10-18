import { useState } from 'react';
import {
  SELF_EFFICACY_QUESTIONS,
  SELF_EFFICACY_SCALE,
  type SelfEfficacyAnswers,
} from '../../../shared/post-assessment';
import LikertQuestions from './LikertQuestions';

export default function SelfEfficacySection({
  complete,
  busy,
  onSubmit,
}: {
  complete: boolean;
  busy: boolean;
  onSubmit: (answers: SelfEfficacyAnswers) => Promise<void>;
}) {
  const [answers, setAnswers] = useState<SelfEfficacyAnswers>({});
  const questions = SELF_EFFICACY_QUESTIONS.map((text, index) => ({
    id: String(index + 1),
    text,
  }));
  const ready = questions.every(
    ({ id }) => answers[id] >= 1 && answers[id] <= 5,
  );
  return (
    <section className="post-assessment-section">
      <div className="pre-assessment-challenge-header">
        <div>
          <h3>AI Self-Efficacy Scale</h3>
          <p>
            Select the response that best represents how you feel right now.
            There are no right or wrong answers.
          </p>
        </div>
        {complete && (
          <span className="pre-assessment-status pre-assessment-status--done">
            ✓ Submitted
          </span>
        )}
      </div>
      {complete ? (
        <div className="post-assessment-submitted">
          Your self-assessment has been submitted.
        </div>
      ) : (
        <>
          <LikertQuestions
            questions={questions}
            options={SELF_EFFICACY_SCALE}
            answers={answers}
            disabled={busy}
            onChange={(id, value) =>
              setAnswers((current) => ({ ...current, [id]: value }))
            }
          />
          <button
            type="button"
            className="pre-assessment-submit"
            disabled={busy || !ready}
            onClick={() => onSubmit(answers)}
          >
            {busy ? 'Submitting…' : 'Submit self-assessment'}
          </button>
        </>
      )}
    </section>
  );
}
