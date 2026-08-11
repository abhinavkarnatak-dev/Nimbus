import { describe, expect, it } from 'vitest';

import { fileName, isIgnoredPath, isProtectedPath, pathSegments } from './policy-paths.js';

describe('isIgnoredPath', () => {
  it.each([
    ['the git directory', '.git/config'],
    ['dependencies', 'node_modules/react/index.js'],
    ['a vendored directory', 'vendor/lib/thing.go'],
    ['build output', 'dist/bundle.js'],
    ['a next build', '.next/server/page.js'],
    ['coverage', 'coverage/lcov.info'],
    ['a python cache', 'src/__pycache__/thing.pyc'],
    ['an environment file', '.env'],
    ['an environment file with a suffix', '.env.production'],
    ['an npm config that can hold a token', '.npmrc'],
    ['a private key', 'deploy.pem'],
    ['an ssh key', 'id_rsa'],
    ['an image', 'assets/logo.png'],
    ['a font', 'assets/font.woff2'],
    ['an archive', 'release.zip'],
    ['a compiled library', 'native.so'],
    ['a database file', 'local.sqlite3'],
    ['a minified bundle', 'public/app.min.js'],
    ['a secrets folder', 'secrets/production.yml'],
  ])('ignores %s', (_label, path) => {
    expect(isIgnoredPath(path)).toBe(true);
  });

  it.each([
    ['ordinary source', 'src/index.ts'],
    ['a readme', 'README.md'],
    ['a manifest, which is protected but readable', 'package.json'],
    ['a lock file in yaml, which is readable', 'pnpm-lock.yaml'],
    ['a workflow, which is protected but readable', '.github/workflows/ci.yml'],
    ['a file that merely mentions dist', 'src/distance.ts'],
    ['a file that merely mentions env', 'src/environment.ts'],
  ])('does not ignore %s', (_label, path) => {
    expect(isIgnoredPath(path)).toBe(false);
  });
});

describe('isProtectedPath', () => {
  it.each([
    ['anything in the github folder', '.github/workflows/ci.yml'],
    ['a gitlab pipeline', '.gitlab-ci.yml'],
    ['a circleci config', '.circleci/config.yml'],
    ['a jenkins file', 'Jenkinsfile'],
    ['code owners', 'CODEOWNERS'],
    ['a dockerfile', 'Dockerfile'],
    ['a dockerfile with a suffix', 'Dockerfile.production'],
    ['a compose file', 'docker-compose.yml'],
    ['the manifest', 'package.json'],
    ['a lock file', 'pnpm-lock.yaml'],
    ['an npm config', '.npmrc'],
    ['an environment file', '.env.local'],
    ['a private key', 'certs/server.key'],
    ['terraform', 'terraform/main.tf'],
    ['a terraform variables file', 'vars.tfvars'],
    ['kubernetes', 'k8s/deployment.yml'],
    ['a database migration', 'migrations/001_init.sql'],
    ['a prisma schema', 'prisma/schema.prisma'],
    ['anything about authentication', 'src/auth/login.ts'],
    ['a longer authentication word', 'src/authentication.ts'],
    ['an oauth file, where auth is not at a word boundary', 'src/oauth-callback.ts'],
    ['a plural session file', 'src/sessions.ts'],
    ['anything about billing', 'app/billing/invoice.ts'],
    ['plural payments', 'lib/payments.ts'],
    ['anything about crypto', 'util/crypto.ts'],
  ])('protects %s', (_label, path) => {
    expect(isProtectedPath(path)).toBe(true);
  });

  it.each([
    ['ordinary source', 'src/index.ts'],
    ['a readme', 'README.md'],
    ['a test', 'src/greet.test.ts'],
    ['a component', 'src/components/Button.tsx'],
  ])('does not protect %s', (_label, path) => {
    expect(isProtectedPath(path)).toBe(false);
  });

  it('flags a word that merely contains a protected one, which is the safe direction', () => {
    expect(isProtectedPath('src/authorship.ts')).toBe(true);
    expect(isProtectedPath('src/obsession.ts')).toBe(true);
  });

  it('treats reading and changing differently, which is the point of the list', () => {
    expect(isProtectedPath('package.json')).toBe(true);
    expect(isIgnoredPath('package.json')).toBe(false);
  });
});

describe('path helpers', () => {
  it('splits a path and drops empty pieces', () => {
    expect(pathSegments('src//index.ts')).toEqual(['src', 'index.ts']);
  });

  it('takes the last piece as the file name', () => {
    expect(fileName('src/deep/thing.ts')).toBe('thing.ts');
    expect(fileName('thing.ts')).toBe('thing.ts');
  });
});
