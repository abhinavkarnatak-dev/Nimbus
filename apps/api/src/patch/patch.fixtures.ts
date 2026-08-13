export const BASE_SHA = 'a1b2c3d4e5f60718293a4b5c6d7e8f9012345678';
export const OTHER_SHA = '0123456789abcdef0123456789abcdef01234567';

export function editDiff(path = 'src/app.ts'): string {
  return [
    `diff --git a/${path} b/${path}`,
    'index 83db48f..bf269f4 100644',
    `--- a/${path}`,
    `+++ b/${path}`,
    '@@ -1,2 +1,2 @@',
    ' const a = 1;',
    '-const b = 2;',
    '+const b = 3;',
    '',
  ].join('\n');
}

export function addDiff(path = 'src/new.ts', body = 'export const c = 4;'): string {
  return [
    `diff --git a/${path} b/${path}`,
    'new file mode 100644',
    'index 0000000..1234567',
    '--- /dev/null',
    `+++ b/${path}`,
    '@@ -0,0 +1 @@',
    `+${body}`,
    '',
  ].join('\n');
}

export function deleteDiff(path = 'src/old.ts'): string {
  return [
    `diff --git a/${path} b/${path}`,
    'deleted file mode 100644',
    'index 1234567..0000000',
    `--- a/${path}`,
    '+++ /dev/null',
    '@@ -1 +0,0 @@',
    '-export const d = 5;',
    '',
  ].join('\n');
}

export function renameDiff(from = 'src/old.ts', to = 'src/new.ts'): string {
  return [
    `diff --git a/${from} b/${to}`,
    'similarity index 100%',
    `rename from ${from}`,
    `rename to ${to}`,
    '',
  ].join('\n');
}

export function symlinkDiff(path = 'link', target = '/etc/passwd'): string {
  return [
    `diff --git a/${path} b/${path}`,
    'new file mode 120000',
    'index 0000000..1234567',
    '--- /dev/null',
    `+++ b/${path}`,
    '@@ -0,0 +1 @@',
    `+${target}`,
    '\\ No newline at end of file',
    '',
  ].join('\n');
}

export function submoduleDiff(path = 'vendor/lib'): string {
  return [
    `diff --git a/${path} b/${path}`,
    'new file mode 160000',
    'index 0000000..abc1234',
    '--- /dev/null',
    `+++ b/${path}`,
    '@@ -0,0 +1 @@',
    '+Subproject commit abc1234def5678901234567890abcdef12345678',
    '',
  ].join('\n');
}

export function binaryDiff(path = 'logo.png'): string {
  return [
    `diff --git a/${path} b/${path}`,
    'index 1234567..89abcde 100644',
    `Binary files a/${path} and b/${path} differ`,
    '',
  ].join('\n');
}

export function binaryPatchDiff(path = 'logo.png'): string {
  return [
    `diff --git a/${path} b/${path}`,
    'index 1234567..89abcde 100644',
    'GIT binary patch',
    '',
  ].join('\n');
}

export function modeChangeDiff(path = 'run.sh'): string {
  return [`diff --git a/${path} b/${path}`, 'old mode 100644', 'new mode 100755', ''].join('\n');
}

export function manyFiles(count: number): string {
  return Array.from({ length: count }, (_unused, index) =>
    editDiff(`src/file${String(index)}.ts`),
  ).join('');
}

export function manyLines(count: number): string {
  const added = Array.from({ length: count }, (_unused, index) => `+line ${String(index)}`);
  return [
    'diff --git a/src/big.ts b/src/big.ts',
    'new file mode 100644',
    'index 0000000..1234567',
    '--- /dev/null',
    '+++ b/src/big.ts',
    `@@ -0,0 +1,${String(count)} @@`,
    ...added,
    '',
  ].join('\n');
}

export function removedLineDiff(path: string, removed: string): string {
  return [
    `diff --git a/${path} b/${path}`,
    'index 83db48f..bf269f4 100644',
    `--- a/${path}`,
    `+++ b/${path}`,
    '@@ -1,2 +1,1 @@',
    ' const a = 1;',
    `-${removed}`,
    '',
  ].join('\n');
}
