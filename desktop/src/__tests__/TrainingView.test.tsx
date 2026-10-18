import React from 'react';
import '@testing-library/jest-dom';
import {
  render,
  screen,
  fireEvent,
  waitFor,
  within,
} from '@testing-library/react';
import TrainingView from '../renderer/components/TrainingView';
import type { StudyState } from '../shared/study';
import type { PreAssessmentState } from '../shared/pre-assessment';
import type {
  PostAssessmentState,
  TaskRecorderState,
} from '../shared/post-assessment';

let me: StudyState;
let invoke: jest.Mock;
let assessments: PreAssessmentState;
let studentMode: boolean;
let postAssessment: PostAssessmentState;
let taskRecorderState: TaskRecorderState;
const completedAssessments = (): PreAssessmentState => ({
  complete: true,
  sets: {
    A: {
      set: 'A',
      score: 8,
      maxScore: 8,
      completedAt: '2026-09-23T00:00:00Z',
      answers: {},
    },
    E: {
      set: 'E',
      score: 4,
      maxScore: 4,
      completedAt: '2026-09-23T00:00:00Z',
      answers: { e1: 'answer', e2: 'source', e3: 'risk' },
    },
  },
});
beforeEach(() => {
  me = {
    user_id: 'alice',
    role: 'participant',
    tutoring_allowed: false,
    pre_assessments_complete: false,
    started_at: '2026-09-24T00:00:00Z',
    timezone: 'Asia/Tokyo',
    days: Array.from({ length: 7 }, (_, index) => ({
      day: index + 1,
      title: `Task ${index + 1}`,
      available: true,
      filename: 'task.pdf',
      unlocked: index === 0,
      unlocks_at: null,
      completed_at: null,
    })),
  };
  assessments = { complete: false, sets: { A: null, E: null } };
  studentMode = false;
  postAssessment = {
    unlocked: false,
    complete: false,
    toolkit_available: true,
    toolkit_filename: 'post-assessment-toolkit.zip',
    sections: {
      self_efficacy: null,
      ai_literacy: null,
      execution: null,
    },
    execution_started_at: null,
  };
  taskRecorderState = {
    status: 'inactive',
    started_at: null,
    capture_count: 0,
    can_generate_log: false,
    last_error: null,
  };
  invoke = jest.fn(async (channel, ...args) => {
    if (channel === 'study-me') return me;
    if (channel === 'study-task-submission') return null;
    if (channel === 'study-task-materials')
      return {
        documents: [
          {
            id: 'instructions.md',
            name: 'instructions.md',
            kind: 'markdown',
            content: '# Your first task\nTry one useful prompt.',
          },
        ],
        files: [
          { id: 'instructions.md', name: 'instructions.md', size: 50 },
          {
            id: 'references/example.csv',
            name: 'references/example.csv',
            size: 20,
          },
        ],
      };
    if (channel === 'pre-assessment-state') return assessments;
    if (channel === 'pre-assessment-submit') {
      const set = args[0] as 'A' | 'E';
      const result = {
        set,
        score: set === 'A' ? 2 : 1,
        maxScore: set === 'A' ? 8 : 4,
        completedAt: '2026-09-23T00:00:00Z',
        answers: args[1] as Record<string, string>,
      };
      assessments.sets[set] = result;
      assessments.complete = Boolean(assessments.sets.A && assessments.sets.E);
      return result;
    }
    if (channel === 'study-student-mode') {
      const [enabled] = args;
      if (typeof enabled === 'boolean') studentMode = enabled;
      return {
        available: me.role !== 'participant',
        enabled: studentMode,
      };
    }
    if (channel === 'post-assessment-state') return postAssessment;
    if (channel === 'post-assessment-start-execution') {
      postAssessment.execution_started_at = '2026-10-07T12:00:00Z';
      taskRecorderState = {
        status: 'recording',
        started_at: postAssessment.execution_started_at,
        capture_count: 1,
        can_generate_log: true,
        last_error: null,
      };
      return postAssessment;
    }
    if (channel === 'post-assessment-recorder-start') {
      taskRecorderState = {
        status: 'recording',
        started_at: postAssessment.execution_started_at,
        capture_count: 1,
        can_generate_log: true,
        last_error: null,
      };
      return taskRecorderState;
    }
    if (channel === 'post-assessment-recorder-state') return taskRecorderState;
    return { success: true };
  });
  Object.defineProperty(window, 'electron', {
    configurable: true,
    value: {
      ipcRenderer: { invoke },
      webUtils: { getPathForFile: jest.fn(() => '/chosen/file') },
    },
  });
  jest.spyOn(window, 'confirm').mockReturnValue(true);
});
afterEach(() => jest.restoreAllMocks());

