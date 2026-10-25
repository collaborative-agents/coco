interface ServiceArgumentConfigurator {
  configureServiceArg(id: string, name: string, value: string): void;
}

export function configureServiceModelArguments(
  manager: ServiceArgumentConfigurator,
  tutorModel: string,
  sensingModel: string,
): void {
  const tutor = tutorModel.trim();
  const sensing = sensingModel.trim();
  if (!tutor) {
    throw new Error('A tutor model ID is required.');
  }
  manager.configureServiceArg('tutor-server', 'model_name', tutor);
  if (sensing)
    manager.configureServiceArg('sensing-server', 'observer_model', sensing);
}

export function startModelServices(
  manager: { startService(id: string): void },
  sensingModel: string,
  sleeping: boolean,
): void {
  manager.startService('tutor-server');
  if (sensingModel.trim() && !sleeping) manager.startService('sensing-server');
}
