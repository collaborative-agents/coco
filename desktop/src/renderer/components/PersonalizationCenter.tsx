import { useCallback, useEffect, useMemo, useRef, useState } from 'react';

import sleepImage from '../../../assets/sleep1.png';
import trainingAnimation from '../../../assets/training.gif';
import { AnimatedCocoGif } from './CocoGifControls';
import useProvisionalDiscovery from './useProvisionalDiscovery';
import './PersonalizationCenter.css';

export interface PersonalizationStatusInfo {
  available: boolean;
  sleeping: boolean;
  successfulUpdateCount: number;
  state:
    | 'idle'
    | 'running'
    | 'checkpointed'
    | 'completed'
    | 'no_work'
    | 'preempted'
    | 'failed';
  activeJob?: 'signals' | 'revise' | 'evolve';
  activeStartedAt?: number;
  checkpointStatus?: string;
  preparation?: {
    completedSteps: number;
    totalSteps: number;
    totalObservations: number;
    remainingObservations: number;
    estimatedSecondsRemaining?: number;
  };
  processedSamples?: number;
  totalSamples?: number;
  periodStart?: number;
  periodEnd?: number;
  signals?: {
    signalCount: number;
    observationCount: number;
    feedbackEventCount: number;
    updatedAt?: number;
  };
  lastRun?: {
    job: 'signals' | 'revise' | 'evolve';
    outcome: 'completed' | 'no_work' | 'preempted' | 'failed';
    endedAt: number;
    detail?: string;
  };
  nextEvolveAttemptAt?: number;
  dailyRun?: {
    scheduledHour: number;
    lastStartedDate?: string;
    lastCompletedDate?: string;
    lastOutcome?: 'completed' | 'no_work';
    lastCompletedAt?: number;
  };
}

type ReviewDecision = 'keep' | 'reject' | 'edit';

interface DraftBullet {
  id: string;
  section: string;
  content: string;
  confidence: number;
  examples: string[];
}

interface CenterSnapshot {
  provisional: Array<{
    id: string;
    section: string;
    content: string;
    helpful: number;
    harmful: number;
    updatedAt?: number;
  }>;
  activity: Array<{
    id: string;
    kind: 'batch' | 'skipped' | 'epoch';
    title: string;
    detail: string;
  }>;
  review: {
    draft: {
      draftId: string;
      createdAt: number;
      periodStart?: number;
      periodEnd: number;
      summary: string;
      bullets: DraftBullet[];
    };
    decisions: Record<
      string,
      {
        decision: ReviewDecision;
        editedContent?: string;
        decidedAt: number;
      }
    >;
  } | null;
  history: Array<{
    draftId: string;
    approvedAt: number;
    periodEnd: number;
  }>;
}

interface CenterResponse {
  status: PersonalizationStatusInfo;
  center: CenterSnapshot | null;
}

const SECTION_TITLES: Record<string, string> = {
  when_to_support: 'When to proactively support',
  when_to_stay_silent: 'When to stay silent',
  how_to_support: 'How to support',
  tool_preferences: 'Tool preferences',
  recurring_tasks: 'Recurring tasks',
  general: 'General notes',
};

const JOB_LABELS = {
  signals: 'Collecting personalization signals',
  revise: 'Revising feedback labels',
  evolve: 'Self-evolving prompt',
} as const;

type MilestoneState = 'waiting' | 'current' | 'done';
type PersonalizationCocoState = 'sleeping' | 'training' | 'waiting';

function milestoneState(done: boolean, current: boolean): MilestoneState {
  if (done) return 'done';
  if (current) return 'current';
  return 'waiting';
}

