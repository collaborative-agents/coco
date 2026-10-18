export type PostAssessmentSection =
  | 'self_efficacy'
  | 'ai_literacy'
  | 'execution';

export interface SelfEfficacyAnswers {
  [questionId: string]: number;
}

export interface AiLiteracyAnswers {
  [questionId: string]: string;
}

export interface ExecutionQuestionnaire {
  decision: string;
  reasoning: string;
  aiUse: string;
  alternatives: string;
  challenge: string;
  ownership: number;
}

export type TaskRecorderStatus =
  | 'inactive'
  | 'recording'
  | 'paused'
  | 'declined'
  | 'unavailable';

export interface TaskRecorderState {
  status: TaskRecorderStatus;
  started_at: string | null;
  capture_count: number;
  can_generate_log: boolean;
  last_error: string | null;
}

export interface TaskRecorderCapture {
  id: string;
  captured_at: string;
  application: string | null;
  source_name: string;
  image_data_url: string;
}

export interface PostAssessmentSectionResult {
  completed_at: string;
  score?: number;
  max_score?: number;
}

export interface ExecutionAssessmentResult extends PostAssessmentSectionResult {
  started_at: string;
  duration_seconds: number;
  outcome_filename: string;
  interaction_log_filenames: string[];
}

export interface PostAssessmentState {
  unlocked: boolean;
  complete: boolean;
  toolkit_available: boolean;
  toolkit_filename: string | null;
  sections: {
    self_efficacy: PostAssessmentSectionResult | null;
    ai_literacy: PostAssessmentSectionResult | null;
    execution: ExecutionAssessmentResult | null;
  };
  execution_started_at: string | null;
}

export interface ChoiceQuestion {
  id: number;
  question: string;
  options: { id: string; text: string }[];
}

export const SELF_EFFICACY_QUESTIONS = [
  'I am confident I can use AI tools to help me complete work tasks.',
  'I believe I can figure out how to use AI tools even when I run into problems.',
  'I feel capable of using AI tools to produce high-quality results for my work.',
  'I am certain I could learn what I need to know to use AI tools effectively in my job.',
] as const;

export const SELF_EFFICACY_SCALE = [
  { value: 1, label: 'Strongly disagree' },
  { value: 2, label: 'Disagree' },
  { value: 3, label: 'Neither agree nor disagree' },
  { value: 4, label: 'Agree' },
  { value: 5, label: 'Strongly agree' },
] as const;

