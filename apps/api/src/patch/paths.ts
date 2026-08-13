import { pathSegments } from '../agent/tools/policy-paths.js';

export const GIT_DIRECTORY = '.git';
export const SUBMODULE_FILE = '.gitmodules';

const DRIVE_LETTER = /^[A-Za-z]:/;

export function isAbsolutePath(path: string): boolean {
  return path.startsWith('/') || path.startsWith('\\') || DRIVE_LETTER.test(path);
}

export function hasTraversal(path: string): boolean {
  return path.split('/').includes('..') || path.split('\\').includes('..');
}

export function touchesGitDirectory(path: string): boolean {
  return pathSegments(path)[0] === GIT_DIRECTORY;
}

export function isNestedRepository(path: string): boolean {
  const segments = pathSegments(path);
  return segments.indexOf(GIT_DIRECTORY) > 0;
}

export function isSubmoduleFile(path: string): boolean {
  const segments = pathSegments(path);
  return segments[segments.length - 1] === SUBMODULE_FILE;
}
