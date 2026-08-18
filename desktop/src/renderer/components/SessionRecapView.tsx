import { useEffect, useState } from 'react';

interface RecapData {
  summary_title: string;
  bullets: string[];
  quiz: {
    question: string;
    choices: string[];
    correct_index: number;
    explanation: string;
  };
}

type QuizState = 'unanswered' | 'correct' | 'wrong';

export default function SessionRecapView() {
  const [recap, setRecap] = useState<RecapData | null>(null);
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState(false);
  const [selectedIndex, setSelectedIndex] = useState<number | null>(null);
  const [quizState, setQuizState] = useState<QuizState>('unanswered');

  useEffect(() => {
    const cleanupInit = window.electron?.ipcRenderer.on(
      'session-recap-init',
      () => setLoading(true),
    );
    const cleanupData = window.electron?.ipcRenderer.on(
      'session-recap-data',
      (payload: any) => {
        setLoading(false);
        if (payload?.error || !payload?.data) {
          setLoadError(true);
        } else {
          setRecap(payload.data as RecapData);
        }
      },
    );
    return () => {
      if (typeof cleanupInit === 'function') cleanupInit();
      if (typeof cleanupData === 'function') cleanupData();
    };
  }, []);

  const finish = () => {
    const quizAnswered = quizState !== 'unanswered';
    window.electron?.ipcRenderer.sendMessage('session-recap-done', {
      quizSkipped: !quizAnswered,
      quizAnswered,
      ...(quizAnswered ? { quizCorrect: quizState === 'correct' } : {}),
      ...(selectedIndex !== null ? { selectedIndex } : {}),
    });
    window.close();
  };
  const answered = quizState !== 'unanswered';

  return (
    <div className="recap-root">
      <div className="recap-card">
        <div className="recap-header">
          <span className="recap-header-dot" />
          <span className="recap-header-title">Session recap</span>
          <button
            type="button"
            className="recap-close"
            onClick={finish}
            aria-label="Skip recap"
          >
            ×
          </button>
        </div>

        {loading && (
          <div className="recap-loading">
            <div className="recap-spinner" aria-label="Loading recap" />
            <p className="recap-loading-text">Putting together your recap…</p>
          </div>
        )}

        {!loading && loadError && (
          <div className="recap-error">
            <p>Couldn&apos;t load the recap right now.</p>
            <button
              type="button"
              className="recap-btn-continue"
              onClick={finish}
            >
              End session
            </button>
          </div>
        )}

        {!loading && !loadError && recap && (
          <div className="recap-body">
            <div className="recap-summary">
              <div className="recap-section-label">
                <span className="recap-section-icon">✦</span>
                Today&apos;s session
              </div>
              <p className="recap-summary-title">{recap.summary_title}</p>
              <ul className="recap-bullets">
                {recap.bullets.map((bullet, index) => (
                  <li key={index} className="recap-bullet">
                    <span className="recap-bullet-dot" />
                    <span>{bullet}</span>
                  </li>
                ))}
              </ul>
            </div>

            <div className="recap-quiz">
              <div className="recap-section-label">
                <span className="recap-section-icon">?</span>
                Quick check
              </div>
              <p className="recap-question">{recap.quiz.question}</p>
              <div className="recap-choices">
                {recap.quiz.choices.map((choice, index) => {
                  let className = 'recap-choice';
                  if (answered) {
                    if (index === recap.quiz.correct_index)
                      className += ' recap-choice--correct';
                    else if (index === selectedIndex)
                      className += ' recap-choice--wrong';
                    else className += ' recap-choice--dimmed';
                  }
                  return (
                    <button
                      key={index}
                      type="button"
                      className={className}
                      disabled={answered}
                      onClick={() => {
                        setSelectedIndex(index);
                        setQuizState(
                          index === recap.quiz.correct_index
                            ? 'correct'
                            : 'wrong',
                        );
                      }}
                    >
                      <span className="recap-choice-letter">
                        {String.fromCharCode(65 + index)}
                      </span>
                      <span className="recap-choice-text">{choice}</span>
                    </button>
                  );
                })}
              </div>

              {quizState === 'correct' && (
                <div className="recap-feedback recap-feedback--correct">
                  <span className="recap-feedback-icon">✓</span>
                  <span>
                    <strong>Exactly right!</strong> {recap.quiz.explanation}
                  </span>
                </div>
              )}
              {quizState === 'wrong' && (
                <div className="recap-feedback recap-feedback--wrong">
                  <span className="recap-feedback-icon">!</span>
                  <span>
                    <strong>Not quite.</strong> {recap.quiz.explanation}
                  </span>
                </div>
              )}
            </div>
          </div>
        )}

        {!loading && !loadError && (
          <div className="recap-actions">
            <button type="button" className="recap-btn-skip" onClick={finish}>
              Skip
            </button>
            <button
              type="button"
              className="recap-btn-continue"
              onClick={finish}
              disabled={!answered}
            >
              End session
            </button>
          </div>
        )}
      </div>
    </div>
  );
}
