import {
  configureServiceModelArguments,
  startModelServices,
} from './model-arguments';

describe('configureServiceModelArguments', () => {
  it('applies saved model IDs after an early service-config load', () => {
    const manager = { configureServiceArg: jest.fn() };

    configureServiceModelArguments(
      manager,
      'gemini/gemini-tutor',
      'gemini/gemini-vision',
    );

    expect(manager.configureServiceArg).toHaveBeenNthCalledWith(
      1,
      'tutor-server',
      'model_name',
      'gemini/gemini-tutor',
    );
    expect(manager.configureServiceArg).toHaveBeenNthCalledWith(
      2,
      'sensing-server',
      'observer_model',
      'gemini/gemini-vision',
    );
  });

  it('refuses to configure services with an empty model ID', () => {
    const manager = { configureServiceArg: jest.fn() };

    expect(() => configureServiceModelArguments(manager, '', 'vision')).toThrow(
      'A tutor model ID is required.',
    );
    expect(manager.configureServiceArg).not.toHaveBeenCalled();
  });
});

it('starts chat without sensing, and keeps sensing off while sleeping', () => {
  const manager = { configureServiceArg: jest.fn(), startService: jest.fn() };
  configureServiceModelArguments(manager, 'pi/test/chat', '');
  expect(manager.configureServiceArg).toHaveBeenCalledTimes(1);
  for (const [model, sleeping] of [
    ['', false],
    ['pi/test/vision', true],
  ] as const) {
    manager.startService.mockClear();
    startModelServices(manager, model, sleeping);
    expect(manager.startService.mock.calls).toEqual([['tutor-server']]);
  }
  manager.startService.mockClear();
  startModelServices(manager, 'pi/test/vision', false);
  expect(manager.startService.mock.calls).toEqual([
    ['tutor-server'],
    ['sensing-server'],
  ]);
});
