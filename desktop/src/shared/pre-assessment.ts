export type PreAssessmentSet = 'A' | 'E';

export interface SetAQuestion {
  id: number;
  question: string;
  options: { id: string; text: string }[];
  correctAnswer: string;
  rationale: string;
}

export const SET_A_QUESTIONS: SetAQuestion[] = [
  {
    id: 1,
    question: 'What does it mean when an AI language model “hallucinates”?',
    options: [
      { id: 'A', text: 'The AI generates colorful or creative visual content' },
      {
        id: 'B',
        text: 'The AI produces text that sounds confident but is factually wrong or made up',
      },
      { id: 'C', text: 'The AI refuses to answer and gives a blank response' },
      { id: 'D', text: 'The AI repeats the same answer over and over' },
    ],
    correctAnswer: 'B',
    rationale:
      'Hallucinations are plausible-sounding but factually wrong or fabricated outputs.',
  },
  {
    id: 2,
    question:
      'Which of the following is the BEST example of a specific, effective AI prompt for a business task?',
    options: [
      { id: 'A', text: '“Help me with my business.”' },
      { id: 'B', text: '“Write something for my website.”' },
      {
        id: 'C',
        text: '“Write a 2-sentence welcome message for my bakery’s homepage. Use a warm and friendly tone. We have been open since 2015.”',
      },
      { id: 'D', text: '“Make some good content please.”' },
    ],
    correctAnswer: 'C',
    rationale:
      'It specifies the audience, format, length, tone, and a key fact.',
  },
  {
    id: 3,
    question:
      'You ask an AI tool to look up the latest pricing for a competitor’s product. What is the most important limitation to keep in mind?',
    options: [
      { id: 'A', text: 'AI can only search one website at a time' },
      {
        id: 'B',
        text: 'AI may not have access to up-to-date information, so the pricing could be outdated',
      },
      { id: 'C', text: 'AI is better at writing than at searching' },
      { id: 'D', text: 'AI cannot read numbers or prices' },
    ],
    correctAnswer: 'B',
    rationale:
      'An AI may lack current web access, so time-sensitive information needs verification.',
  },
  {
    id: 4,
    question:
      'You receive an AI-generated summary of a contract. It looks polished and professional. What should you do BEFORE sharing it with a client?',
    options: [
      { id: 'A', text: 'Share it immediately since it looks accurate' },
      { id: 'B', text: 'Make minor formatting edits only' },
      {
        id: 'C',
        text: 'Verify the key facts against the original contract to check for errors',
      },
      { id: 'D', text: 'Ask the AI to rewrite it one more time to be safe' },
    ],
    correctAnswer: 'C',
    rationale:
      'Key facts should be checked against the original source before the summary is used.',
  },
  {
    id: 5,
    question:
      'Which of the following tasks is MOST appropriate to delegate to an AI tool?',
    options: [
      { id: 'A', text: 'Deciding whether to let an employee go' },
      { id: 'B', text: 'Signing a legal agreement on your behalf' },
      {
        id: 'C',
        text: 'Drafting a first version of a proposal letter to a potential client',
      },
      {
        id: 'D',
        text: 'Making a final judgment call about a customer dispute',
      },
    ],
    correctAnswer: 'C',
    rationale:
      'A first draft is appropriate generation support; the other choices require human judgment or authority.',
  },
  {
    id: 6,
    question:
      'Which of the following best describes what “prompting” means when using AI?',
    options: [
      { id: 'A', text: 'Paying for access to an AI platform' },
      {
        id: 'B',
        text: 'Writing clear and specific instructions so the AI understands what you need',
      },
      {
        id: 'C',
        text: 'Copying and pasting AI-generated output into a document',
      },
      { id: 'D', text: 'Programming the AI using computer code' },
    ],
    correctAnswer: 'B',
    rationale:
      'Prompting means giving the AI clear instructions and relevant context.',
  },
  {
    id: 7,
    question:
      'A colleague used AI to research local permit requirements for a small business. The AI gave a detailed, confident-sounding answer. What is the most responsible next step?',
    options: [
      {
        id: 'A',
        text: 'Trust the answer since it sounded authoritative and detailed',
      },
      { id: 'B', text: 'Ask the AI the same question again to double-check' },
      {
        id: 'C',
        text: 'Verify the information using an official government or legal source',
      },
      { id: 'D', text: 'Assume the information is wrong without checking' },
    ],
    correctAnswer: 'C',
    rationale:
      'Regulatory and legal facts should be checked with an authoritative source.',
  },
  {
    id: 8,
    question:
      'You are using AI to help write a business email. After the AI gives you a draft, you notice it sounds generic and doesn’t match your voice. What is the BEST next step?',
    options: [
      { id: 'A', text: 'Send it as-is since AI output is always professional' },
      { id: 'B', text: 'Delete it and write the email entirely from scratch' },
      {
        id: 'C',
        text: 'Give the AI more specific instructions about your tone and key details, then ask it to try again',
      },
      { id: 'D', text: 'Ask a friend to rewrite it instead' },
    ],
    correctAnswer: 'C',
    rationale:
      'Specific feedback and iterative refinement are the best way to improve an AI draft.',
  },
];

export const SET_E_AI_RESPONSE = `To hire a part-time employee in your state, you will need to: (1) Obtain an Employer Identification Number (EIN) from the IRS, which is free and can be done online. (2) Register with your state's labor department for payroll tax withholding. (3) Have the employee complete a Form I-9 to verify work eligibility and a W-4 for federal tax withholding. (4) Pay at least the federal minimum wage of $7.25 per hour, unless your state has a higher minimum wage — which many states do. (5) Part-time employees are not entitled to benefits such as health insurance under federal law, though some states have additional requirements. (6) You are required to post certain federal and state labor law notices in your workplace. Keep records of all hours worked.`;

export const SET_E_QUESTIONS = [
  {
    id: 'e1',
    question:
      'Before using this AI response to guide your hiring decisions, what would you specifically need to check or verify? List at least 3 things and explain why each matters.',
  },
  {
    id: 'e2',
    question:
      'How would you verify this information? Name at least one specific source you would consult.',
  },
  {
    id: 'e3',
    question:
      'Are there any parts of the AI response that seem particularly risky to act on without verification? Why?',
  },
] as const;

export interface SetAAnswers {
  [questionId: string]: string;
}

export interface SetEAnswers {
  e1: string;
  e2: string;
  e3: string;
}

export interface PreAssessmentResult {
  set: PreAssessmentSet;
  score: number;
  maxScore: number;
  completedAt: string;
  answers: SetAAnswers | SetEAnswers;
}

export interface PreAssessmentState {
  complete: boolean;
  sets: {
    A: PreAssessmentResult | null;
    E: PreAssessmentResult | null;
  };
}

export const SET_E_MODEL_ANSWER = [
  'Check the rules for the participant’s specific state and locality; hiring, payroll, notices, and other requirements vary by jurisdiction.',
  'Verify the current federal, state, and local minimum wages before setting pay.',
  'Check whether benefit and health-insurance rules change based on state law, employer size, hours worked, or another threshold.',
  'Use current, authoritative sources such as IRS.gov, DOL.gov, the state labor department, or a qualified employment attorney.',
];