function PersonalizationCoco({
  state,
  size,
}: {
  state: PersonalizationCocoState;
  size: number;
}) {
  if (state === 'waiting') {
    return (
      <span className="personalization-waiting-coco">
        <AnimatedCocoGif id="waiting" size={size} frameIntervalMs={700} />
      </span>
    );
  }
  if (state === 'training') {
    return (
      <img
        className="personalization-coco personalization-coco--training"
        src={trainingAnimation}
        alt="Coco training"
        draggable={false}
      />
    );
  }
  return (
    <img
      className="personalization-coco personalization-coco--sleeping"
      src={sleepImage}
      alt="Coco sleeping"
      draggable={false}
    />
  );
}

function formatTime(timestamp: number, seconds = false): string {
  return new Date(seconds ? timestamp * 1000 : timestamp).toLocaleString();
}

function statusTitle(status: PersonalizationStatusInfo | null): string {
  if (!status?.available) return 'Personalization is not ready';
  if (status.state === 'running') {
    if (status.checkpointStatus === 'preparing') {
      return 'Preparing the learning run';
    }
    if (status.checkpointStatus === 'complete') {
      return 'Finishing the learning update';
    }
    return status.activeJob
      ? JOB_LABELS[status.activeJob]
      : 'Personalization is running';
  }
  if (status.state === 'checkpointed') return 'Learning is safely checkpointed';
  if (status.state === 'failed') return 'Personalization needs attention';
  if (status.state === 'preempted') return 'Paused for interactive work';
  if (status.state === 'completed') return 'Latest learning run completed';
  if (status.state === 'no_work') return 'No new activity to learn from yet';
  return status.sleeping
    ? 'Ready to learn while Coco sleeps'
    : 'Waiting for idle time';
}

function progressOf(status: PersonalizationStatusInfo | null) {
  const total = status?.totalSamples ?? 0;
  const processed = Math.min(status?.processedSamples ?? 0, total);
  return {
    total,
    processed,
    percent: total > 0 ? Math.round((processed / total) * 100) : 0,
  };
}

function preparationTimeLabel(
  status: PersonalizationStatusInfo | null,
): string {
  if (status?.checkpointStatus !== 'preparing') return '';
  const seconds = status.preparation?.estimatedSecondsRemaining;
  if (seconds === undefined) return 'Estimating time remaining…';
  if (seconds < 60) return 'Less than a minute remaining';
  const minutes = Math.max(1, Math.ceil(seconds / 60));
  if (minutes < 90) return `About ${minutes} min remaining`;
  const hours = Math.round((minutes / 60) * 2) / 2;
  return `About ${hours} ${hours === 1 ? 'hour' : 'hours'} remaining`;
}

function decisionLabel(decision?: ReviewDecision): string {
  if (decision === 'keep') return 'Kept';
  if (decision === 'edit') return 'Edited';
  if (decision === 'reject') return 'Rejected';
  return 'Not reviewed';
}

function localDateKey(date: Date): string {
  const year = date.getFullYear();
  const month = String(date.getMonth() + 1).padStart(2, '0');
  const day = String(date.getDate()).padStart(2, '0');
  return `${year}-${month}-${day}`;
}

function dailyStatus(
  status: PersonalizationStatusInfo,
  now = new Date(),
): string {
  const daily = status.dailyRun;
  if (!daily) return 'Coco checks for a new update every day.';
  const today = localDateKey(now);
  if (daily.lastCompletedDate === today) {
    const completedTime = daily.lastCompletedAt
      ? new Date(daily.lastCompletedAt).toLocaleTimeString([], {
          hour: 'numeric',
          minute: '2-digit',
        })
      : '';
    if (daily.lastOutcome === 'no_work') {
      return `Checked today${completedTime ? ` at ${completedTime}` : ''} — no new activity to learn from.`;
    }
    return `Latest growth completed today${completedTime ? ` at ${completedTime}` : ''}.`;
  }
  if (daily.lastStartedDate === today) {
    return status.state === 'running'
      ? 'Coco is growing now.'
      : 'Today’s update has started.';
  }
  const scheduledTime = new Date(now);
  scheduledTime.setHours(daily.scheduledHour, 0, 0, 0);
  const schedule = scheduledTime.toLocaleTimeString([], {
    hour: 'numeric',
    minute: '2-digit',
  });
  return now < scheduledTime
    ? `Next daily growth check is at ${schedule}.`
    : `Today’s growth check has not run yet (scheduled for ${schedule}).`;
}

