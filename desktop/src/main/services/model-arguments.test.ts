import { configureServiceModelArguments } from './model-arguments';

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

    expect(() => configureServiceModelArguments(manager, '', 'vision'))
      .toThrow('Both tutor and sensing model IDs are required.');
    expect(manager.configureServiceArg).not.toHaveBeenCalled();
  });
});