it('preserves reflection drafts when Training becomes inactive and is reopened', async () => {
  assessments = completedAssessments();
  const { rerender } = render(<TrainingView />);
  const task = await screen.findByRole('button', {
    name: /Day 1 Practice task/,
  });
  await waitFor(() => expect(task).toBeEnabled());
  fireEvent.click(task);
  fireEvent.click(screen.getByRole('button', { name: 'Mark as finish' }));
  const dialog = screen.getByRole('dialog', {
    name: 'Tell us about your practice',
  });
  within(dialog)
    .getAllByRole('radiogroup')
    .forEach((group) => {
      fireEvent.click(within(group).getByRole('radio', { name: '4 — Agree' }));
    });
  fireEvent.click(
    within(dialog).getByRole('button', { name: 'Next: written reflection' }),
  );
  const draft = within(dialog).getAllByRole('textbox')[0];
  fireEvent.change(draft, {
    target: { value: 'Keep my unfinished reflection.' },
  });
  rerender(<TrainingView visible={false} />);
  rerender(<TrainingView visible />);
  await waitFor(() =>
    expect(
      invoke.mock.calls.filter(([channel]) => channel === 'study-me'),
    ).toHaveLength(2),
  );
  expect(draft).toHaveValue('Keep my unfinished reflection.');
  expect(
    screen.getByRole('dialog', { name: 'Tell us about your practice' }),
  ).toBe(dialog);
});

it('retries instruction loading and closes the task with Escape', async () => {
  assessments = completedAssessments();
  const original = invoke.getMockImplementation()!;
  let attempts = 0;
  invoke.mockImplementation(async (channel, ...args) => {
    if (channel === 'study-task-materials') {
      attempts += 1;
      if (attempts === 1) throw new Error('Could not load instructions');
    }
    return original(channel, ...args);
  });
  render(<TrainingView />);
  const task = await screen.findByRole('button', {
    name: /Day 1 Practice task/,
  });
  await waitFor(() => expect(task).toBeEnabled());
  task.focus();
  fireEvent.click(task);
  const dialog = screen.getByRole('dialog', { name: 'Day 1 Practice task' });
  expect(await within(dialog).findByRole('alert')).toHaveTextContent(
    'Could not load instructions',
  );
  fireEvent.click(within(dialog).getByRole('button', { name: 'Retry' }));
  expect(
    await within(dialog).findByText('Try one useful prompt.'),
  ).toBeInTheDocument();
  fireEvent.keyDown(dialog, { key: 'Escape' });
  expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
  expect(task).toHaveFocus();
});

