/** @jest-environment node */
import { BrowserWindow } from 'electron';
import createProactiveNotifications from './proactive-notifications';

jest.mock('electron', () => ({
  BrowserWindow: jest.fn(() => {
    const listeners = new Map();
    return {
      on: (name: string, fn: Function) => listeners.set(name, fn),
      listeners,
      loadURL: jest.fn(),
      show: jest.fn(),
      destroy: jest.fn(),
      isDestroyed: () => false,
      webContents: { send: jest.fn() },
    };
  }),
  screen: {
    getPrimaryDisplay: () => ({
      workArea: { x: 0, y: 0, width: 1200, height: 900 },
    }),
  },
}));
jest.mock('electron-log', () => ({ info: jest.fn() }));
jest.mock('./util', () => ({ resolveHtmlPath: () => 'index.html' }));
jest.mock('./services/fullscreen-companion-window', () => ({
  ...jest.requireActual('./services/fullscreen-companion-window'),
  __esModule: true,
  default: jest.fn(),
}));

function setup() {
  const handlers = new Map<string, Function>();
  const send = jest.fn();
  const startSession = jest.fn(async () => 'session');
  const controller = createProactiveNotifications({
    ipc: {
      on: (name: string, fn: Function) => {
        handlers.set(name, fn);
        return {} as never;
      },
      removeAllListeners: jest.fn(),
    },
    avatar: () => ({ webContents: { send } }) as unknown as BrowserWindow,
    avatarHidden: () => false,
    preload: () => '',
    taskLabel: () => 'Task',
    clearHiddenSuggestion: jest.fn(),
    startSession,
    endSession: jest.fn(),
  });
  return { controller, handlers, send, startSession };
}
beforeEach(() => jest.clearAllMocks());

it('ignores responses to replaced invitations and starts the accepted task once', () => {
  const test = setup();
  test.controller.invite('First task', 'First observation');
  const first = test.send.mock.calls.at(-1)![1];
  test.controller.invite('Second task', 'Second observation');
  const second = test.send.mock.calls.at(-1)![1];
  const respond = test.handlers.get('session-invite-response')!;
  respond({}, { inviteId: first.inviteId, outcome: 'accepted' });
  expect(test.startSession).not.toHaveBeenCalled();
  respond({}, { inviteId: second.inviteId, outcome: 'accepted' });
  respond({}, { inviteId: second.inviteId, outcome: 'accepted' });
  expect(test.startSession).toHaveBeenCalledTimes(1);
  expect(test.startSession).toHaveBeenCalledWith('Second task', 120);
});

it('does not let a replaced bubble deliver stale content or clear the current window', () => {
  const { controller } = setup();
  controller.showNotification({ message: 'First', actionLabel: 'Open' });
  const first = (BrowserWindow as unknown as jest.Mock).mock.results[0].value;
  controller.showNotification({ message: 'Second', actionLabel: 'Open' });
  const second = (BrowserWindow as unknown as jest.Mock).mock.results[1].value;
  first.listeners.get('ready-to-show')();
  first.listeners.get('closed')();
  second.listeners.get('ready-to-show')();
  expect(first.webContents.send).not.toHaveBeenCalled();
  expect(second.webContents.send).toHaveBeenCalledWith(
    'notification',
    expect.objectContaining({ message: 'Second' }),
  );
  controller.dismissNotification();
  expect(second.destroy).toHaveBeenCalledTimes(1);
});
