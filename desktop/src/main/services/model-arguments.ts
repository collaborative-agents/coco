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
  if (!tutor || !sensing) {
    throw new Error('Both tutor and sensing model IDs are required.');
  }
  manager.configureServiceArg('tutor-server', 'model_name', tutor);
  manager.configureServiceArg('sensing-server', 'observer_model', sensing);
}
