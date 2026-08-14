import { describe, expect, it } from 'vitest';

import {
  extensionOf,
  isRetrievablePath,
  isSecretLikePath,
  isSourceFile,
  nameWords,
} from './policy.js';

describe('nameWords', () => {
  it.each([
    ['a plain name', 'login', ['login']],
    ['a dotted name', 'credentials.json', ['credentials', 'json']],
    ['camel case', 'accessToken', ['access', 'token']],
    ['a leading acronym', 'AWSCredentials', ['aws', 'credentials']],
    ['snake case', 'api_key', ['api', 'key']],
    ['kebab case', 'service-account', ['service', 'account']],
    ['a trailing number', 'secret2', ['secret', '2']],
    ['one long word', 'tokenizer', ['tokenizer']],
  ])('splits %s', (_label, name, expected) => {
    expect(nameWords(name)).toEqual(expected);
  });
});

describe('extensionOf', () => {
  it.each([
    ['a source file', 'src/index.ts', 'ts'],
    ['an upper case extension', 'README.MD', 'md'],
    ['no extension', 'Makefile', ''],
    ['a dotfile with no extension', '.gitignore', ''],
    ['a dotfile with an extension', '.eslintrc.json', 'json'],
    ['a trailing dot', 'weird.', ''],
  ])('reads the extension of %s', (_label, path, expected) => {
    expect(extensionOf(path)).toBe(expected);
  });
});

describe('isSecretLikePath', () => {
  it.each([
    ['a credentials file', 'credentials.json'],
    ['a secrets file outside a secrets folder', 'config/secrets.yml'],
    ['a password list', 'ops/passwords.txt'],
    ['an api key file', 'deploy/apiKeys.json'],
    ['an access key file', 'infra/access_key.txt'],
    ['a token dump', 'tmp/tokens.txt'],
    ['an ssh directory', '.ssh/config'],
    ['an aws directory', '.aws/config'],
    ['a gnupg directory', '.gnupg/pubring.kbx'],
    ['a kube config', '.kube/config'],
    ['a docker config', '.docker/config.json'],
    ['a bare credentials file', 'home/credentials'],
    ['authorized keys', 'authorized_keys'],
    ['a netrc', '.netrc'],
    ['a pgpass', '.pgpass'],
    ['git credentials', '.git-credentials'],
    ['a service account key', 'deploy/service-account.json'],
    ['a keystore description', 'android/keystore.properties'],
    ['a directory named after credentials', 'credentials/production.yml'],
  ])('keeps out %s', (_label, path) => {
    expect(isSecretLikePath(path)).toBe(true);
  });

  it.each([
    ['a tokenizer, because token is not a whole word there', 'src/parser/tokenizer.ts'],
    ['a token stream module', 'src/parser/token-stream.ts'],
    ['a module about tokens', 'src/auth/token.ts'],
    ['a module about credentials', 'src/auth/credentials.ts'],
    ['a module inside a credentials folder', 'src/credentials/manager.ts'],
    ['a document about secrets', 'docs/secret-handling.md'],
    ['ordinary source', 'src/index.ts'],
    ['a readme', 'README.md'],
    ['a word that merely contains secret', 'src/secretarial.json'],
    ['a docker compose file, which is not the docker home directory', 'docker/compose.yml'],
  ])('allows %s', (_label, path) => {
    expect(isSecretLikePath(path)).toBe(false);
  });
});

describe('isSourceFile', () => {
  it('treats code and markdown as source', () => {
    expect(isSourceFile('src/a.ts')).toBe(true);
    expect(isSourceFile('src/a.py')).toBe(true);
    expect(isSourceFile('docs/a.md')).toBe(true);
  });

  it('does not treat data as source', () => {
    expect(isSourceFile('a.json')).toBe(false);
    expect(isSourceFile('a.yml')).toBe(false);
    expect(isSourceFile('a.txt')).toBe(false);
  });
});

describe('isRetrievablePath', () => {
  it('applies the ignore policy from the file tools', () => {
    expect(isRetrievablePath('node_modules/left-pad/index.js')).toBe(false);
    expect(isRetrievablePath('.env')).toBe(false);
    expect(isRetrievablePath('dist/bundle.js')).toBe(false);
    expect(isRetrievablePath('assets/logo.png')).toBe(false);
  });

  it('applies the secret policy on top of it', () => {
    expect(isRetrievablePath('credentials.json')).toBe(false);
    expect(isRetrievablePath('config/secrets.yml')).toBe(false);
  });

  it('allows ordinary source', () => {
    expect(isRetrievablePath('src/auth/login.ts')).toBe(true);
    expect(isRetrievablePath('README.md')).toBe(true);
  });
});
