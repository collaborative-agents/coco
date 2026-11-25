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

it('keeps capture running while sleeping and sets observer state before startup', () => {
  const manager = {
    configureServiceArg: jest.fn(),
    configureServiceEnv: jest.fn(),
    startService: jest.fn(),
  };
  configureServiceModelArguments(manager, 'pi/test/chat', '');
  expect(manager.configureServiceArg).toHaveBeenCalledTimes(1);
  startModelServices(manager, '', false);
  expect(manager.startService.mock.calls).toEqual([['tutor-server']]);
  expect(manager.configureServiceEnv).not.toHaveBeenCalled();

  [true, false].forEach((sleeping) => {
    manager.startService.mockClear();
    startModelServices(manager, 'pi/test/vision', sleeping);
    expect(manager.startService.mock.calls).toEqual([
      ['tutor-server'],
      ['sensing-server'],
    ]);
    expect(manager.configureServiceEnv).toHaveBeenLastCalledWith(
      'sensing-server',
      {
        COCO_OBSERVER_ENABLED: sleeping ? '0' : '1',
      },
    );
    expect(
      manager.configureServiceEnv.mock.invocationCallOrder.at(-1),
    ).toBeLessThan(manager.startService.mock.invocationCallOrder.at(-1)!);
  });
});