it.each(['cancel', 'error'])(
  'preserves reflection answers after a screenshot submission %s',
  async (outcome) => {
    assessments = completedAssessments();
    const original = invoke.getMockImplementation()!;
    invoke.mockImplementation(async (channel, ...args) => {
      if (channel === 'study-complete') {
        if (outcome === 'error') throw new Error('Submission failed');
        return { canceled: true };
      }
      return original(channel, ...args);
    });
    render(<TrainingView />);
    const task = await screen.findByRole('button', {
      name: /Day 1 Practice task/,
    });
    await waitFor(() => expect(task).toBeEnabled());
    fireEvent.click(task);
    expect(
      screen.queryByText(/When you’re ready, reflect on your practice/),
    ).not.toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'Mark as finish' }));
    const dialog = screen.getByRole('dialog', {
      name: 'Tell us about your practice',
    });
    const ratings = within(dialog).getAllByRole('radio');
    for (let index = 0; index < ratings.length; index += 5)
      fireEvent.click(ratings[index]);
    fireEvent.click(
      within(dialog).getByRole('button', { name: 'Next: written reflection' }),
    );
    within(dialog)
      .getAllByRole('textbox')
      .forEach((textbox) =>
        fireEvent.change(textbox, { target: { value: 'Keep my answer' } }),
      );
    const submit = within(dialog).getByRole('button', {
      name: 'Submit reflection & add screenshot',
    });
    fireEvent.click(submit);
    await waitFor(() =>
      expect(invoke).toHaveBeenCalledWith(
        'study-complete',
        1,
        'alice',
        expect.any(Object),
      ),
    );
    await waitFor(() => expect(submit).toBeEnabled());
    expect(within(dialog).getAllByRole('textbox')[0]).toHaveValue(
      'Keep my answer',
    );
    expect(within(dialog).queryByRole('alert')?.textContent ?? '').toBe(
      outcome === 'error' ? 'Submission failed' : '',
    );
    expect(screen.queryByText(/100 XP earned/)).not.toBeInTheDocument();
  },
);

it('starts with a compact checklist and opens assessments only on click', async () => {
  me.started_at = null;
  render(<TrainingView />);
  const starting = await screen.findByRole('button', {
    name: /Starting assessment/,
  });
  expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
  expect(
    screen.queryByRole('tab', { name: /Challenge 1/ }),
  ).not.toBeInTheDocument();
  expect(
    screen.getByRole('button', { name: /Day 1 Practice task/ }),
  ).toBeDisabled();
  expect(invoke).not.toHaveBeenCalledWith('study-task-materials', 1);
  fireEvent.click(starting);
  expect(
    await screen.findByRole('dialog', { name: 'Starting assessment' }),
  ).toBeInTheDocument();
  expect(
    await screen.findByRole('tab', { name: /Challenge 1/ }),
  ).toBeInTheDocument();
  expect(screen.getByRole('tab', { name: /Challenge 2/ })).toBeInTheDocument();
  expect(screen.queryByText('CHALLENGE 1')).not.toBeInTheDocument();
  expect(screen.queryByText('Ready')).not.toBeInTheDocument();
});

it('opens completed assessments directly into their questions and saved answers', async () => {
  assessments = completedAssessments();
  render(<TrainingView />);
  const row = await screen.findByRole('button', {
    name: 'Starting assessment — Complete',
  });
  expect(row).toHaveClass('training-todo--complete');
  fireEvent.click(row);
  const dialog = screen.getByRole('dialog', { name: 'Starting assessment' });
  expect(
    within(dialog).queryByText('Complete both pre-assessment challenges'),
  ).not.toBeInTheDocument();
  expect(dialog.querySelector('details')).toBeNull();
  expect(
    await within(dialog).findByRole('tab', { name: /Challenge 1/ }),
  ).toBeInTheDocument();
  fireEvent.click(within(dialog).getByRole('tab', { name: /Challenge 2/ }));
  expect(within(dialog).getAllByRole('textbox')[0]).toHaveValue('answer');
  expect(within(dialog).getAllByRole('textbox')[0]).toBeDisabled();
});

it('opens completed practice tasks with saved reflections and a screenshot', async () => {
  assessments = completedAssessments();
  me.days[0].completed_at = '2026-10-12T12:00:00Z';
  const original = invoke.getMockImplementation()!;
  invoke.mockImplementation(async (channel, ...args) => {
    if (channel === 'study-task-submission')
      return {
        answers: {
          q1: 5,
          q2: 4,
          q3: 3,
          q4: 2,
          q5: 1,
          q6: 'My saved reflection',
          q7: 'Checking facts',
          q8: 'More practice',
        },
        screenshotDataUrl: 'data:image/png;base64,c2NyZWVuc2hvdA==',
      };
    return original(channel, ...args);
  });
  render(<TrainingView />);
  const row = await screen.findByRole('button', {
    name: 'Day 1 Practice task — Complete',
  });
  await waitFor(() => expect(row).toBeEnabled());
  fireEvent.click(row);
  expect(await screen.findByText('Try one useful prompt.')).toBeInTheDocument();
  expect(await screen.findByText('My saved reflection')).toBeInTheDocument();
  expect(screen.getByText('5 — Strongly agree')).toBeInTheDocument();
  expect(
    screen.getByRole('img', { name: 'Your submitted screenshot' }),
  ).toBeInTheDocument();
  expect(invoke).toHaveBeenCalledWith('study-task-submission', 1);
  expect(
    screen.queryByRole('button', { name: 'Mark as finish' }),
  ).not.toBeInTheDocument();
});

