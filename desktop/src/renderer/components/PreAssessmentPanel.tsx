/* eslint-disable react/require-default-props -- React 19 uses default function parameters. */
import React, { useCallback, useEffect, useMemo, useState } from 'react';
import {
  SET_A_QUESTIONS,
  SET_E_AI_RESPONSE,
  SET_E_MODEL_ANSWER,
  SET_E_QUESTIONS,
  type PreAssessmentResult,
  type PreAssessmentSet,
  type PreAssessmentState,
  type SetAAnswers,
  type SetEAnswers,
} from '../../shared/pre-assessment';

const invoke = (
  channel: Parameters<typeof window.electron.ipcRenderer.invoke>[0],
  ...args: unknown[]
) => window.electron.ipcRenderer.invoke(channel, ...args);

const emptyEAnswers: SetEAnswers = { e1: '', e2: '', e3: '' };

function ScoreCard({ result }: { result: PreAssessmentResult }) {
  const strong = result.score / result.maxScore >= 0.75;
  return (
    <div
      className={`pre-assessment-score pre-assessment-score--${strong ? 'strong' : 'growing'}`}
    >
      <span className="pre-assessment-score-icon" aria-hidden>
        {strong ? '★' : '✦'}
      </span>
      <div>
        <h3>
          {result.score} / {result.maxScore}
        </h3>
        <p>
          {strong
            ? 'Excellent work! You already have a strong foundation for working thoughtfully with AI.'
            : 'Nice start! The camp will help you build on this foundation—every challenge is a chance to grow.'}
        </p>
      </div>
    </div>
  );
}

function SetAChallenge({
  result,
  onSubmit,
  busy,
}: {
  result: PreAssessmentResult | null;
  onSubmit: (set: PreAssessmentSet, answers: SetAAnswers) => Promise<void>;
  busy: boolean;
}) {
  const [answers, setAnswers] = useState<SetAAnswers>(() =>
    result ? (result.answers as SetAAnswers) : {},
  );
  const complete = Boolean(result);
  const allAnswered = SET_A_QUESTIONS.every(
    (question) => answers[String(question.id)],
  );

  return (
    <section
      className={`pre-assessment-challenge${complete ? ' pre-assessment-challenge--complete' : ''}`}
    >
      <div className="pre-assessment-challenge-header">
        <div>
          <h3>Conceptual Understanding</h3>
          <p>Choose the one best answer for each question.</p>
        </div>
        {complete && (
          <span className="pre-assessment-status pre-assessment-status--done">
            ✓ Complete
          </span>
        )}
      </div>

      {complete && result && <ScoreCard result={result} />}

      <div className="pre-assessment-questions">
        {SET_A_QUESTIONS.map((question) => {
          const submittedAnswer = result
            ? (result.answers as SetAAnswers)[String(question.id)]
            : null;
          return (
            <fieldset key={question.id} className="pre-assessment-question">
              <legend>
                <span>{question.id}</span>
                {question.question}
              </legend>
              <div className="pre-assessment-options">
                {question.options.map((option) => {
                  const selected =
                    (result
                      ? (result.answers as SetAAnswers)[String(question.id)]
                      : answers[String(question.id)]) === option.id;
                  const correct =
                    complete && option.id === question.correctAnswer;
                  const incorrect = complete && selected && !correct;
                  return (
                    <label
                      key={option.id}
                      htmlFor={`set-a-${question.id}-${option.id}`}
                      className={`${correct ? 'pre-assessment-option--correct' : ''}${incorrect ? ' pre-assessment-option--incorrect' : ''}`}
                    >
                      <input
                        id={`set-a-${question.id}-${option.id}`}
                        type="radio"
                        name={`set-a-${question.id}`}
                        value={option.id}
                        checked={selected}
                        disabled={complete || busy}
                        onChange={() =>
                          setAnswers((current) => ({
                            ...current,
                            [String(question.id)]: option.id,
                          }))
                        }
                      />
                      <strong>{option.id}</strong>
                      <span>{option.text}</span>
                    </label>
                  );
                })}
              </div>
              {complete && (
                <p className="pre-assessment-answer-note">
                  <strong>Answer: {question.correctAnswer}.</strong>{' '}
                  {question.rationale}
                  {submittedAnswer !== question.correctAnswer && (
                    <span> Your answer was {submittedAnswer}.</span>
                  )}
                </p>
              )}
            </fieldset>
          );
        })}
      </div>

      {!complete && (
        <button
          type="button"
          className="pre-assessment-submit"
          disabled={busy || !allAnswered}
          onClick={() => onSubmit('A', answers)}
        >
          {busy ? 'Checking answers…' : 'Finish Challenge 1 & see my score'}
        </button>
      )}
    </section>
  );
}

