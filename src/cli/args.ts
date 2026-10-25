export interface ParsedArgs {
  positionals: string[];
  flags: Record<string, string | boolean | string[]>;
}

export function parseArgs(argv: string[]): ParsedArgs {
  const positionals: string[] = [];
  const flags: Record<string, string | boolean | string[]> = {};

  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index] ?? '';
    if (arg === '--') {
      positionals.push(...argv.slice(index + 1));
      break;
    }
    if (!arg.startsWith('--')) {
      positionals.push(arg);
      continue;
    }
    const body = arg.slice(2);
    const equals = body.indexOf('=');
    if (equals >= 0) {
      setFlag(flags, body.slice(0, equals), body.slice(equals + 1));
      continue;
    }
    const next = argv[index + 1];
    if (next !== undefined && !next.startsWith('-')) {
      setFlag(flags, body, next);
      index += 1;
    } else {
      setFlag(flags, body, true);
    }
  }

  return { positionals, flags };
}

function setFlag(flags: Record<string, string | boolean | string[]>, key: string, value: string | boolean): void {
  const existing = flags[key];
  if (existing === undefined) {
    flags[key] = value;
  } else if (Array.isArray(existing)) {
    existing.push(String(value));
  } else {
    flags[key] = [String(existing), String(value)];
  }
}

export function flagString(args: ParsedArgs, name: string): string | undefined {
  const value = args.flags[name];
  if (value === undefined) return undefined;
  if (Array.isArray(value)) return value[value.length - 1];
  return String(value);
}

export function flagBool(args: ParsedArgs, name: string): boolean {
  const value = args.flags[name];
  return value === true || value === 'true';
}

export function flagList(args: ParsedArgs, name: string): string[] {
  const value = args.flags[name];
  if (value === undefined) return [];
  if (Array.isArray(value)) return value.flatMap((item) => item.split(',')).filter(Boolean);
  if (value === true) return [];
  return String(value)
    .split(',')
    .map((item) => item.trim())
    .filter(Boolean);
}