it('explains when a completed task has no local submission copy', async () => {
  assessments = completedAssessments();
  me.days[0].completed_at = '2026-10-12T12:00:00Z';
  me.days[0].unlocked = false;
  render(<TrainingView />);
  const row = await screen.findByRole('button', {
    name: 'Day 1 Practice task — Complete',
  });
  await waitFor(() => expect(row).toBeEnabled());
  fireEvent.click(row);
  expect(
    await screen.findByText(
      /its saved submission isn’t available on this device/,
    ),
  ).toBeInTheDocument();
});

it('opens instructions and individual references without tutoring while locking future days', async () => {
  assessments = completedAssessments();
  render(<TrainingView />);
  const firstTask = await screen.findByRole('button', {
    name: /Day 1 Practice task/,
  });
  await waitFor(() => expect(firstTask).toBeEnabled());
  expect(
    screen.queryByRole('button', { name: /Day 2 Practice task/ }),
  ).not.toBeInTheDocument();
  expect(screen.getByText(/AI tutoring is disabled/)).toBeInTheDocument();
  expect(screen.queryByText('Administration')).not.toBeInTheDocument();
  fireEvent.click(firstTask);
  expect(
    await screen.findByRole('heading', { name: 'Your first task' }),
  ).toBeInTheDocument();
  expect(screen.getByText('Try one useful prompt.')).toBeInTheDocument();
  expect(
    screen.queryByRole('button', { name: 'Download task' }),
  ).not.toBeInTheDocument();
  fireEvent.click(
    screen.getByRole('button', { name: 'Download all reference files' }),
  );
  await waitFor(() =>
    expect(invoke).toHaveBeenCalledWith('study-save-references', 1),
  );
  expect(invoke).not.toHaveBeenCalledWith('study-download', 1);
  const submitTask = screen.getByRole('button', { name: 'Mark as finish' });
  await waitFor(() => expect(submitTask).toBeEnabled());
  fireEvent.click(submitTask);
  const reflection = await screen.findByRole('dialog', {
    name: 'Tell us about your practice',
  });
  expect(
    within(reflection).getByText(
      /The tasks I worked on in today’s session were relevant/,
    ),
  ).toBeInTheDocument();
  expect(
    within(reflection).getByRole('button', {
      name: 'Next: written reflection',
    }),
  ).toBeDisabled();
  const ratings = within(reflection).getAllByRole('radio');
  for (let index = 0; index < ratings.length; index += 5)
    fireEvent.click(ratings[index]);
  fireEvent.click(
    within(reflection).getByRole('button', {
      name: 'Next: written reflection',
    }),
  );
  const submit = within(reflection).getByRole('button', {
    name: 'Submit reflection & add screenshot',
  });
  expect(submit).toBeDisabled();
  within(reflection)
    .getAllByRole('textbox')
    .forEach((textbox, index) =>
      fireEvent.change(textbox, {
        target: { value: `Reflection answer ${index + 1}` },
      }),
    );
  expect(submit).toBeEnabled();
  fireEvent.click(submit);
  await waitFor(() =>
    expect(invoke).toHaveBeenCalledWith(
      'study-complete',
      1,
      'alice',
      expect.objectContaining({
        q1: 1,
        q5: 1,
        q6: 'Reflection answer 1',
        q8: 'Reflection answer 3',
      }),
    ),
  );
  expect(
    await screen.findByText(
      'Day 1 complete — reflection and screenshot saved locally.',
    ),
  ).toBeInTheDocument();
});