function detailedStatusTitle(status: PersonalizationStatusInfo | null): string {
  if (!status?.available) return 'Personalization is not ready';
  if (status.state === 'running') {
    if (status.checkpointStatus === 'preparing') {
      return 'Preparing the learning run';
    }
    if (status.checkpointStatus === 'complete') {
      return 'Finishing the learning update';
    }
    const label = status.activeJob
      ? JOB_LABELS[status.activeJob]
      : 'Personalization';
    return `${label} is running`;
  }
  if (status.state === 'checkpointed') {
    return 'Self-evolving prompt is checkpointed';
  }
  if (status.state === 'completed') return 'Self-evolving prompt completed';
  if (status.state === 'no_work') return 'No eligible personalization work yet';
  if (status.state === 'preempted') {
    return 'Personalization paused for interactive work';
  }
  if (status.state === 'failed') return 'Personalization needs attention';
  return status.sleeping
    ? 'Coco is ready for personalization work'
    : 'Personalization is waiting for idle time';
}

/** Detailed status card retained as a reusable public component. */
export function PersonalizationStatusPanel({
  status,
  loading,
  onExpand,
  readyCount,
  waitingForReview,
}: {
  status: PersonalizationStatusInfo | null;
  loading: boolean;
  onExpand: () => void;
  readyCount: number;
  waitingForReview: boolean;
}) {
  const progress = progressOf(status);
  const colorClass = status?.state ?? 'idle';
  let cocoState: PersonalizationCocoState = 'sleeping';
  if (status?.state === 'running' || status?.state === 'checkpointed') {
    cocoState = 'training';
  } else if (status?.state === 'completed' && waitingForReview) {
    cocoState = 'waiting';
  }
  return (
    <section
      className="personalization-status-card"
      aria-label="Personalization status"
    >
      <div className="personalization-status-card__header">
        <span
          className={`personalization-status-dot personalization-status-dot--${colorClass}`}
        />
        <strong>
          {loading ? 'Checking personalization…' : detailedStatusTitle(status)}
        </strong>
        <button
          type="button"
          className="personalization-status-expand"
          onClick={onExpand}
          aria-label="Expand Personalization"
          title={
            readyCount > 0
              ? `Expand Personalization · ${readyCount} ready to review`
              : 'Expand Personalization'
          }
        >
          <span aria-hidden>⤢</span>
          {readyCount > 0 && (
            <i className="personalization-status-expand__notice" />
          )}
        </button>
      </div>
      {status && (
        <div className="personalization-growth">
          <PersonalizationCoco state={cocoState} size={72} />
          <div>
            <strong>Coco’s growth</strong>
            <b>
              {status.successfulUpdateCount}{' '}
              {status.successfulUpdateCount === 1
                ? 'successful update'
                : 'successful updates'}
            </b>
            <span>{dailyStatus(status)}</span>
          </div>
        </div>
      )}
      {status?.checkpointStatus !== 'preparing' && progress.total > 0 && (
        <>
          <div className="personalization-status-meta">
            {progress.processed} of {progress.total} samples processed ·{' '}
            {progress.percent}%
          </div>
          <div
            className="personalization-progress"
            role="progressbar"
            aria-label="Self-evolving prompt progress"
            aria-valuemin={0}
            aria-valuemax={100}
            aria-valuenow={progress.percent}
          >
            <span style={{ width: `${progress.percent}%` }} />
          </div>
        </>
      )}
      {status?.checkpointStatus === 'preparing' && (
        <div className="personalization-status-meta">
          {preparationTimeLabel(status)}
        </div>
      )}
      {status?.checkpointStatus && (
        <div className="personalization-status-meta">
          Checkpoint: {status.checkpointStatus}
        </div>
      )}
      {status?.periodStart && status.periodEnd && (
        <div className="personalization-status-meta">
          Data period: {formatTime(status.periodStart, true)} –{' '}
          {formatTime(status.periodEnd, true)}
        </div>
      )}
      {status?.signals && (
        <div className="personalization-status-meta">
          {status.signals.signalCount} signals from{' '}
          {status.signals.observationCount} observations and{' '}
          {status.signals.feedbackEventCount} feedback events
        </div>
      )}
      {status?.lastRun && (
        <div className="personalization-status-meta">
          Last job: {JOB_LABELS[status.lastRun.job]} ·{' '}
          {status.lastRun.outcome.replace('_', ' ')} ·{' '}
          {formatTime(status.lastRun.endedAt)}
        </div>
      )}
      {status?.nextEvolveAttemptAt && status.state !== 'running' && (
        <div className="personalization-status-meta">
          Next eligible retry: {formatTime(status.nextEvolveAttemptAt)}
        </div>
      )}
    </section>
  );
}

