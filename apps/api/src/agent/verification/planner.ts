import type { CheckKind, CheckReason, CheckStatus, RepositoryProfile } from '@nimbus/contracts';

export interface PlannedCheck {
  checkId: string;
  name: string;
  kind: CheckKind;
  argv: string[];
  cwd: string;
  scope: string[];
  required: boolean;
  fallbackAvailable: boolean;
}

const SCRIPT_KIND: Readonly<Record<string, CheckKind>> = {
  test: 'test', lint: 'lint', typecheck: 'typecheck', build: 'build',
  'format:check': 'lint',
};

export function plannedChecks(
  profile: RepositoryProfile,
  changedPaths: readonly string[],
): PlannedCheck[] {
  const checks: PlannedCheck[] = [];
  for (const checkId of profile.checkIds) {
    const split = checkId.lastIndexOf(':');
    const manifest = checkId.slice(0, split);
    const script = checkId.slice(split + 1);
    const kind = SCRIPT_KIND[script];
    if (kind === undefined || !manifest.endsWith('package.json')) continue;
    const cwd = manifest.includes('/') ? manifest.slice(0, manifest.lastIndexOf('/')) : '.';
    checks.push({
      checkId,
      name: `${script} (${cwd === '.' ? 'repository' : cwd})`,
      kind,
      argv: ['pnpm', 'run', script],
      cwd,
      scope: changedPaths.filter((path) => cwd === '.' || path.startsWith(`${cwd}/`)),
      required: ['test', 'typecheck', 'build'].includes(script),
      fallbackAvailable: true,
    });
  }
  return checks;
}

export function resolvePlannedCheck(
  profile: RepositoryProfile | null,
  checkId: string,
  changedPaths: readonly string[],
): PlannedCheck | null {
  if (profile !== null) {
    const known = plannedChecks(profile, changedPaths).find((one) => one.checkId === checkId);
    if (known !== undefined) return known;
  }

  const syntax = /^syntax:(typescript|javascript|python|c|cpp|go|rust|java|csharp):(.+)$/.exec(checkId);
  if (syntax === null) return null;
  const language = syntax[1] ?? '';
  const path = syntax[2] ?? '';
  const commands: Readonly<Record<string, { kind: CheckKind; argv: string[] }>> = {
    typescript: { kind: 'typecheck', argv: ['tsc', '--noEmit', path] },
    javascript: { kind: 'typecheck', argv: ['node', '--check', path] },
    python: { kind: 'typecheck', argv: ['python', '-B', '-m', 'py_compile', path] },
    c: { kind: 'build', argv: ['gcc', '-fsyntax-only', path] },
    cpp: { kind: 'build', argv: ['g++', '-std=c++17', '-fsyntax-only', path] },
    go: { kind: 'test', argv: ['go', 'test', './...'] },
    rust: { kind: 'typecheck', argv: ['cargo', 'check'] },
    java: { kind: 'build', argv: ['javac', '-d', '/tmp/nimbus-javac-output', path] },
    csharp: { kind: 'build', argv: ['dotnet', 'build', '--no-restore'] },
  };
  const command = commands[language];
  return command === undefined
    ? null
    : { checkId, name: `${language} syntax`, ...command, cwd: '.', scope: [path], required: true, fallbackAvailable: language !== 'go' && language !== 'rust' && language !== 'csharp' };
}

export function classifyCheckResult(
  outcome: string,
  exitCode: number | null,
  output: string,
  kind: CheckKind,
): { status: CheckStatus; reason: CheckReason } {
  if (outcome === 'timed_out') return { status: 'timed_out', reason: 'resource_limit' };
  if (outcome === 'cancelled') return { status: 'cancelled', reason: 'cancelled' };
  if (outcome === 'succeeded' && exitCode === 0) return { status: 'passed', reason: 'unknown' };
  if (/not found|is not recognized|no such file or directory/i.test(output)) {
    return { status: 'unavailable', reason: /compiler|gcc|g\+\+|clang|javac/i.test(output) ? 'compiler_missing' : 'runtime_missing' };
  }
  if (/permission denied|operation not permitted|eacces|eperm/i.test(output)) return { status: 'blocked', reason: 'permission_denied' };
  if (/network is unreachable|enotfound|eai_again|connection refused/i.test(output)) return { status: 'blocked', reason: 'network_denied' };
  if (/cannot find module|module not found|missing dependency|no module named/i.test(output)) return { status: 'unavailable', reason: 'dependency_missing' };
  const reason: CheckReason = kind === 'test' ? 'test_failure' : kind === 'lint' ? 'lint_failure' : kind === 'typecheck' ? 'typecheck_failure' : 'build_failure';
  return { status: exitCode === null ? 'errored' : 'failed', reason };
}