it('keeps Challenge 1 open to show its score after submission', async () => {
  render(<TrainingView />);
  fireEvent.click(
    await screen.findByRole('button', { name: /Starting assessment/ }),
  );
  const challenge = (
    await screen.findByRole('heading', {
      name: 'Conceptual Understanding',
    })
  ).closest('section')!;
  const radios = within(challenge).getAllByRole('radio');
  for (let index = 0; index < radios.length; index += 4) {
    fireEvent.click(radios[index]);
  }
  const submit = within(challenge).getByRole('button', {
    name: 'Finish Challenge 1 & see my score',
  });
  await waitFor(() => expect(submit).toBeEnabled());
  fireEvent.click(submit);

  expect(await screen.findByText('2 / 8')).toBeInTheDocument();
  expect(
    screen.getByRole('heading', { name: 'Conceptual Understanding' }),
  ).toBeInTheDocument();
  expect(
    screen.queryByRole('heading', { name: 'Anti-Blind-Acceptance' }),
  ).not.toBeInTheDocument();
});

it('shows learning progress and the original animation beneath awards, independent of the collapsible group', async () => {
  me.days[0].completed_at = '2026-09-24T01:00:00Z';
  me.days[1].unlocked = true;
  const { container } = render(<TrainingView />);
  const toggle = await screen.findByRole('button', { name: 'Training tasks' });
  expect(toggle).toHaveAttribute('aria-expanded', 'true');
  expect(screen.queryByText(/100 XP/)).not.toBeInTheDocument();
  expect(
    screen.getByRole('progressbar', { name: 'Learning progress' }),
  ).toHaveAttribute('aria-valuenow', '14');
  expect(screen.getByRole('progressbar')).toHaveAttribute(
    'aria-valuetext',
    '1 of 7 tasks complete',
  );
  const progress = screen.getByRole('region', { name: 'Learning progress' });
  expect(progress.previousElementSibling).toBe(
    screen.getByRole('complementary', { name: 'Announcements' }),
  );
  expect(within(progress).getByText('1/7')).toBeInTheDocument();
  expect(within(progress).getByText('Learning progress')).toBeInTheDocument();
  const progressHeader = container.querySelector('.training-progress-header');
  expect(progressHeader).toContainElement(
    within(progress).getByText('Learning progress'),
  );
  expect(progressHeader).toContainElement(
    container.querySelector('.training-progress-avatar'),
  );
  expect(toggle.closest('.training-group-header')).not.toContainElement(
    screen.getByRole('progressbar'),
  );
  expect(container.querySelector('.training-progress-avatar')).toHaveAttribute(
    'src',
    'test-file-stub',
  );
  expect(
    screen.getByRole('button', { name: 'Day 1 Practice task — Complete' }),
  ).toHaveClass('training-todo--complete');
  expect(
    screen.getByText('Camp awards · Three $50 awards'),
  ).toBeInTheDocument();
  fireEvent.click(toggle);
  expect(toggle).toHaveAttribute('aria-expanded', 'false');
  expect(
    screen.queryByRole('list', { name: 'Training tasks' }),
  ).not.toBeInTheDocument();
  expect(screen.getByRole('progressbar')).toBeVisible();
  expect(
    screen.getByRole('button', { name: /Starting assessment/ }),
  ).toBeVisible();
  fireEvent.click(toggle);
  expect(screen.getByRole('list', { name: 'Training tasks' })).toBeVisible();
  expect(
    screen.getByRole('button', { name: 'Day 1 Practice task — Complete' }),
  ).toBeVisible();
});