export const AI_LITERACY_QUESTIONS: ChoiceQuestion[] = [
  {
    id: 1,
    question:
      'You ask an AI tool to explain a topic you know little about. The answer is detailed, well-written, and confident. Which statement is MOST accurate?',
    options: [
      {
        id: 'A',
        text: 'A detailed answer is usually more accurate than a short answer.',
      },
      {
        id: 'B',
        text: 'A confident writing style does not necessarily mean the information is correct.',
      },
      {
        id: 'C',
        text: 'AI tools only give confident answers when they have enough information.',
      },
      {
        id: 'D',
        text: 'If the explanation is easy to understand, it is probably accurate.',
      },
    ],
  },
  {
    id: 2,
    question:
      'You want AI to compare several options for purchasing new equipment for your business. Which information would be MOST useful to provide?',
    options: [
      {
        id: 'A',
        text: 'The decision criteria that matter to you, such as budget, reliability, and maintenance cost.',
      },
      { id: 'B', text: 'Your full personal history.' },
      {
        id: 'C',
        text: 'Examples of unrelated equipment you purchased in the past.',
      },
      {
        id: 'D',
        text: 'Nothing—AI works best when it decides what information is relevant.',
      },
    ],
  },
  {
    id: 3,
    question:
      'You upload a document containing customer names, phone numbers, and payment information to an AI tool. What is the MOST important thing to consider first?',
    options: [
      {
        id: 'A',
        text: 'Whether the document is long enough for the AI to analyze.',
      },
      {
        id: 'B',
        text: 'Whether the AI can make the document look more professional.',
      },
      {
        id: 'C',
        text: 'Whether sharing that information with the tool is appropriate and consistent with privacy requirements.',
      },
      {
        id: 'D',
        text: 'Whether the AI can analyze multiple customers at once.',
      },
    ],
  },
  {
    id: 4,
    question:
      'AI creates a good first draft of a project plan, but it assumes you have three employees available when you actually have only one. What is the BEST response?',
    options: [
      {
        id: 'A',
        text: 'Use the plan anyway because AI-generated plans are meant to be approximate.',
      },
      {
        id: 'B',
        text: 'Give the AI the missing constraint and ask it to revise the plan.',
      },
      { id: 'C', text: 'Ask the AI to make the plan sound more confident.' },
      {
        id: 'D',
        text: 'Start over without AI because the first answer contained a mistake.',
      },
    ],
  },
  {
    id: 5,
    question:
      'You need to understand a 40-page report quickly. Which approach makes the BEST use of AI?',
    options: [
      {
        id: 'A',
        text: "Ask AI for the report's main points and use those as a starting point for deciding what sections you need to inspect more closely.",
      },
      {
        id: 'B',
        text: 'Ask AI for a summary and assume anything it leaves out is unimportant.',
      },
      { id: 'C', text: 'Avoid AI because it cannot work with long documents.' },
      {
        id: 'D',
        text: 'Ask AI to rewrite all 40 pages before reading anything.',
      },
    ],
  },
  {
    id: 6,
    question:
      'An AI assistant asks for additional information before completing your request. What does this MOST likely mean?',
    options: [
      { id: 'A', text: 'The AI is malfunctioning.' },
      {
        id: 'B',
        text: 'Your request may be underspecified, and additional context could help it produce a more useful result.',
      },
      { id: 'C', text: 'AI should never ask users questions.' },
      { id: 'D', text: 'The task cannot be completed with AI.' },
    ],
  },
  {
    id: 7,
    question:
      "You're opening a café and ask an AI chatbot for your state's minimum wage so you can set staff pay. It gives a specific number. What is the best next step?",
    options: [
      {
        id: 'A',
        text: 'Use the number, since minimum wage is public information.',
      },
      {
        id: 'B',
        text: "Check your state labor department's website, since AI’s result can be outdated.",
      },
      {
        id: 'C',
        text: 'Add a dollar to the number in case it is slightly low.',
      },
      {
        id: 'D',
        text: 'Ask the chatbot again and use the number if it matches.',
      },
    ],
  },
  {
    id: 8,
    question:
      'A receptionist answers the same few questions by email every day (hours, parking, pricing). What would most improve her efficiency?',
    options: [
      {
        id: 'A',
        text: 'Answer the emails only once a week, all at the same time.',
      },
      {
        id: 'B',
        text: 'Have an AI tool reply to every email automatically, without review.',
      },
      {
        id: 'C',
        text: 'Write each reply from scratch to keep the replies personal.',
      },
      {
        id: 'D',
        text: 'Use AI to draft reply templates she can quickly personalize.',
      },
    ],
  },
];

export const EXECUTION_QUESTIONNAIRE_QUESTIONS = [
  {
    key: 'decision',
    question:
      'Could you briefly explain the decision you presented in your final report?',
  },
  {
    key: 'reasoning',
    question: 'Could you briefly explain why you made that decision?',
  },
  {
    key: 'aiUse',
    question:
      'Which parts did you use AI for, and which parts did you do on your own?',
  },
  {
    key: 'alternatives',
    question:
      'Did you consider any other options? If so, briefly explain why you did not choose them.',
  },
  {
    key: 'challenge',
    question: 'What was the most challenging part of the task?',
  },
] as const;

export const POST_ASSESSMENT_TOOLKIT = [
  { id: 'draft_plans', filename: 'draft_plans.docx', label: 'AI draft plans' },
  { id: 'budget', filename: 'budget.xlsx', label: 'Approved FY2026 budget' },
  { id: 'contracts', filename: 'contracts.pdf', label: 'Vendor contracts' },
  {
    id: 'team_notes',
    filename: 'team_notes.docx',
    label: 'Department head notes',
  },
  {
    id: 'answer_template',
    filename: 'answer_template.docx',
    label: 'Answer template',
  },
] as const;
