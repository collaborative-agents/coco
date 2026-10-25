import type { TutorToolCall } from '../observation-types';

// A small display parser, never a shell interpreter. Quoted script contents are
// kept as arguments so words inside Python/JS code cannot masquerade as commands.
function commands(source: string): string[][] | null {
  if (/\$\(|`|<<|[()]/.test(source)) return null;
  const result: string[][] = [];
  let words: string[] = [];
  let word = '';
  let quote = '';
  let escaped = false;
  const flushWord = () => {
    if (word) words.push(word);
    word = '';
  };
  const flushCommand = () => {
    flushWord();
    if (words.length) result.push(words);
    words = [];
  };
  for (let index = 0; index < source.length; index += 1) {
    const char = source[index];
    if (escaped) {
      word += char;
      escaped = false;
    } else if (char === '\\' && quote !== "'") escaped = true;
    else if (quote) {
      if (char === quote) quote = '';
      else word += char;
    } else if (char === '"' || char === "'") quote = char;
    else if (char === '>' || char === '<') return null;
    else if (';&|\n'.includes(char)) flushCommand();
    else if (/\s/.test(char)) flushWord();
    else word += char;
  }
  if (quote || escaped) return null;
  flushCommand();
  return result;
}

function commandLabel(words: string[]): string | null {
  const args = [...words];
  while (/^[A-Za-z_][A-Za-z0-9_]*=/.test(args[0] ?? '')) args.shift();
  const executable = args.shift()?.split('/').pop();
  if (executable === 'cd') return null;
  if (['curl', 'wget'].includes(executable ?? '')) return 'Access web content';
  if (
    executable === 'find' &&
    args.some((arg) => ['-exec', '-execdir', '-delete'].includes(arg))
  )
    return 'Run file operations';
  if (['rg', 'grep', 'find', 'fd'].includes(executable ?? ''))
    return 'Search files';
  if (['cat', 'head', 'tail', 'less'].includes(executable ?? ''))
    return 'Read files';
  if (executable === 'sed')
    return args.some((arg) => /^-.*i/.test(arg)) ? 'Edit files' : 'Read files';
  if (['ls', 'pwd', 'du', 'wc', 'stat', 'file'].includes(executable ?? ''))
    return 'Inspect files and folders';
  if (executable === 'git') {
    if (['status', 'diff', 'log', 'show', 'ls-files'].includes(args[0]))
      return 'Review project changes';
    if (args[0] === 'push') return 'Publish project changes';
    if (args[0] === 'commit') return 'Save a version of the changes';
    return 'Update version control';
  }
  if (executable === 'rm' || executable === 'rmdir') return 'Remove files';
  if (executable === 'cp') return 'Copy files';
  if (executable === 'mv') return 'Move or rename files';
  if (executable === 'mkdir') return 'Create a folder';
  if (executable === 'pytest') return 'Run tests';
  if (executable === 'uv' && args[0] === 'run')
    return commandLabel(args.slice(1));
  if (['npm', 'pnpm', 'yarn', 'bun'].includes(executable ?? '')) {
    const action = args[0] === 'run' ? args[1] : args[0];
    if (/^test(?::|$)/.test(action ?? '')) return 'Run tests';
    if (/^(lint|typecheck|check)(?::|$)/.test(action ?? ''))
      return 'Check code quality';
    if (/^build(?::|$)/.test(action ?? '')) return 'Build the project';
    if (['install', 'add', 'ci'].includes(action))
      return 'Install project dependencies';
  }
  if (
    ['python', 'python3'].includes(executable ?? '') &&
    args[0] === '-m' &&
    args[1] === 'pytest'
  )
    return 'Run tests';
  if (['python', 'python3', 'node', 'ruby'].includes(executable ?? ''))
    return 'Run a script';
  return 'Run a command';
}

export default function toolSummary(call: TutorToolCall): string {
  const labels: Record<string, string> = {
    read: 'Read a file',
    write: 'Write a file',
    edit: 'Edit a file',
    grep: 'Search file contents',
    find: 'Find files',
    ls: 'Inspect a folder',
    observe_screen: 'Check the current screen',
    get_user_context: 'Look up relevant context',
    get_recent_observations: 'Review recent activity',
  };
  if (call.name !== 'bash') return labels[call.name] ?? 'Use a tool';
  const { command } = call.arguments;
  if (typeof command !== 'string') return 'Run a command';
  const parsed = commands(command);
  if (!parsed) return 'Run a script';
  const actions = [
    ...new Set(
      parsed
        .map(commandLabel)
        .filter((label): label is string => Boolean(label)),
    ),
  ];
  if (!actions.length) return 'Inspect the working folder';
  return (
    actions.slice(0, 3).join(' · ') +
    (actions.length > 3 ? ' · More actions' : '')
  );
}
