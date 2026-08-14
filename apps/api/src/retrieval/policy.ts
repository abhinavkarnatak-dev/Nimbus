import { fileName, isIgnoredPath, pathSegments } from '../agent/tools/policy-paths.js';

export const SECRET_NAME_WORDS: readonly string[] = [
  'secret',
  'secrets',
  'credential',
  'credentials',
  'password',
  'passwords',
  'passwd',
  'htpasswd',
  'token',
  'tokens',
  'apikey',
  'apikeys',
  'accesskey',
  'accesskeys',
  'privatekey',
  'privatekeys',
  'keystore',
  'keyring',
  'serviceaccount',
];

export const SECRET_DIRECTORY_SEGMENTS: readonly string[] = [
  '.ssh',
  '.aws',
  '.gnupg',
  '.gpg',
  '.kube',
  '.docker',
  '.azure',
  '.gcloud',
];

export const SECRET_EXACT_NAMES: readonly string[] = [
  'credentials',
  'authorized_keys',
  'known_hosts',
  'shadow',
  'htpasswd',
  '.netrc',
  '.pgpass',
  '.git-credentials',
];

export const SOURCE_EXTENSIONS: readonly string[] = [
  'ts',
  'tsx',
  'js',
  'jsx',
  'mjs',
  'cjs',
  'py',
  'go',
  'rs',
  'java',
  'kt',
  'kts',
  'rb',
  'php',
  'cs',
  'c',
  'h',
  'cc',
  'cpp',
  'hpp',
  'swift',
  'scala',
  'sql',
  'vue',
  'svelte',
  'ex',
  'exs',
  'dart',
  'lua',
  'r',
  'md',
];

const NOT_WORD = /[^a-z0-9]+/;

export function nameWords(name: string): string[] {
  const spaced = name
    .replace(/([a-z0-9])([A-Z])/g, '$1 $2')
    .replace(/([A-Z]+)([A-Z][a-z])/g, '$1 $2')
    .replace(/([a-zA-Z])([0-9])/g, '$1 $2')
    .toLowerCase();

  return spaced.split(NOT_WORD).filter((word) => word !== '');
}

export function nameTokens(name: string): string[] {
  const words = nameWords(name);
  const tokens = [...words];

  for (let index = 0; index + 1 < words.length; index += 1) {
    tokens.push(`${words[index] ?? ''}${words[index + 1] ?? ''}`);
  }
  return tokens;
}

export function extensionOf(path: string): string {
  const name = fileName(path);
  const dot = name.lastIndexOf('.');

  if (dot <= 0 || dot === name.length - 1) {
    return '';
  }
  return name.slice(dot + 1).toLowerCase();
}

export function isSourceFile(path: string): boolean {
  return SOURCE_EXTENSIONS.includes(extensionOf(path));
}

export function isSecretLikePath(path: string): boolean {
  const segments = pathSegments(path);
  const directories = segments.slice(0, -1);

  if (directories.some((segment) => SECRET_DIRECTORY_SEGMENTS.includes(segment.toLowerCase()))) {
    return true;
  }

  const name = fileName(path);

  if (SECRET_EXACT_NAMES.includes(name.toLowerCase())) {
    return true;
  }

  if (isSourceFile(path)) {
    return false;
  }

  const tokens = new Set([
    ...nameTokens(name),
    ...directories.flatMap((segment) => nameTokens(segment)),
  ]);
  return SECRET_NAME_WORDS.some((word) => tokens.has(word));
}

export function isRetrievablePath(path: string): boolean {
  return !isIgnoredPath(path) && !isSecretLikePath(path);
}
