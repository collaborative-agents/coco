type Environment = Record<string, string | undefined>;

export const MAX_FATAL_ERROR_MESSAGE_LENGTH = 4096;

/** Remove credentials from the bounded diagnostic text uploaded to the Gateway. */
export function sanitizeFatalErrorMessage(
  value: string,
  environments: Environment[] = [process.env],
): string {
  let message = value.trim();
  const secretNames = /(?:API_KEY|TOKEN|PASSWORD|SECRET|CREDENTIAL)$/i;
  const secrets = environments
    .flatMap((environment) => Object.entries(environment))
    .filter(
      ([name, secret]) =>
        secretNames.test(name) &&
        typeof secret === 'string' &&
        secret.length >= 8,
    )
    .map(([, secret]) => secret as string)
    .filter((secret, index, values) => values.indexOf(secret) === index)
    .sort((left, right) => right.length - left.length);
  secrets.forEach((secret) => {
    message = message.split(secret).join('[redacted]');
  });
  message = message
    .replace(/Bearer\s+[^\s,;]+/gi, 'Bearer [redacted]')
    .replace(/\bsk-[A-Za-z0-9_-]{8,}\b/g, '[redacted-api-key]')
    .replace(
      /([?&](?:api[_-]?key|token|credential)=)[^&\s]+/gi,
      '$1[redacted]',
    );
  return (message || 'Service terminated without an error message.').slice(
    -MAX_FATAL_ERROR_MESSAGE_LENGTH,
  );
}
