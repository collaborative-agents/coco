import React, { useCallback, useEffect, useMemo, useState } from 'react';
import {
  AI_LITERACY_QUESTIONS,
  EXECUTION_QUESTIONNAIRE_QUESTIONS,
  POST_ASSESSMENT_TOOLKIT,
  type AiLiteracyAnswers,
  type ExecutionQuestionnaire,
  type PostAssessmentSection,
  type PostAssessmentState,
  type TaskRecorderCapture,
  type TaskRecorderState,
} from '../../shared/post-assessment';

import SelfEfficacySection from './training/SelfEfficacySection';

const invoke = (
  channel: Parameters<typeof window.electron.ipcRenderer.invoke>[0],
  ...args: unknown[]
) => window.electron.ipcRenderer.invoke(channel, ...args);

const emptyQuestionnaire = (): ExecutionQuestionnaire => ({
  decision: '',
  reasoning: '',
  aiUse: '',
  alternatives: '',
  challenge: '',
  ownership: 0,
});

function AiLiteracySection({
  complete,
  busy,
  onSubmit,
}: {
  complete: boolean;
  busy: boolean;
  onSubmit: (answers: AiLiteracyAnswers) => Promise<void>;
}) {
  const [answers, setAnswers] = useState<AiLiteracyAnswers>({});
  const ready = AI_LITERACY_QUESTIONS.every(
    (question) => answers[String(question.id)],
  );

  return (
    <section className="post-assessment-section">
      <div className="pre-assessment-challenge-header">
        <div>
          <h3>AI Literacy Test</h3>
          <p>Choose the one best answer for each question.</p>
        </div>
        {complete && (
          <span className="pre-assessment-status pre-assessment-status--done">
            ✓ Submitted
          </span>
        )}
      </div>
      {complete ? (
        <div className="post-assessment-submitted">
          Your AI literacy test has been submitted.
        </div>
      ) : (
        <>
          <div className="pre-assessment-questions">
            {AI_LITERACY_QUESTIONS.map((question) => (
              <fieldset key={question.id} className="pre-assessment-question">
                <legend>
                  <span>{question.id}</span>
                  {question.question}
                </legend>
                <div className="pre-assessment-options">
                  {question.options.map((option) => (
                    <label
                      key={option.id}
                      htmlFor={`literacy-${question.id}-${option.id}`}
                    >
                      <input
                        id={`literacy-${question.id}-${option.id}`}
                        type="radio"
                        name={`literacy-${question.id}`}
                        value={option.id}
                        checked={answers[String(question.id)] === option.id}
                        disabled={busy}
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
                  ))}
                </div>
              </fieldset>
            ))}
          </div>
          <button
            type="button"
            className="pre-assessment-submit"
            disabled={busy || !ready}
            onClick={async () => onSubmit(answers)}
          >
            {busy ? 'Submitting…' : 'Submit AI literacy test'}
          </button>
        </>
      )}
    </section>
  );
}

function MissionBriefing() {
  return (
    <div className="post-assessment-mission">
      <div className="post-assessment-mission-title">
        <span aria-hidden>🎯</span>
        <div>
          <h3>Trust, But Verify</h3>
        </div>
      </div>
      <p>
        You are a financial analyst at Meridian Analytics Inc. (a fictional
        company). Today is August 10, 2026. Leadership needs to cut this year’s
        operating budget by at least 8%. An AI finance tool has already produced
        three rough draft plans. None has been checked by a person.
      </p>
      <p>
        Choose one plan to take forward, check its numbers and claims against
        the provided files, fix anything that is wrong, and update the plan if
        needed so it still reaches the 8% target. Then complete the answer sheet
        with:
      </p>
      <ol>
        <li>
          The plan you chose, why you chose it, and why you did not choose one
          of the others.
        </li>
        <li>
          Your updated plan, including each action, its yearly savings, and
          where the number comes from.
        </li>
        <li>
          What you changed from the original AI draft and the evidence that led
          to each change.
        </li>
      </ol>
      <p>
        There is no single correct plan. We are interested in how you make the
        decision, use AI to help you, and ensure the final numbers and claims
        hold up. Savings are counted per year once the action takes effect. The
        target is at least 8% of the approved FY2026 budget.
      </p>
      <div className="post-assessment-win-conditions">
        <strong>Win conditions</strong>
        <ul>
          <li>Your plan reaches at least 8%, using numbers you checked.</li>
          <li>Every saving says where its number comes from.</li>
          <li>Anything wrong in the chosen draft is fixed with evidence.</li>
          <li>
            You explain what your plan gives up and why you did not pick another
            plan.
          </li>
          <li>
            Submit the recorded activity report, answer sheet, and
            questionnaire. Task duration is recorded automatically.
          </li>
        </ul>
      </div>
    </div>
  );
}

