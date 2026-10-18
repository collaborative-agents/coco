/* eslint react/require-default-props: ["error", { "functions": "defaultArguments" }] */
import { useCallback, useEffect, useState } from 'react';
import type { StudyState } from '../../shared/study';
import PreAssessmentPanel from './PreAssessmentPanel';
import PostAssessmentPanel from './PostAssessmentPanel';
import DailyReflectionForm from './training/DailyReflectionForm';
import TrainingDialog from './training/TrainingDialog';
import TrainingAnnouncement from './training/TrainingAnnouncement';
import TrainingTaskDetail from './training/TrainingTaskDetail';
import TrainingTodo from './training/TrainingTodo';
import TrainingTaskGroup from './training/TrainingTaskGroup';
import TrainingProgress from './training/TrainingProgress';
import { api } from './training/training-api';
import useTrainingState from './training/useTrainingState';
import './TrainingView.css';

export default function TrainingView({
  visible = true,
  refreshKey = 0,
}: {
  visible?: boolean;
  refreshKey?: number;
}) {
  const { state, studentMode, error, setError, refresh } = useTrainingState(
    visible,
    refreshKey,
  );
  const [notice, setNotice] = useState('');
  const [busy, setBusy] = useState(false);
  const [preAssessmentComplete, setPreAssessmentComplete] = useState(false);
  const [active, setActive] = useState<'pre' | 'post' | number | null>(null);
  const [reflectionDayNumber, setReflectionDayNumber] = useState<number | null>(
    null,
  );
  const handlePreAssessmentCompletion = useCallback((complete: boolean) => {
    setPreAssessmentComplete(complete);
  }, []);
  const act = useCallback(
    async (action: () => Promise<unknown>) => {
      setBusy(true);
      setError('');
      setNotice('');
      try {
        await action();
        await refresh();
      } catch (reason) {
        setError(reason instanceof Error ? reason.message : String(reason));
      } finally {
        setBusy(false);
      }
    },
    [refresh, setError],
  );
  const studentExperience = state?.role === 'participant' || studentMode;
  const adminMode =
    (state?.role === 'admin' || state?.role === 'super_admin') && !studentMode;
  const trainingUnlocked = !studentExperience || preAssessmentComplete;
  const trainingComplete = Boolean(
    state?.days.length === 7 && state.days.every((day) => day.completed_at),
  );
  const postAssessmentUnlocked = adminMode || trainingComplete;
  const orderedDays = [...(state?.days ?? [])].sort((a, b) => a.day - b.day);
  const nextDay = orderedDays.find((day) => !day.completed_at);
  const visibleDays = orderedDays.filter(
    (day) => adminMode || day.completed_at || day.day === nextDay?.day,
  );
  const selectedDay = state?.days.find((day) => day.day === active);
  const reflectionDay = state?.days.find(
    (day) => day.day === reflectionDayNumber,
  );
  const dayCanOpen = (day: StudyState['days'][number]) =>
    Boolean(day.completed_at) ||
    (trainingUnlocked &&
      day.available &&
      (day.unlocked || (!state?.started_at && day.day === 1)));
  useEffect(() => {
    if (
      typeof active === 'number' &&
      (!selectedDay ||
        (!selectedDay.completed_at &&
          (!trainingUnlocked ||
            !selectedDay.available ||
            (!selectedDay.unlocked &&
              (state?.started_at || selectedDay.day !== 1)))))
    ) {
      setActive(null);
      setReflectionDayNumber(null);
    }
    if (active === 'post' && !postAssessmentUnlocked) setActive(null);
  }, [
    active,
    selectedDay,
    trainingUnlocked,
    state?.started_at,
    postAssessmentUnlocked,
  ]);
  return (
    <main className="training-page">
      <div
        className="training-home"
        inert={active !== null || reflectionDayNumber !== null}
      >
        <header className="training-header">
          <h1>AI Literacy Challenge</h1>
          <p>
            Coco helps you get work done faster—and work more thoughtfully with
            AI. Build your skills, discover new possibilities, and strengthen
            your own thinking.
          </p>
          <p>
            During the three-week AI Literacy Camp, you’ll try a new AI
            collaboration task each day in the first week. Assessments on Days
            0, 7, and 21, with feedback from Coco, help you track your progress.
          </p>
        </header>
        {state && (
          <>
            <TrainingAnnouncement />
            <TrainingProgress days={state.days} />
          </>
        )}
        {error && (
          <div role="alert" className="training-error">
            {/fetch failed|network|timed? ?out|abort/i.test(error)
              ? 'Unable to connect to the study server. Please check your connection and retry.'
              : error}
            <button type="button" onClick={() => act(refresh)}>
              Retry
            </button>
          </div>
        )}
        {notice && (
          <p role="status" className="training-notice">
            {notice}
          </p>
        )}
        {!state ? (
          <p>
            {error ? 'Training could not be loaded.' : 'Loading your training…'}
          </p>
        ) : (
          <>
            {state.role !== 'participant' && (
              <div className="training-toolbar">
                <button
                  type="button"
                  aria-pressed={studentMode}
                  disabled={busy}
                  onClick={() =>
                    act(() => api('study-student-mode', !studentMode))
                  }
                >
                  {studentMode ? 'Exit student mode' : 'Student mode'}
                </button>
              </div>
            )}
            {!state.tutoring_allowed && (
              <p className="training-info">
                AI tutoring is disabled for your account. Your available
                assessments and tasks are still accessible.
              </p>
            )}
            <ol className="training-todos" aria-label="Practice checklist">
              <TrainingTodo
                title="Starting assessment"
                complete={preAssessmentComplete}
                onClick={() => setActive('pre')}
              />
              <TrainingTaskGroup>
                {visibleDays.map((day) => (
                  <TrainingTodo
                    key={day.day}
                    title={`Day ${day.day} Practice task`}
                    complete={Boolean(day.completed_at)}
                    disabled={!dayCanOpen(day)}
                    onClick={() => setActive(day.day)}
                  />
                ))}
              </TrainingTaskGroup>
              {postAssessmentUnlocked && (
                <TrainingTodo
                  title="Final assessment"
                  complete={state.post_assessment_complete}
                  disabled={!postAssessmentUnlocked}
                  onClick={() => setActive('post')}
                />
              )}
            </ol>
          </>
        )}
      </div>
      {state && (
        <>
          <TrainingDialog
            open={active === 'pre'}
            title="Starting assessment"
            onClose={() => setActive(null)}
          >
            <PreAssessmentPanel
              required={studentExperience}
              onCompletionChange={handlePreAssessmentCompletion}
            />
          </TrainingDialog>
          <TrainingDialog
            open={active === 'post'}
            title="Final assessment"
            onClose={() => setActive(null)}
          >
            <PostAssessmentPanel unlocked={postAssessmentUnlocked} />
          </TrainingDialog>
          {selectedDay && dayCanOpen(selectedDay) && (
            <TrainingDialog
              open={reflectionDayNumber === null}
              title={`Day ${selectedDay.day} Practice task`}
              onClose={() => setActive(null)}
              busy={busy}
            >
              {!state.started_at && !selectedDay.completed_at ? (
                <section>
                  <p>
                    Your practice days will use{' '}
                    {Intl.DateTimeFormat().resolvedOptions().timeZone}. This
                    cannot be changed after starting.
                  </p>
                  <button
                    className="training-primary"
                    type="button"
                    disabled={busy}
                    onClick={() =>
                      act(() =>
                        api(
                          'study-start',
                          Intl.DateTimeFormat().resolvedOptions().timeZone,
                        ),
                      )
                    }
                  >
                    Start Day 1
                  </button>
                </section>
              ) : (
                <TrainingTaskDetail
                  day={selectedDay}
                  busy={busy}
                  onReflect={() => setReflectionDayNumber(selectedDay.day)}
                />
              )}
              {error && (
                <p role="alert" className="training-error">
                  {error}
                </p>
              )}
            </TrainingDialog>
          )}
          {reflectionDay &&
            !reflectionDay.completed_at &&
            dayCanOpen(reflectionDay) && (
              <DailyReflectionForm
                day={reflectionDay.day}
                busy={busy}
                error={error}
                onClose={() => setReflectionDayNumber(null)}
                onSubmit={async (answers) => {
                  let completed = false;
                  await act(async () => {
                    const result = (await api(
                      'study-complete',
                      reflectionDay.day,
                      state.user_id,
                      answers,
                    )) as { canceled?: boolean };
                    if (!result.canceled) {
                      completed = true;
                      setNotice(
                        `Day ${reflectionDay.day} complete — reflection and screenshot saved locally.`,
                      );
                    }
                  });
                  if (completed) {
                    setReflectionDayNumber(null);
                    setActive(null);
                  }
                }}
              />
            )}
        </>
      )}
    </main>
  );
}
