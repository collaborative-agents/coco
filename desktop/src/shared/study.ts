export interface TrainingDay {
  day: number;
  title: string;
  available: boolean;
  filename: string | null;
  unlocked: boolean;
  unlocks_at: string | null;
  completed_at: string | null;
}
export interface StudyState {
  user_id: string;
  role: 'super_admin' | 'admin' | 'participant';
  tutoring_allowed: boolean;
  pre_assessments_complete: boolean;
  post_assessment_complete?: boolean;
  post_assessment_toolkit_available?: boolean;
  started_at: string | null;
  timezone: string | null;
  days: TrainingDay[];
}

export interface DailyReflection {
  q1: number;
  q2: number;
  q3: number;
  q4: number;
  q5: number;
  q6: string;
  q7: string;
  q8: string;
}

export const DAILY_REFLECTION_RATING_QUESTIONS = [
  'The tasks I worked on in today\u2019s session were relevant to work I actually do or want to do.',
  'I found today\u2019s session useful for improving my ability to work with AI tools.',
  'I felt engaged and motivated during today\u2019s session.',
  'After today\u2019s session, I feel more confident using AI tools for real work tasks.',
  'I would recommend this type of training to someone else in a similar situation to mine.',
] as const;

export const DAILY_REFLECTION_OPEN_QUESTIONS = [
  'What was the most useful or interesting thing you worked on today? Why?',
  'Was there anything in today\u2019s session where you felt confused, stuck, or frustrated? Describe what happened.',
  'Is there anything you wish had been different about today\u2019s session \u2014 or anything you\u2019d like more of next time?',
] as const;