function SetEChallenge({
  result,
  onSubmit,
  busy,
}: {
  result: PreAssessmentResult | null;
  onSubmit: (set: PreAssessmentSet, answers: SetEAnswers) => Promise<void>;
  busy: boolean;
}) {
  const [answers, setAnswers] = useState<SetEAnswers>(() =>
    result ? (result.answers as SetEAnswers) : emptyEAnswers,
  );
  const complete = Boolean(result);
  const allAnswered = Object.values(answers).every(
    (answer) => answer.trim().length >= 3,
  );

  return (
    <section
      className={`pre-assessment-challenge${complete ? ' pre-assessment-challenge--complete' : ''}`}
    >
      <div className="pre-assessment-challenge-header">
        <div>
          <h3>Anti-Blind-Acceptance</h3>
          <p>
            Review the AI output and explain what you would verify before using
            it.
          </p>
        </div>
        {complete && (
          <span className="pre-assessment-status pre-assessment-status--done">
            ✓ Complete
          </span>
        )}
      </div>

      <div className="pre-assessment-prompt">
        <strong>Scenario</strong>
        <p>
          You asked an AI tool: “What are the requirements for hiring a
          part-time employee in my state?”
        </p>
        <blockquote>{SET_E_AI_RESPONSE}</blockquote>
      </div>

      {complete && result && <ScoreCard result={result} />}

      <div className="pre-assessment-questions">
        {SET_E_QUESTIONS.map((question, index) => (
          <label
            key={question.id}
            htmlFor={`set-e-${question.id}`}
            className="pre-assessment-writing-question"
          >
            <strong>
              E{index + 1}. {question.question}
            </strong>
            <textarea
              id={`set-e-${question.id}`}
              value={
                result
                  ? (result.answers as SetEAnswers)[question.id]
                  : answers[question.id]
              }
              disabled={complete || busy}
              rows={question.id === 'e1' ? 7 : 5}
              onChange={(event) =>
                setAnswers((current) => ({
                  ...current,
                  [question.id]: event.target.value,
                }))
              }
            />
          </label>
        ))}
      </div>

      {complete && (
        <div className="pre-assessment-model-answer">
          <h4>What a strong answer includes</h4>
          <ul>
            {SET_E_MODEL_ANSWER.map((item) => (
              <li key={item}>{item}</li>
            ))}
          </ul>
        </div>
      )}

      {!complete && (
        <button
          type="button"
          className="pre-assessment-submit"
          disabled={busy || !allAnswered}
          onClick={() => onSubmit('E', answers)}
        >
          {busy ? 'Reviewing response…' : 'Finish Challenge 2 & see my score'}
        </button>
      )}
    </section>
  );
}

export default function PreAssessmentPanel({
  onCompletionChange,
  required = true,
}: {
  onCompletionChange: (complete: boolean) => void;
  required?: boolean;
}) {
  const [state, setState] = useState<PreAssessmentState | null>(null);
  const [activeSet, setActiveSet] = useState<PreAssessmentSet>('A');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');

  const load = useCallback(async () => {
    const next = (await invoke('pre-assessment-state')) as PreAssessmentState;
    setState(next);
    onCompletionChange(next.complete);
  }, [onCompletionChange]);

  useEffect(() => {
    load().catch((reason) =>
      setError(reason instanceof Error ? reason.message : String(reason)),
    );
  }, [load]);

  const completedCount = useMemo(
    () =>
      state ? Number(Boolean(state.sets.A)) + Number(Boolean(state.sets.E)) : 0,
    [state],
  );

  const submit = async (
    set: PreAssessmentSet,
    answers: SetAAnswers | SetEAnswers,
  ) => {
    setBusy(true);
    setError('');
    try {
      await invoke('pre-assessment-submit', set, answers);
      await load();
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : String(reason));
    } finally {
      setBusy(false);
    }
  };

  const challengeContent = state ? (
    <>
      <div
        className="pre-assessment-tabs"
        role="tablist"
        aria-label="Pre-assessment challenges"
      >
        {(['A', 'E'] as const).map((set, index) => (
          <button
            key={set}
            type="button"
            role="tab"
            aria-selected={activeSet === set}
            onClick={() => setActiveSet(set)}
          >
            <span>{state.sets[set] ? '✓' : index + 1}</span>
            Challenge {index + 1}
          </button>
        ))}
      </div>
      <div role="tabpanel">
        {activeSet === 'A' ? (
          <SetAChallenge result={state.sets.A} onSubmit={submit} busy={busy} />
        ) : (
          <SetEChallenge result={state.sets.E} onSubmit={submit} busy={busy} />
        )}
      </div>
    </>
  ) : (
    <p>Loading your pre-assessments…</p>
  );

  return (
    <section
      className={`training-card pre-assessment${state?.complete ? ' pre-assessment--complete' : ''}`}
      aria-label="Starting assessment"
    >
      {!state?.complete && (
        <div className="pre-assessment-intro">
          <div>
            <h2 id="pre-assessment-title">
              Complete both pre-assessment challenges
            </h2>
            <p>
              {required
                ? 'These questions help you see your starting point. Coco chat, sensing, and camp tasks unlock after both challenges are complete.'
                : 'This is the participant pre-assessment experience. Admin accounts can preview and complete both challenges.'}
            </p>
          </div>
          <div
            className="pre-assessment-progress"
            role="progressbar"
            aria-label="Pre-assessment progress"
            aria-valuemin={0}
            aria-valuemax={2}
            aria-valuenow={completedCount}
          >
            <strong>{completedCount}/2</strong>
            <span>complete</span>
          </div>
        </div>
      )}
      {error && (
        <p className="training-error" role="alert">
          {error}
        </p>
      )}
      {challengeContent}
    </section>
  );
}
