import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createEventBus } from '../release/app/node_modules/@earendil-works/pi-coding-agent/dist/index.js';
import {
  waitForAnswer,
  normalizeAnswer,
  ANSWER_CHANNEL,
  CANCEL_CHANNEL,
} from '../release/app/agent/question-channel.mjs';
const questions = [
  { question: 'Which?', options: [{ label: 'A' }, { label: 'B' }] },
];
test('answers validate selections and preserve custom and multi-select answers', () => {
  assert.throws(() =>
    normalizeAnswer(questions, { answers: [{ selected: ['X'], text: '' }] }),
  );
  assert.throws(() =>
    normalizeAnswer(questions, {
      answers: [{ selected: ['A'], text: 'custom' }],
    }),
  );
  assert.equal(
    normalizeAnswer(questions, {
      answers: [{ selected: [], text: ' custom ' }],
    }).answers[0].answer,
    'custom',
  );
  const result = normalizeAnswer([{ ...questions[0], multiSelect: true }], {
    answers: [{ selected: ['B', 'A'], text: 'extra' }],
  });
  assert.deepEqual(result.answers[0].selected, ['B', 'A']);
  assert.equal(result.answers[0].answer, 'extra');
});
test('stop and skip release waits; stale answers are not accepted', async () => {
  const events = createEventBus();
  const controller = new AbortController();
  const pending = waitForAnswer(
    events,
    'one',
    questions,
    controller.signal,
    () => {},
  );
  const stale = { toolCallId: 'old', response: { cancelled: true } };
  events.emit(ANSWER_CHANNEL, stale);
  assert.equal(stale.accepted, undefined);
  controller.abort();
  assert.equal((await pending).cancelled, true);
  const next = waitForAnswer(events, 'two', questions, undefined, () => {});
  const skip = { toolCallId: 'two', response: { cancelled: true } };
  events.emit(ANSWER_CHANNEL, skip);
  assert.equal(skip.accepted, true);
  assert.equal((await next).cancelled, true);
  const disposed = waitForAnswer(
    events,
    'three',
    questions,
    undefined,
    () => {},
  );
  events.emit(CANCEL_CHANNEL, {});
  assert.equal((await disposed).cancelled, true);
});
