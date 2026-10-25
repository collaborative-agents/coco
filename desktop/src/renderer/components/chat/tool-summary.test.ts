import toolSummary from './tool-summary';

const summary = (command: string) =>
  toolSummary({
    id: '1',
    name: 'bash',
    arguments: { command },
    status: 'completed',
  });

test.each([
  ['rg -n "token" src', 'Search files'],
  ['cd /work && cat README.md', 'Read files'],
  ['UV_CACHE_DIR=/tmp/cache uv run pytest -q', 'Run tests'],
  ['npm run typecheck', 'Check code quality'],
  ['git status --short && git diff', 'Review project changes'],
  ['curl https://example.org/paper', 'Access web content'],
  ['rm old.txt && cp new.txt copy.txt', 'Remove files · Copy files'],
  ['cat "file; with | punctuation.txt"', 'Read files'],
  ["python3 -c 'curl = 3'", 'Run a script'],
  ['unknown-command --flag', 'Run a command'],
  ['cat input.txt > output.txt', 'Run a script'],
  ['find . -name old -delete', 'Run file operations'],
])('summarizes %s without exposing command text', (command, expected) => {
  expect(summary(command)).toBe(expected);
});

test('complex scripts fall back without guessing from words inside their code', () => {
  expect(summary("python3 <<'PY'\nprint('curl')\nPY")).toBe('Run a script');
  expect(summary('echo $(rm file)')).toBe('Run a script');
});