function ExecutionSection({
  state,
  busy,
  onStart,
  onDownload,
  onChooseAnswerSheet,
  onSubmit,
}: {
  state: PostAssessmentState;
  busy: boolean;
  onStart: () => Promise<void>;
  onDownload: () => Promise<void>;
  onChooseAnswerSheet: () => Promise<string | null>;
  onSubmit: (questionnaire: ExecutionQuestionnaire) => Promise<void>;
}) {
  const complete = Boolean(state.sections.execution);
  const [questionnaire, setQuestionnaire] = useState(emptyQuestionnaire);
  const [outcomeFilename, setOutcomeFilename] = useState('');
  const [showConsent, setShowConsent] = useState(false);
  const [showReview, setShowReview] = useState(false);
  const [recorderBusy, setRecorderBusy] = useState(false);
  const [recorderError, setRecorderError] = useState('');
  const [captures, setCaptures] = useState<TaskRecorderCapture[]>([]);
  const [recorder, setRecorder] = useState<TaskRecorderState>({
    status: 'inactive',
    started_at: null,
    capture_count: 0,
    can_generate_log: false,
    last_error: null,
  });
  const startedAt = state.execution_started_at;

  const refreshRecorder = useCallback(async () => {
    if (!startedAt || complete) return;
    const next = (await invoke(
      'post-assessment-recorder-state',
      startedAt,
    )) as TaskRecorderState;
    setRecorder(next);
  }, [complete, startedAt]);

  useEffect(() => {
    if (!startedAt || complete) return undefined;
    refreshRecorder().catch((reason) =>
      setRecorderError(
        reason instanceof Error ? reason.message : String(reason),
      ),
    );
    const timer = window.setInterval(() => {
      refreshRecorder().catch(() => undefined);
    }, 10_000);
    return () => window.clearInterval(timer);
  }, [complete, refreshRecorder, startedAt]);

  const recorderAction = async (action: () => Promise<TaskRecorderState>) => {
    setRecorderBusy(true);
    setRecorderError('');
    try {
      setRecorder(await action());
    } catch (reason) {
      setRecorderError(
        reason instanceof Error ? reason.message : String(reason),
      );
    } finally {
      setRecorderBusy(false);
    }
  };

  const openReview = async () => {
    setRecorderBusy(true);
    setRecorderError('');
    try {
      const next = (await invoke(
        'post-assessment-recorder-captures',
      )) as TaskRecorderCapture[];
      setCaptures(next);
      setShowReview(true);
    } catch (reason) {
      setRecorderError(
        reason instanceof Error ? reason.message : String(reason),
      );
    } finally {
      setRecorderBusy(false);
    }
  };

  let executionStatus = '';
  if (startedAt) executionStatus = 'In progress';
  if (complete) executionStatus = '✓ Submitted';
  const ready =
    Boolean(outcomeFilename) &&
    recorder.can_generate_log &&
    questionnaire.ownership >= 1 &&
    EXECUTION_QUESTIONNAIRE_QUESTIONS.every(
      ({ key }) => questionnaire[key].trim().length > 0,
    );

  return (
    <section className="post-assessment-section">
      <div className="pre-assessment-challenge-header">
        <div>
          <h3>Financial Analysis Mission</h3>
          <p>
            In this task, we’ll give you a brand-new work challenge and see how
            you tackle it—how you make decisions, use AI, verify its work, and
            turn your process into a final submission.
          </p>
        </div>
        {executionStatus && (
          <span
            className={`pre-assessment-status pre-assessment-status--${complete ? 'done' : 'ready'}`}
          >
            {executionStatus}
          </span>
        )}
      </div>

      <MissionBriefing />

      <div className="post-assessment-toolkit">
        <div>
          <h4>Reference files</h4>
          <p>
            {state.toolkit_available
              ? 'Download and use these five files to complete the mission.'
              : 'The study team is preparing this toolkit. The download will become available here.'}
          </p>
        </div>
        <div className="post-assessment-toolkit-grid">
          <div className="post-assessment-toolkit-file">
            <span aria-hidden>↓</span>
            <div>
              <strong>Complete mission toolkit</strong>
              <small>
                Includes{' '}
                {POST_ASSESSMENT_TOOLKIT.map((file) => file.filename).join(
                  ', ',
                )}
              </small>
            </div>
            <button
              type="button"
              disabled={busy || !state.toolkit_available}
              onClick={onDownload}
            >
              {state.toolkit_available
                ? 'Download all toolkit files'
                : 'Toolkit is being prepared'}
            </button>
          </div>
        </div>
      </div>

      {complete && state.sections.execution && (
        <div className="post-assessment-submitted">
          <strong>Mission submitted</strong>
        </div>
      )}
      {!complete && !startedAt && (
        <div className="post-assessment-start">
          <div>
            <strong>Start when you are ready</strong>
            <span>
              Your task duration will be recorded automatically when you begin.
            </span>
          </div>
          <button
            type="button"
            disabled={busy}
            onClick={() => setShowConsent(true)}
          >
            Start task
          </button>
        </div>
      )}
      {showConsent && (
        <div className="post-assessment-modal-backdrop">
          <div
            className="post-assessment-consent"
            role="dialog"
            aria-modal="true"
            aria-labelledby="task-recording-consent-title"
          >
            <h4 id="task-recording-consent-title">
              Task activity will be recorded
            </h4>
            <p>
              For this task session, Coco will save a compressed screenshot
              about every 30 seconds, the active application name when
              available, your Coco conversations, and Coco’s activity notes to
              create your activity report.
            </p>
            <ul>
              <li>No raw keystrokes, microphone audio, or continuous video.</li>
              <li>You can pause recording and remove screenshots.</li>
              <li>
                The generated report is attached automatically and local
                captures are deleted after a successful submission.
              </li>
            </ul>
            <div className="post-assessment-consent-actions">
              <button
                type="button"
                disabled={busy}
                onClick={async () => {
                  setShowConsent(false);
                  if (startedAt) {
                    await recorderAction(
                      () =>
                        invoke(
                          'post-assessment-recorder-start',
                        ) as Promise<TaskRecorderState>,
                    );
                  } else {
                    await onStart();
                  }
                }}
              >
                {startedAt ? 'Start recording now' : 'Start task & recording'}
              </button>
              <button
                type="button"
                disabled={busy}
                onClick={() => setShowConsent(false)}
              >
                Cancel
              </button>
            </div>
          </div>
        </div>
      )}
      {!complete && startedAt && (
        <div className="post-assessment-submission">
          <div
            className={`post-assessment-recorder post-assessment-recorder--${recorder.status}`}
          >
            <div>
              <span
                className="post-assessment-recorder-indicator"
                aria-hidden
              />
              <div>
                <strong>
                  {recorder.status === 'recording' && 'Recording task activity'}
                  {recorder.status === 'paused' && 'Task recording paused'}
                  {recorder.status === 'declined' &&
                    'Task recording needs to be started'}
                  {recorder.status === 'unavailable' &&
                    'Task recording is unavailable'}
                  {recorder.status === 'inactive' && 'No task recording found'}
                </strong>
                <span>
                  {recorder.can_generate_log
                    ? `${recorder.capture_count} screenshot${recorder.capture_count === 1 ? '' : 's'} retained · an activity report will be attached automatically`
                    : 'Recording is required for this task. Start or retry it before submitting.'}
                </span>
                {(recorder.last_error || recorderError) && (
                  <small>{recorderError || recorder.last_error}</small>
                )}
              </div>
            </div>
            <div className="post-assessment-recorder-actions">
              {(recorder.status === 'inactive' ||
                recorder.status === 'declined' ||
                recorder.status === 'unavailable') && (
                <button
                  type="button"
                  disabled={busy || recorderBusy}
                  onClick={() => setShowConsent(true)}
                >
                  Start activity recording
                </button>
              )}
              {recorder.status === 'recording' && (
                <button
                  type="button"
                  disabled={busy || recorderBusy}
                  onClick={() =>
                    recorderAction(
                      () =>
                        invoke(
                          'post-assessment-recorder-pause',
                        ) as Promise<TaskRecorderState>,
                    )
                  }
                >
                  Pause
                </button>
              )}
              {recorder.status === 'paused' && (
                <button
                  type="button"
                  disabled={busy || recorderBusy}
                  onClick={() =>
                    recorderAction(
                      () =>
                        invoke(
                          'post-assessment-recorder-resume',
                        ) as Promise<TaskRecorderState>,
                    )
                  }
                >
                  Resume
                </button>
              )}
              {recorder.can_generate_log && (
                <button
                  type="button"
                  disabled={busy || recorderBusy}
                  onClick={openReview}
                >
                  Review captures
                </button>
              )}
            </div>
          </div>

          <div className="post-assessment-upload-grid">
            <div>
              <strong>Completed answer sheet</strong>
              <span>Export your completed answer sheet as a PDF.</span>
              <button
                type="button"
                disabled={busy}
                onClick={async () => {
                  const filename = await onChooseAnswerSheet();
                  if (filename) setOutcomeFilename(filename);
                }}
              >
                Choose answer sheet PDF
              </button>
              {outcomeFilename && <small>{outcomeFilename}</small>}
            </div>
          </div>

          {showReview && (
            <div className="post-assessment-modal-backdrop">
              <div
                className="post-assessment-capture-review"
                role="dialog"
                aria-modal="true"
                aria-labelledby="capture-review-title"
              >
                <div className="post-assessment-capture-review-header">
                  <div>
                    <h4 id="capture-review-title">Recorded screenshots</h4>
                    <p>
                      Remove anything unrelated or sensitive. Removed captures
                      are deleted locally and will not be submitted.
                    </p>
                  </div>
                  <button type="button" onClick={() => setShowReview(false)}>
                    Done
                  </button>
                </div>
                <div className="post-assessment-capture-grid">
                  {captures.length === 0 && <p>No screenshots retained yet.</p>}
                  {captures.map((capture) => (
                    <article key={capture.id}>
                      <img
                        src={capture.image_data_url}
                        alt={`Task activity captured ${new Date(capture.captured_at).toLocaleString()}`}
                      />
                      <div>
                        <strong>
                          {new Date(capture.captured_at).toLocaleString()}
                        </strong>
                        <span>
                          {capture.application || 'Application unavailable'}
                        </span>
                        <button
                          type="button"
                          disabled={recorderBusy}
                          onClick={async () => {
                            setRecorderBusy(true);
                            setRecorderError('');
                            try {
                              const next = (await invoke(
                                'post-assessment-recorder-remove-capture',
                                capture.id,
                              )) as TaskRecorderState;
                              setRecorder(next);
                              setCaptures((current) =>
                                current.filter(
                                  (item) => item.id !== capture.id,
                                ),
                              );
                            } catch (reason) {
                              setRecorderError(
                                reason instanceof Error
                                  ? reason.message
                                  : String(reason),
                              );
                            } finally {
                              setRecorderBusy(false);
                            }
                          }}
                        >
                          Remove
                        </button>
                      </div>
                    </article>
                  ))}
                </div>
              </div>
            </div>
          )}

          <div className="post-assessment-questionnaire">
            <h4>Tell us about your approach</h4>
            {EXECUTION_QUESTIONNAIRE_QUESTIONS.map(
              ({ key, question }, index) => (
                <label key={key} htmlFor={`execution-${key}`}>
                  <strong>
                    {index + 1}. {question}
                  </strong>
                  <textarea
                    id={`execution-${key}`}
                    rows={4}
                    maxLength={5000}
                    value={questionnaire[key]}
                    disabled={busy}
                    onChange={(event) =>
                      setQuestionnaire((current) => ({
                        ...current,
                        [key]: event.target.value,
                      }))
                    }
                  />
                </label>
              ),
            )}
            <fieldset>
              <legend>
                6. To what extent do you feel the final work is your own?
              </legend>
              <div className="post-assessment-ownership-scale">
                {Array.from({ length: 10 }, (_, index) => index + 1).map(
                  (value) => (
                    <label key={value} htmlFor={`ownership-${value}`}>
                      <input
                        id={`ownership-${value}`}
                        type="radio"
                        name="ownership"
                        value={value}
                        checked={questionnaire.ownership === value}
                        disabled={busy}
                        onChange={() =>
                          setQuestionnaire((current) => ({
                            ...current,
                            ownership: value,
                          }))
                        }
                      />
                      <span>{value}</span>
                    </label>
                  ),
                )}
              </div>
              <div className="post-assessment-scale-labels">
                <span>1 · Not at all</span>
                <span>10 · Completely</span>
              </div>
            </fieldset>
          </div>

          <div className="post-assessment-final-submit">
            <div>
              <strong>Submission checklist</strong>
              <span>
                Recorded activity report · answer sheet PDF · questionnaire
              </span>
            </div>
            <button
              type="button"
              disabled={busy || !ready}
              onClick={async () => onSubmit(questionnaire)}
            >
              {busy ? 'Submitting files…' : 'Submit execution task'}
            </button>
          </div>
        </div>
      )}
    </section>
  );
}