export function PersonalizationSettingsCard({
  onOpen,
}: {
  onOpen: () => void;
}) {
  const [status, setStatus] = useState<PersonalizationStatusInfo | null>(null);
  const [readyCount, setReadyCount] = useState(0);
  const [waitingForReview, setWaitingForReview] = useState(false);
  const [loading, setLoading] = useState(true);

  const refresh = useCallback(async () => {
    try {
      const response = (await window.electron?.ipcRenderer.invoke(
        'get-personalization-center',
      )) as CenterResponse | undefined;
      setStatus(response?.status ?? null);
      setWaitingForReview(Boolean(response?.center?.review));
      setReadyCount(
        response?.center?.review?.draft.bullets.filter(
          (bullet) => !response.center?.review?.decisions[bullet.id],
        ).length ?? 0,
      );
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    refresh();
    const timer = window.setInterval(() => refresh(), 2000);
    return () => window.clearInterval(timer);
  }, [refresh]);

  return (
    <div className="personalization-settings-entry">
      <PersonalizationStatusPanel
        status={status}
        loading={loading}
        onExpand={onOpen}
        readyCount={readyCount}
        waitingForReview={waitingForReview}
      />
    </div>
  );
}

export default function PersonalizationCenter({
  onBack,
}: {
  onBack: () => void;
}) {
  const [response, setResponse] = useState<CenterResponse | null>(null);
  const [error, setError] = useState('');
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [editing, setEditing] = useState(false);
  const [editText, setEditText] = useState('');
  const [saving, setSaving] = useState(false);
  const [applied, setApplied] = useState(false);
  const [celebrating, setCelebrating] = useState(false);
  const previousRunState = useRef<
    PersonalizationStatusInfo['state'] | undefined
  >(undefined);

  const refresh = useCallback(async () => {
    try {
      const result = (await window.electron?.ipcRenderer.invoke(
        'get-personalization-center',
      )) as CenterResponse | undefined;
      if (!result) throw new Error('No personalization status was returned.');
      setResponse(result);
      setError('');
    } catch (refreshError) {
      setError(
        refreshError instanceof Error
          ? refreshError.message
          : String(refreshError),
      );
    }
  }, []);

  useEffect(() => {
    refresh();
    const timer = window.setInterval(() => refresh(), 2000);
    return () => {
      window.clearInterval(timer);
    };
  }, [refresh]);

  const review = response?.center?.review ?? null;
  const bullets = useMemo(() => review?.draft.bullets ?? [], [review]);
  const decisions = useMemo(() => review?.decisions ?? {}, [review]);
  const reviewedCount = bullets.filter((bullet) => decisions[bullet.id]).length;
  const allReviewed = bullets.length > 0 && reviewedCount === bullets.length;
  const provisional = response?.center?.provisional ?? [];
  const {
    visiblePreference: discoveredPreference,
    expanded: discoveryExpanded,
    toggleExpanded: toggleDiscoveryExpanded,
  } = useProvisionalDiscovery(response ? provisional : undefined, {
    active:
      response?.status.checkpointStatus !== 'finalizing' &&
      response?.status.checkpointStatus !== 'preparing' &&
      response?.status.checkpointStatus !== 'complete' &&
      (response?.status.state === 'running' ||
        response?.status.state === 'checkpointed'),
  });

  useEffect(() => {
    if (bullets.length === 0) {
      setSelectedId(null);
      return;
    }
    if (selectedId && bullets.some((bullet) => bullet.id === selectedId))
      return;
    setSelectedId(
      bullets.find((bullet) => !decisions[bullet.id])?.id ?? bullets[0].id,
    );
  }, [bullets, decisions, selectedId]);

  const selected = bullets.find((bullet) => bullet.id === selectedId) ?? null;
  const selectedDecision = selected
    ? decisions[selected.id]?.decision
    : undefined;
  const progress = progressOf(response?.status ?? null);
  const runStatus = response?.status;
  const runCompleted = runStatus?.state === 'completed';
  const preparing = runStatus?.checkpointStatus === 'preparing';
  const observationsToProcess = preparing
    ? (runStatus?.preparation?.remainingObservations ?? 0)
    : Math.max(0, progress.total - progress.processed);
  const finalizing =
    runStatus?.checkpointStatus === 'finalizing' ||
    (runStatus?.state === 'running' &&
      runStatus?.checkpointStatus === 'complete');
  const stageMilestones: Array<{
    label: string;
    state: MilestoneState;
  }> = [
    {
      label: 'Collect',
      state: milestoneState(
        Boolean(
          !preparing &&
            (runStatus?.signals ||
              runStatus?.activeJob === 'revise' ||
              runStatus?.activeJob === 'evolve' ||
              runCompleted),
        ),
        preparing || runStatus?.activeJob === 'signals',
      ),
    },
    {
      label: 'Check',
      state: milestoneState(
        Boolean(
          !preparing &&
            (runStatus?.activeJob === 'evolve' || finalizing || runCompleted),
        ),
        !preparing && runStatus?.activeJob === 'revise',
      ),
    },
    {
      label: 'Learn',
      state: milestoneState(
        Boolean(finalizing || runCompleted),
        !preparing &&
          (runStatus?.activeJob === 'evolve' ||
            runStatus?.state === 'checkpointed'),
      ),
    },
    {
      label: 'Summarize',
      state: milestoneState(Boolean(review || runCompleted), finalizing),
    },
    {
      label: 'Review',
      state: milestoneState(applied, Boolean(review)),
    },
  ];
  const currentMilestone = stageMilestones.find(
    (milestone) => milestone.state === 'current',
  );
  let milestoneMessage = 'Waiting to begin';
  if (currentMilestone) milestoneMessage = currentMilestone.label;
  else if (applied) milestoneMessage = 'Preferences applied';
  else if (runCompleted) milestoneMessage = 'Learning complete';
  const activity = preparing ? [] : (response?.center?.activity ?? []);
  let cocoState: PersonalizationCocoState = 'sleeping';
  if (runStatus?.state === 'running' || runStatus?.state === 'checkpointed') {
    cocoState = 'training';
  } else if (runCompleted && !applied) {
    cocoState = 'waiting';
  }
  let progressDescription = 'Coco checkpoints its work so it can pause safely.';
  if (preparing) {
    progressDescription = `Scanning recent activity before learning begins. ${preparationTimeLabel(runStatus ?? null)}`;
  } else if (progress.total > 0) {
    progressDescription = `${progress.processed} of ${progress.total} moments processed`;
  }
  let progressLabel = '';
  if (preparing) progressLabel = 'Preparing';
  else if (progress.total > 0) progressLabel = `${progress.percent}%`;
  const progressStyle = preparing
    ? undefined
    : { width: `${progress.percent}%` };

  useEffect(() => {
    const nextState = response?.status.state;
    const previousState = previousRunState.current;
    let timer: number | undefined;
    if (
      nextState === 'completed' &&
      previousState !== undefined &&
      previousState !== 'completed'
    ) {
      setCelebrating(true);
      timer = window.setTimeout(() => setCelebrating(false), 4800);
    } else if (nextState === 'running') {
      setCelebrating(false);
    }
    previousRunState.current = nextState;
    return () => {
      if (timer !== undefined) window.clearTimeout(timer);
    };
  }, [response?.status.state]);

  let applyLabel = `${bullets.length - reviewedCount} left to review`;
  if (allReviewed) applyLabel = 'Apply choices';
  if (saving) applyLabel = 'Saving…';

  const saveDecision = async (
    bullet: DraftBullet,
    decision: ReviewDecision,
    editedContent?: string,
  ) => {
    if (!review || saving) return;
    setSaving(true);
    setError('');
    try {
      const result = (await window.electron?.ipcRenderer.invoke(
        'save-personalization-review-decision',
        {
          draftId: review.draft.draftId,
          bulletId: bullet.id,
          decision,
          editedContent,
        },
      )) as
        | { success?: boolean; center?: CenterSnapshot; error?: string }
        | undefined;
      if (!result?.success || !result.center) {
        throw new Error(
          result?.error || 'The review decision could not be saved.',
        );
      }
      setResponse(
        (current) => current && { ...current, center: result.center! },
      );
      const next = bullets.find(
        (item) =>
          item.id !== bullet.id && !result.center?.review?.decisions[item.id],
      );
      if (next) setSelectedId(next.id);
      setEditing(false);
    } catch (saveError) {
      setError(
        saveError instanceof Error ? saveError.message : String(saveError),
      );
    } finally {
      setSaving(false);
    }
  };

  const applyReview = async () => {
    if (!review || !allReviewed || saving) return;
    setSaving(true);
    setError('');
    try {
      const result = (await window.electron?.ipcRenderer.invoke(
        'apply-personalization-review',
        { draftId: review.draft.draftId },
      )) as { success?: boolean; error?: string } | undefined;
      if (!result?.success)
        throw new Error(result?.error || 'Update could not be applied.');
      setApplied(true);
      await refresh();
    } catch (applyError) {
      setError(
        applyError instanceof Error ? applyError.message : String(applyError),
      );
    } finally {
      setSaving(false);
    }
  };

  return (
    <main
      className="personalization-center"
      aria-label="Personalization Center"
    >
      {celebrating && (
        <div className="personalization-fireworks" aria-hidden="true">
          {Array.from({ length: 45 }, (_, index) => (
            <i key={index} />
          ))}
        </div>
      )}
      <header className="personalization-center__header">
        <div>
          <h1>Personalization</h1>
          <p>See what Coco is learning and review updates</p>
        </div>
      </header>

      {error && (
        <div className="personalization-error" role="alert">
          {error}
        </div>
      )}

      <div className="personalization-center__body">
        <section
          className={`personalization-overview personalization-overview--${runStatus?.state ?? 'idle'}`}
        >
          <div className="personalization-run-summary">
            <div
              key={discoveredPreference?.id ?? cocoState}
              className={`personalization-run-animation${discoveredPreference ? ' personalization-run-animation--discovered' : ''}`}
            >
              <PersonalizationCoco state={cocoState} size={68} />
            </div>
            <div>
              <span className="personalization-kicker">Current run</span>
              <h2 aria-live="polite">{statusTitle(runStatus ?? null)}</h2>
              <p>{progressDescription}</p>
            </div>
            <div className="personalization-milestone-status">
              <div aria-label={`Current stage: ${milestoneMessage}`}>
                {stageMilestones.map((milestone) => (
                  <span
                    key={milestone.label}
                    className={`personalization-milestone personalization-milestone--${milestone.state}`}
                    aria-label={`${milestone.label}: ${milestone.state}`}
                    title={`${milestone.label}: ${milestone.state}`}
                  />
                ))}
              </div>
              <strong>{milestoneMessage}</strong>
            </div>
          </div>
          <div className="personalization-progress-row">
            <div
              className={`personalization-progress personalization-progress--large${preparing ? ' personalization-progress--indeterminate' : ''}`}
              role="progressbar"
              aria-label="Personalization run progress"
              aria-valuemin={0}
              aria-valuemax={100}
              aria-valuenow={preparing ? undefined : progress.percent}
              aria-valuetext={preparing ? 'Preparing current run' : undefined}
            >
              <span style={progressStyle} />
            </div>
            <strong>{progressLabel}</strong>
          </div>
          {discoveredPreference && (
            <div
              className={`personalization-discovery${discoveryExpanded ? ' personalization-discovery--expanded' : ''}`}
              aria-live="polite"
            >
              <button
                type="button"
                className="personalization-discovery__summary"
                aria-expanded={discoveryExpanded}
                aria-label={`${discoveryExpanded ? 'Hide' : 'Show'} details for learned preference`}
                onClick={toggleDiscoveryExpanded}
              >
                <span className="personalization-discovery__icon" aria-hidden>
                  ✦
                </span>
                <span className="personalization-discovery__copy">
                  <span className="personalization-kicker">Just learned</span>
                  <strong>{discoveredPreference.content}</strong>
                  <small>
                    {SECTION_TITLES[discoveredPreference.section] ??
                      discoveredPreference.section.replaceAll('_', ' ')}
                    {' · '}Still learning, not active yet
                  </small>
                </span>
                <span
                  className="personalization-discovery__chevron"
                  aria-hidden
                >
                  ⌄
                </span>
              </button>
              {discoveryExpanded && (
                <div className="personalization-discovery__details">
                  <strong>What this means</strong>
                  <p>
                    Coco inferred this from recent activity. It remains
                    provisional and will not affect Coco’s behavior unless it
                    reaches the Review Queue and you approve it.
                  </p>
                </div>
              )}
            </div>
          )}
          <div className="personalization-live-activity">
            <div className="personalization-live-activity__heading">
              <span className="personalization-kicker">Activity</span>
              <strong>
                {activity.length > 0
                  ? 'Recent checkpoints'
                  : 'Waiting for a checkpoint'}
              </strong>
            </div>
            {activity.length > 0 ? (
              <div className="personalization-live-activity__items">
                {activity.slice(0, 3).map((item) => (
                  <article key={item.id}>
                    <span
                      className={`activity-dot activity-dot--${item.kind}`}
                    />
                    <div>
                      <strong>{item.title}</strong>
                      <p>{item.detail}</p>
                    </div>
                  </article>
                ))}
              </div>
            ) : (
              <p className="personalization-live-activity__empty">
                New checkpoints will appear here as Coco learns.
              </p>
            )}
          </div>
          <div className="personalization-stats">
            <span>
              <strong>{observationsToProcess}</strong>{' '}
              {observationsToProcess === 1 ? 'observation' : 'observations'} to
              process
            </span>
          </div>
        </section>

        <div className="personalization-columns">
          <section className="personalization-panel personalization-review-panel">
            <div className="personalization-panel__heading">
              <div>
                <span className="personalization-kicker">Review queue</span>
                <h2>
                  {review
                    ? `${reviewedCount} of ${bullets.length} reviewed`
                    : 'Nothing waiting'}
                </h2>
              </div>
              {review && (
                <span className="personalization-saved">
                  Decisions save automatically
                </span>
              )}
            </div>

            {selected && review ? (
              <>
                <div
                  className="personalization-review-list"
                  aria-label="Preferences to review"
                >
                  {bullets.map((bullet, index) => (
                    <button
                      type="button"
                      key={bullet.id}
                      className={bullet.id === selected.id ? 'selected' : ''}
                      onClick={() => {
                        setSelectedId(bullet.id);
                        setEditing(false);
                      }}
                    >
                      <span>{index + 1}</span>
                      <strong>
                        {decisionLabel(decisions[bullet.id]?.decision)}
                      </strong>
                    </button>
                  ))}
                </div>
                <article className="personalization-review-card">
                  <span className="personalization-section-label">
                    {SECTION_TITLES[selected.section] ??
                      selected.section.replaceAll('_', ' ')}
                  </span>
                  {editing ? (
                    <textarea
                      aria-label="Edit learned preference"
                      value={editText}
                      onChange={(event) => setEditText(event.target.value)}
                    />
                  ) : (
                    <p>
                      {decisions[selected.id]?.editedContent ??
                        selected.content}
                    </p>
                  )}
                  {selected.examples.length > 0 && !editing && (
                    <details>
                      <summary>
                        Why Coco learned this · {selected.examples.length}{' '}
                        {selected.examples.length === 1
                          ? 'example'
                          : 'examples'}
                      </summary>
                      <ul>
                        {selected.examples.map((example) => (
                          <li key={example}>{example}</li>
                        ))}
                      </ul>
                    </details>
                  )}
                  <div className="personalization-review-actions">
                    {editing ? (
                      <>
                        <button
                          type="button"
                          className="secondary"
                          onClick={() => setEditing(false)}
                        >
                          Cancel
                        </button>
                        <button
                          type="button"
                          className="primary"
                          disabled={!editText.trim() || saving}
                          onClick={() =>
                            saveDecision(selected, 'edit', editText)
                          }
                        >
                          Save edit
                        </button>
                      </>
                    ) : (
                      <>
                        <button
                          type="button"
                          className={`keep${selectedDecision === 'keep' ? ' selected' : ''}`}
                          aria-pressed={selectedDecision === 'keep'}
                          disabled={saving}
                          onClick={() => saveDecision(selected, 'keep')}
                        >
                          ✓ Keep
                        </button>
                        <button
                          type="button"
                          className={`secondary edit${selectedDecision === 'edit' ? ' selected' : ''}`}
                          aria-pressed={selectedDecision === 'edit'}
                          disabled={saving}
                          onClick={() => {
                            setEditText(
                              decisions[selected.id]?.editedContent ??
                                selected.content,
                            );
                            setEditing(true);
                          }}
                        >
                          Edit
                        </button>
                        <button
                          type="button"
                          className={`reject${selectedDecision === 'reject' ? ' selected' : ''}`}
                          aria-pressed={selectedDecision === 'reject'}
                          disabled={saving}
                          onClick={() => saveDecision(selected, 'reject')}
                        >
                          Reject
                        </button>
                      </>
                    )}
                  </div>
                </article>
                <div className="personalization-review-footer">
                  <button type="button" className="secondary" onClick={onBack}>
                    Finish later
                  </button>
                  <button
                    type="button"
                    className="primary"
                    disabled={!allReviewed || saving}
                    onClick={() => applyReview()}
                  >
                    {applyLabel}
                  </button>
                </div>
              </>
            ) : (
              <div className="personalization-empty">
                {applied
                  ? 'Your reviewed preferences are now active.'
                  : 'A completed learning update will appear here when it is ready.'}
              </div>
            )}
          </section>

          {(response?.center?.history.length ?? 0) > 0 && (
            <section className="personalization-panel personalization-history">
              <span className="personalization-kicker">History</span>
              <p>
                Last applied{' '}
                {formatTime(response!.center!.history[0].approvedAt, true)} ·
                data through{' '}
                {formatTime(response!.center!.history[0].periodEnd, true)}
              </p>
            </section>
          )}
        </div>
      </div>
    </main>
  );
}