it('unlocks all three post-assessment sections only after day seven', async () => {
  me.days.forEach((day) => {
    day.completed_at = '2026-10-07T12:00:00Z';
    day.unlocked = true;
  });
  postAssessment.unlocked = true;

  render(<TrainingView />);
  fireEvent.click(
    await screen.findByRole('button', { name: /Final assessment/ }),
  );

  const postAssessmentPanel = (
    await screen.findByRole('heading', {
      name: 'Complete your post-assessment',
    })
  ).closest('section')!;
  expect(
    within(postAssessmentPanel).getByRole('tab', { name: /Self-assessment/ }),
  ).toBeInTheDocument();
  fireEvent.click(
    within(postAssessmentPanel).getByRole('tab', { name: /AI literacy/ }),
  );
  expect(within(postAssessmentPanel).getAllByRole('radio')).toHaveLength(32);
  const executionTab = within(postAssessmentPanel).getByRole('tab', {
    name: /Execution task/,
  });
  fireEvent.click(executionTab);
  expect(
    await screen.findByRole('heading', { name: 'Trust, But Verify' }),
  ).toBeInTheDocument();
  expect(
    screen.getByRole('button', { name: 'Download all toolkit files' }),
  ).toBeInTheDocument();
  fireEvent.click(screen.getByRole('button', { name: 'Start task' }));
  expect(
    screen.getByRole('dialog', {
      name: 'Task activity will be recorded',
    }),
  ).toBeInTheDocument();
  fireEvent.click(
    screen.getByRole('button', { name: 'Start task & recording' }),
  );
  await waitFor(() =>
    expect(invoke).toHaveBeenCalledWith('post-assessment-start-execution'),
  );
  expect(
    await screen.findByText('Recording task activity'),
  ).toBeInTheDocument();
  expect(screen.queryByRole('timer')).not.toBeInTheDocument();
  expect(
    screen.queryByRole('button', { name: /interaction logs/i }),
  ).not.toBeInTheDocument();
});

it('can start activity recording after the execution task is already running', async () => {
  me.days.forEach((day) => {
    day.completed_at = '2026-10-07T12:00:00Z';
    day.unlocked = true;
  });
  postAssessment.unlocked = true;
  postAssessment.execution_started_at = '2026-10-07T12:00:00Z';

  render(<TrainingView />);
  fireEvent.click(
    await screen.findByRole('button', { name: /Final assessment/ }),
  );

  fireEvent.click(await screen.findByRole('tab', { name: /Execution task/ }));
  expect(
    await screen.findByText('No task recording found'),
  ).toBeInTheDocument();
  fireEvent.click(
    screen.getByRole('button', { name: 'Start activity recording' }),
  );
  expect(
    screen.getByRole('dialog', {
      name: 'Task activity will be recorded',
    }),
  ).toBeInTheDocument();
  fireEvent.click(screen.getByRole('button', { name: 'Start recording now' }));

  await waitFor(() =>
    expect(invoke).toHaveBeenCalledWith('post-assessment-recorder-start'),
  );
  expect(
    await screen.findByText('Recording task activity'),
  ).toBeInTheDocument();
  expect(screen.queryByRole('timer')).not.toBeInTheDocument();
});

it.each(['participant', 'admin', 'super_admin'] as const)(
  'hides the final assessment until all seven days are complete in the %s student experience',
  async (role) => {
    me.role = role;
    studentMode = role !== 'participant';
    me.days.slice(0, 6).forEach((day) => {
      day.completed_at = '2026-10-07T12:00:00Z';
    });
    postAssessment.unlocked = true;
    render(<TrainingView />);
    await screen.findByRole('list', { name: 'Practice checklist' });
    expect(
      screen.queryByRole('button', { name: /Final assessment/ }),
    ).not.toBeInTheDocument();
    expect(invoke).not.toHaveBeenCalledWith('post-assessment-state');
  },
);

it.each(['admin', 'super_admin'] as const)(
  'reveals every practice day and the final assessment in %s mode',
  async (role) => {
    me.role = role;
    render(<TrainingView />);
    await screen.findByRole('list', { name: 'Practice checklist' });
    expect(
      screen.getAllByRole('button', { name: /Day \d Practice task/ }),
    ).toHaveLength(7);
    expect(
      screen.getByRole('button', { name: /Final assessment/ }),
    ).toBeInTheDocument();
  },
);

