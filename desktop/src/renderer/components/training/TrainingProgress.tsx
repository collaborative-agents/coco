import trainingAnimation from '../../../../assets/training.gif';
import type { TrainingDay } from '../../../shared/study';
import './TrainingProgress.css';

export default function TrainingProgress({ days }: { days: TrainingDay[] }) {
  const completed = days.filter((day) => day.completed_at).length;
  const total = days.length;
  const percent = total ? Math.round((completed / total) * 100) : 0;
  return (
    <section className="training-progress" aria-label="Learning progress">
      <div className="training-progress-header">
        <div className="training-progress-avatar-lane">
          <img
            className="training-progress-avatar"
            src={trainingAnimation}
            alt=""
            draggable={false}
            style={{
              left: `clamp(var(--progress-avatar-half), ${percent}%, calc(100% - var(--progress-avatar-half)))`,
            }}
          />
        </div>
        <div className="training-progress-label">
          <span>Learning progress</span>
          <span>
            {completed}/{total}
          </span>
        </div>
      </div>
      <div className="training-progress-path">
        <div
          className="training-progress-track"
          role="progressbar"
          aria-label="Learning progress"
          aria-valuemin={0}
          aria-valuemax={100}
          aria-valuenow={percent}
          aria-valuetext={`${completed} of ${total} tasks complete`}
        >
          <span
            className="training-progress-fill"
            style={{ width: `${percent}%` }}
          />
        </div>
      </div>
    </section>
  );
}