export default function PostAssessmentPanel({
  unlocked,
}: {
  unlocked: boolean;
}) {
  const [state, setState] = useState<PostAssessmentState | null>(null);
  const [activeSection, setActiveSection] =
    useState<PostAssessmentSection>('self_efficacy');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [notice, setNotice] = useState('');

  const load = useCallback(async () => {
    const raw = (await invoke(
      'post-assessment-state',
    )) as Partial<PostAssessmentState>;
    if (!raw || typeof raw !== 'object' || !raw.sections)
      throw new Error(
        'The study server returned invalid post-assessment progress.',
      );
    const next = raw as PostAssessmentState;
    setState(next);
  }, []);

  useEffect(() => {
    if (!unlocked) return;
    load().catch((reason) =>
      setError(reason instanceof Error ? reason.message : String(reason)),
    );
  }, [load, unlocked]);

  const act = async (action: () => Promise<unknown>) => {
    setBusy(true);
    setError('');
    setNotice('');
    try {
      await action();
      await load();
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : String(reason));
    } finally {
      setBusy(false);
    }
  };

  const completedCount = useMemo(() => {
    if (!state?.sections) return 0;
    return Object.values(state.sections).filter(Boolean).length;
  }, [state]);
  if (!unlocked || state?.unlocked === false) {
    return (
      <section className="training-card post-assessment post-assessment--locked">
        <div className="post-assessment-lock-icon" aria-hidden>
          🔒
        </div>
        <div>
          <h2>Post-assessment</h2>
          <p>
            Complete all seven training levels to unlock the self-assessment, AI
            literacy test, and final execution task.
          </p>
        </div>
      </section>
    );
  }

  if (!state) {
    return (
      <section className="training-card post-assessment post-assessment--locked">
        <div className="post-assessment-lock-icon" aria-hidden>
          {error ? '!' : '…'}
        </div>
        <div>
          <h2>Post-assessment</h2>
          <p role={error ? 'alert' : undefined}>
            {error || 'Loading your post-assessment…'}
          </p>
          {error && (
            <button type="button" disabled={busy} onClick={load}>
              Retry
            </button>
          )}
        </div>
      </section>
    );
  }

  return (
    <section
      className={`training-card post-assessment${state?.complete ? ' post-assessment--complete' : ''}`}
      aria-labelledby="post-assessment-title"
    >
      <div className="post-assessment-intro">
        <div>
          <h2 id="post-assessment-title">
            {state?.complete
              ? 'Post-assessment complete!'
              : 'Complete your post-assessment'}
          </h2>
          <p>
            Finish all three parts. Your responses and files are submitted
            securely to the study team.
          </p>
        </div>
        <div
          className="pre-assessment-progress"
          role="progressbar"
          aria-label="Post-assessment progress"
          aria-valuemin={0}
          aria-valuemax={3}
          aria-valuenow={completedCount}
        >
          <strong>{completedCount}/3</strong>
          <span>submitted</span>
        </div>
      </div>
      {error && (
        <p className="training-error" role="alert">
          {error}
        </p>
      )}
      {notice && (
        <p className="training-notice" role="status">
          {notice}
        </p>
      )}
      {state && (
        <>
          <div
            className="pre-assessment-tabs post-assessment-tabs"
            role="tablist"
            aria-label="Post-assessment sections"
          >
            {(
              [
                ['self_efficacy', 'Self-assessment'],
                ['ai_literacy', 'AI literacy'],
                ['execution', 'Execution task'],
              ] as const
            ).map(([section, label], index) => (
              <button
                key={section}
                type="button"
                role="tab"
                aria-selected={activeSection === section}
                onClick={() => setActiveSection(section)}
              >
                <span>{state.sections[section] ? '✓' : index + 1}</span>
                {label}
              </button>
            ))}
          </div>
          <div role="tabpanel">
            {activeSection === 'self_efficacy' && (
              <SelfEfficacySection
                complete={Boolean(state.sections.self_efficacy)}
                busy={busy}
                onSubmit={(answers) =>
                  act(() =>
                    invoke('post-assessment-submit-self-efficacy', answers),
                  )
                }
              />
            )}
            {activeSection === 'ai_literacy' && (
              <AiLiteracySection
                complete={Boolean(state.sections.ai_literacy)}
                busy={busy}
                onSubmit={(answers) =>
                  act(() =>
                    invoke('post-assessment-submit-ai-literacy', answers),
                  )
                }
              />
            )}
            {activeSection === 'execution' && (
              <ExecutionSection
                state={state}
                busy={busy}
                onStart={() =>
                  act(() => invoke('post-assessment-start-execution'))
                }
                onDownload={async () => {
                  setBusy(true);
                  setError('');
                  try {
                    const result = (await invoke(
                      'post-assessment-download-toolkit',
                    )) as { success?: boolean; canceled?: boolean };
                    if (result.success) setNotice('Toolkit file saved.');
                  } catch (reason) {
                    setError(
                      reason instanceof Error ? reason.message : String(reason),
                    );
                  } finally {
                    setBusy(false);
                  }
                }}
                onChooseAnswerSheet={async () => {
                  setBusy(true);
                  setError('');
                  try {
                    const result = (await invoke(
                      'post-assessment-select-execution-files',
                      'outcome',
                    )) as { canceled?: boolean; filenames?: string[] };
                    return result.canceled
                      ? null
                      : (result.filenames?.[0] ?? null);
                  } catch (reason) {
                    setError(
                      reason instanceof Error ? reason.message : String(reason),
                    );
                    return null;
                  } finally {
                    setBusy(false);
                  }
                }}
                onSubmit={(questionnaire) =>
                  act(() =>
                    invoke('post-assessment-submit-execution', questionnaire),
                  )
                }
              />
            )}
          </div>
        </>
      )}
    </section>
  );
}
