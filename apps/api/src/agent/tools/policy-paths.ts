export const IGNORED_SEGMENTS: readonly string[] = [
  '.git',
  '.hg',
  '.svn',
  'node_modules',
  'bower_components',
  'vendor',
  '.pnpm-store',
  '.yarn',
  '.venv',
  'venv',
  '__pycache__',
  'dist',
  'build',
  'out',
  'coverage',
  '.next',
  '.nuxt',
  '.svelte-kit',
  '.turbo',
  '.cache',
  '.terraform',
  'secrets',
];

export const IGNORED_FILE_PATTERNS: readonly RegExp[] = [
  /^\.env(\..+)?$/,
  /^\.npmrc$/,
  /^\.netrc$/,
  /^id_(rsa|dsa|ecdsa|ed25519)$/,
  /\.(pem|key|p12|pfx|jks|keystore|asc|gpg)$/i,
  /\.min\.(js|css|mjs|cjs)$/i,
  /\.(png|jpe?g|gif|bmp|ico|webp|avif|tiff?|svgz)$/i,
  /\.(pdf|zip|gz|tgz|bz2|xz|7z|rar|jar|war)$/i,
  /\.(woff2?|ttf|otf|eot)$/i,
  /\.(mp3|mp4|mov|avi|mkv|wav|flac|ogg|webm)$/i,
  /\.(so|dylib|dll|exe|bin|o|a|class|pyc|wasm)$/i,
  /\.(sqlite3?|db|mdb)$/i,
  /\.(lock|log)$/i,
];

export const PROTECTED_DIRECTORY_PREFIXES: readonly string[] = [
  '.github/',
  '.circleci/',
  'terraform/',
  'k8s/',
  'helm/',
  'migrations/',
  'secrets/',
  '.git/',
];

export const PROTECTED_EXACT_PATHS: readonly string[] = [
  '.gitlab-ci.yml',
  'azure-pipelines.yml',
  'Jenkinsfile',
  'CODEOWNERS',
  '.github/CODEOWNERS',
  'docs/CODEOWNERS',
  '.dockerignore',
  'package.json',
  'package-lock.json',
  'pnpm-lock.yaml',
  'yarn.lock',
  '.npmrc',
  '.pnpmfile.cjs',
  'prisma/schema.prisma',
];

export const PROTECTED_FILE_PATTERNS: readonly RegExp[] = [
  /^Dockerfile.*$/,
  /^docker-compose.*\.ya?ml$/,
  /^\.yarnrc.*$/,
  /^\.env(\..+)?$/,
  /\.(pem|key|p12)$/i,
  /\.tfvars?$/i,
];

export const PROTECTED_NAME_WORDS: readonly string[] = [
  'auth',
  'authz',
  'session',
  'crypto',
  'billing',
  'payment',
];

export function pathSegments(path: string): string[] {
  return path.split('/').filter((segment) => segment !== '');
}

export function fileName(path: string): string {
  const segments = pathSegments(path);
  return segments[segments.length - 1] ?? '';
}

export function isIgnoredPath(path: string): boolean {
  const segments = pathSegments(path);

  if (segments.some((segment) => IGNORED_SEGMENTS.includes(segment))) {
    return true;
  }

  const name = fileName(path);
  return IGNORED_FILE_PATTERNS.some((pattern) => pattern.test(name));
}

export function isProtectedPath(path: string): boolean {
  if (PROTECTED_EXACT_PATHS.includes(path)) {
    return true;
  }

  if (PROTECTED_DIRECTORY_PREFIXES.some((prefix) => path.startsWith(prefix))) {
    return true;
  }

  const name = fileName(path);
  if (PROTECTED_FILE_PATTERNS.some((pattern) => pattern.test(name))) {
    return true;
  }

  const lowered = path.toLowerCase();
  return PROTECTED_NAME_WORDS.some((word) => lowered.includes(word));
}
