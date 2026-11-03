import '@testing-library/jest-dom';
import { fireEvent, render } from '@testing-library/react';
import AgentActivityList, { groupActivity } from './AgentActivityList';
import type { TutorToolCall } from '../observation-types';

const call = (
  id: string,
  command: string,
  status: TutorToolCall['status'] = 'completed',
): TutorToolCall => ({
  id,
  name: 'bash',
  arguments: { command },
  status,
  result: { output: 'Exact raw output' },
});

test('shows a human summary with readable command and output collapsed', () => {
  const { container } = render(
    <AgentActivityList
      activity={[{ kind: 'tool', call: call('1', 'rg token src') }]}
      interactive={false}
    />,
  );
  const disclosure = container.querySelector('details')!;
  expect(disclosure.open).toBe(false);
  expect(disclosure.querySelector('summary')).toHaveTextContent('Search files');
  expect(disclosure.querySelector('summary')).not.toHaveTextContent(
    'rg token src',
  );
  expect(disclosure.querySelector('pre')).toHaveTextContent('rg token src');
  fireEvent.click(disclosure.querySelector('summary')!);
  expect(disclosure.open).toBe(true);
  expect(disclosure.querySelectorAll('pre')[0]).toHaveTextContent(
    'rg token src',
  );
  expect(disclosure.querySelectorAll('pre')[1]).toHaveTextContent(
    'Exact raw output',
  );
  expect(disclosure).not.toHaveTextContent('"id"');
});

test('collapses consecutive calls and makes failures visible in the summary', () => {
  const { container } = render(
    <AgentActivityList
      activity={[
        { kind: 'tool', call: call('1', 'rg token src') },
        { kind: 'tool', call: call('2', 'cat README.md', 'error') },
      ]}
      interactive={false}
    />,
  );
  const group = container.querySelector('.tool-activity-group')!;
  expect(group).not.toHaveAttribute('open');
  const actions = group.querySelectorAll('details');
  expect(actions).toHaveLength(2);
  actions.forEach((action) => {
    expect(action.open).toBe(false);
    expect(action.querySelector('summary')).toHaveTextContent('bash');
    expect(action.querySelector('summary')).not.toHaveTextContent(
      'Run a script',
    );
  });
  fireEvent.click(group.querySelector('summary')!);
  expect(group).toHaveAttribute('open');
  expect(actions[0].open).toBe(false);
  fireEvent.click(actions[0].querySelector('summary')!);
  expect(actions[0].open).toBe(true);
  expect(actions[1].open).toBe(false);
  expect(actions[0]).toHaveTextContent('rg token src');
  expect(actions[1]).toHaveTextContent('cat README.md');
  expect(group.querySelectorAll('.tool-detail-field')).toHaveLength(4);
  expect(group.querySelector('summary')).toHaveTextContent(
    '2 steps · 1 failed',
  );
});

test('never hides a question inside a tool group or moves commentary out of order', () => {
  const groups = groupActivity([
    { kind: 'tool', call: call('1', 'ls') },
    { kind: 'message', text: 'Checking the relevant files.' },
    { kind: 'tool', call: { ...call('2', ''), name: 'ask_user_question' } },
    { kind: 'tool', call: call('3', 'cat README.md') },
  ]);
  expect(groups.map((item) => item.kind)).toEqual([
    'tools',
    'message',
    'question',
    'tools',
  ]);
});

test('hides blank saved messages and groups tools across whitespace', () => {
  const activity = [
    { kind: 'message' as const, text: '' },
    { kind: 'tool' as const, call: call('1', 'ls') },
    { kind: 'message' as const, text: ' \n\t' },
    { kind: 'tool' as const, call: call('2', 'cat README.md') },
    { kind: 'message' as const, text: '\n' },
  ];
  expect(groupActivity(activity)).toEqual([
    { kind: 'tools', key: '1', calls: [activity[1].call, activity[3].call] },
  ]);
  const { container } = render(
    <AgentActivityList activity={activity} interactive={false} />,
  );
  expect(container.querySelector('.tutor-response')).toBeNull();
  expect(container.querySelector('.tool-activity-group')).toHaveTextContent(
    '2 steps · Done',
  );
});

test('groups tool calls across approved requests while retaining denials', () => {
  const permission = {
    id: 'permission',
    kind: 'action' as const,
    tool: 'bash',
    arguments: { command: 'ls' },
    directory: '/work',
    status: 'allowed' as const,
  };
  const groups = groupActivity([
    { kind: 'tool', call: call('1', 'ls') },
    { kind: 'permission', request: permission },
    { kind: 'tool', call: call('2', 'pwd') },
    {
      kind: 'permission',
      request: { ...permission, id: 'denied', status: 'denied' },
    },
  ]);
  expect(groups.map((group) => group.kind)).toEqual(['tools', 'permission']);
  expect(groups[0].kind === 'tools' && groups[0].calls).toHaveLength(2);
});
