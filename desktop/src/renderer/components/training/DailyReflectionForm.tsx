/* eslint-disable react/require-default-props -- React 19 uses default function parameters. */
import { useState } from 'react';
import {
  DAILY_REFLECTION_OPEN_QUESTIONS,
  DAILY_REFLECTION_RATING_QUESTIONS,
  type DailyReflection,
} from '../../../shared/study';
import TrainingDialog from './TrainingDialog';
import LikertQuestions from './LikertQuestions';
import { SELF_EFFICACY_SCALE } from '../../../shared/post-assessment';
import './DailyReflectionForm.css';

const emptyReflection = (): DailyReflection => ({
  q1: 0,
  q2: 0,
  q3: 0,
  q4: 0,
  q5: 0,
  q6: '',
  q7: '',
  q8: '',
});

export default function DailyReflectionForm({
  day,
  busy,
  error = '',
  onClose,
  onSubmit,
}: {
  day: number;
  busy: boolean;
  error?: string;
  onClose: () => void;
  onSubmit: (answers: DailyReflection) => Promise<void>;
}) {
  const [answers, setAnswers] = useState<DailyReflection>(emptyReflection);
  const [step, setStep] = useState<'ratings' | 'writing'>('ratings');
  const ratingKeys = ['q1', 'q2', 'q3', 'q4', 'q5'] as const;
  const responseKeys = ['q6', 'q7', 'q8'] as const;
  const ratingsReady = ratingKeys.every(
    (key) => answers[key] >= 1 && answers[key] <= 5,
  );
  const ready =
    ratingsReady && responseKeys.every((key) => answers[key].trim().length > 0);

  return (
    <TrainingDialog
      open
      title="Tell us about your practice"
      onClose={onClose}
      busy={busy}
    >
      <section className="training-reflection">
        {error && (
          <p role="alert" className="training-error">
            {error}
          </p>
        )}
        <div className="training-reflection-header">
          <div>
            <span className="training-eyebrow">DAY {day} REFLECTION</span>
            <p>
              There are no right or wrong answers. Your honest feedback helps us
              improve the camp.
            </p>
          </div>
        </div>

        {step === 'ratings' ? (
          <>
            <LikertQuestions
              questions={DAILY_REFLECTION_RATING_QUESTIONS.map(
                (text, index) => ({ id: ratingKeys[index], text }),
              )}
              options={SELF_EFFICACY_SCALE}
              answers={Object.fromEntries(
                ratingKeys.map((key) => [key, answers[key]]),
              )}
              disabled={busy}
              onChange={(id, value) =>
                setAnswers((current) => ({ ...current, [id]: value }))
              }
            />
            <button
              type="button"
              className="training-primary"
              disabled={busy || !ratingsReady}
              onClick={() => setStep('writing')}
            >
              Next: written reflection
            </button>
          </>
        ) : (
          <>
            <button
              type="button"
              disabled={busy}
              onClick={() => setStep('ratings')}
            >
              Back to ratings
            </button>
            <div className="training-reflection-writing">
              {DAILY_REFLECTION_OPEN_QUESTIONS.map(
                (question, questionIndex) => {
                  const key = responseKeys[questionIndex];
                  return (
                    <label key={key} htmlFor={`day-${day}-${key}`}>
                      <strong>
                        {questionIndex + 6}. {question}
                      </strong>
                      <textarea
                        id={`day-${day}-${key}`}
                        rows={4}
                        maxLength={5000}
                        value={answers[key]}
                        disabled={busy}
                        onChange={(event) =>
                          setAnswers((current) => ({
                            ...current,
                            [key]: event.target.value,
                          }))
                        }
                      />
                    </label>
                  );
                },
              )}
            </div>

            <div className="training-reflection-submit">
              <div>
                <strong>One last step</strong>
                <span>
                  After submitting your reflection, choose a screenshot of your
                  favorite moment.
                </span>
              </div>
              <button
                type="button"
                className="training-proof-action"
                disabled={busy || !ready}
                onClick={() => onSubmit(answers)}
              >
                Submit reflection &amp; add screenshot
              </button>
            </div>
          </>
        )}
      </section>
    </TrainingDialog>
  );
}