it('groups practice days beneath a concise training heading without row subtitles', async () => {
  me.role = 'admin';
  me.days[0].completed_at = '2026-10-07T12:00:00Z';
  render(<TrainingView />);
  const checklist = await screen.findByRole('list', {
    name: 'Practice checklist',
  });
  expect(
    screen.getByRole('heading', { level: 1, name: 'AI Literacy Challenge' }),
  ).toBeInTheDocument();
  expect(
    screen.getByText(/Coco helps you get work done faster/),
  ).toBeInTheDocument();
  expect(
    screen.getByText(/Assessments on Days 0, 7, and 21/),
  ).toBeInTheDocument();
  const training = within(checklist).getByRole('list', {
    name: 'Training tasks',
  });
  expect(training.parentElement?.parentElement).toBe(checklist);
  expect(checklist.children).toHaveLength(3);
  expect(within(training).getAllByRole('listitem')).toHaveLength(7);
  expect(
    within(training).queryByRole('button', { name: /assessment/ }),
  ).not.toBeInTheDocument();
  expect(checklist.querySelector('small')).toBeNull();
  expect(
    within(checklist).queryByText(/Complete|Ready|Start here/),
  ).not.toBeInTheDocument();
  expect(
    within(training).getByRole('button', {
      name: 'Day 1 Practice task — Complete',
    }),
  ).toHaveClass('training-todo--complete');
});

it('reveals only the next unfinished practice day, even when it is locked', async () => {
  assessments = completedAssessments();
  me.days[0].completed_at = '2026-10-07T12:00:00Z';
  render(<TrainingView />);
  expect(
    await screen.findByRole('button', { name: /Day 1 Practice task/ }),
  ).toBeInTheDocument();
  expect(
    screen.getByRole('button', { name: /Day 2 Practice task/ }),
  ).toBeDisabled();
  expect(
    screen.queryByRole('button', { name: /Day 3/ }),
  ).not.toBeInTheDocument();
});

it('does not begin training while materials are missing', async () => {
  me.started_at = null;
  me.days[0].available = false;
  render(<TrainingView />);
  expect(
    await screen.findByRole('button', { name: /Day 1 Practice task/ }),
  ).toBeDisabled();
});

it.each(['participant', 'admin', 'super_admin'] as const)(
  'shows tasks without desktop administration controls for %s accounts',
  async (role) => {
    me.role = role;
    assessments = completedAssessments();
    render(<TrainingView />);
    expect(
      await screen.findByRole('list', { name: 'Practice checklist' }),
    ).toBeInTheDocument();
    expect(
      screen.queryByRole('button', { name: 'Administration' }),
    ).not.toBeInTheDocument();
    expect(
      screen.queryByRole('button', { name: 'My tasks' }),
    ).not.toBeInTheDocument();
    expect(screen.queryByLabelText('Username')).not.toBeInTheDocument();
    expect(
      screen.queryByRole('button', { name: 'Choose file and upload' }),
    ).not.toBeInTheDocument();
    expect(
      invoke.mock.calls.some(([channel]) => channel.startsWith('study-admin-')),
    ).toBe(false);
  },
);

it('lets an admin enter and exit the gated student experience', async () => {
  me.role = 'admin';
  render(<TrainingView />);

  const enter = await screen.findByRole('button', { name: 'Student mode' });
  fireEvent.click(enter);

  expect(
    await screen.findByRole('button', { name: 'Exit student mode' }),
  ).toBeInTheDocument();
  expect(
    screen.queryByRole('button', { name: 'Administration' }),
  ).not.toBeInTheDocument();
  expect(
    screen.getByRole('button', { name: /Day 1 Practice task/ }),
  ).toBeDisabled();
  expect(
    screen.queryByRole('button', { name: /Day 2 Practice task/ }),
  ).not.toBeInTheDocument();
  expect(
    screen.queryByRole('button', { name: /Final assessment/ }),
  ).not.toBeInTheDocument();

  fireEvent.click(screen.getByRole('button', { name: 'Exit student mode' }));
  expect(
    await screen.findByRole('button', { name: 'Student mode' }),
  ).toBeInTheDocument();
  expect(
    screen.queryByRole('button', { name: 'Administration' }),
  ).not.toBeInTheDocument();
  await waitFor(() =>
    expect(
      screen.getByRole('button', { name: /Day 1 Practice task/ }),
    ).toBeEnabled(),
  );
  expect(
    screen.getAllByRole('button', { name: /Day \d Practice task/ }),
  ).toHaveLength(7);
  expect(
    screen.getByRole('button', { name: /Final assessment/ }),
  ).toBeInTheDocument();
});
