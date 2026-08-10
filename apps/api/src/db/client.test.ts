import { describe, expect, it } from 'vitest';

import {
  DatabaseNotConnectedError,
  closeDatabase,
  describeMongoUri,
  getDb,
  getMongoClient,
  isDatabaseConnected,
} from './client.js';

describe('describeMongoUri', () => {
  it('keeps host and database for a plain local uri', () => {
    expect(describeMongoUri('mongodb://127.0.0.1:27017/nimbus')).toBe('127.0.0.1:27017/nimbus');
  });

  it('drops the username and password', () => {
    const description = describeMongoUri('mongodb://admin:hunter2@db.example.com:27017/nimbus');
    expect(description).toBe('db.example.com:27017/nimbus');
    expect(description).not.toContain('hunter2');
    expect(description).not.toContain('admin');
  });

  it('drops credentials that contain an at sign', () => {
    const description = describeMongoUri('mongodb://admin:p%40ss@w0rd@db.example.com/nimbus');
    expect(description).toBe('db.example.com/nimbus');
    expect(description).not.toContain('ss@w0rd');
  });

  it('handles the srv scheme', () => {
    expect(describeMongoUri('mongodb+srv://user:secret@cluster0.abcd.mongodb.net/nimbus')).toBe(
      'cluster0.abcd.mongodb.net/nimbus',
    );
  });

  it('drops query string options that can carry secrets', () => {
    const description = describeMongoUri(
      'mongodb://user:secret@host:27017/nimbus?authSource=admin&tlsCertificateKeyFilePassword=abc',
    );
    expect(description).toBe('host:27017/nimbus');
    expect(description).not.toContain('abc');
  });

  it('handles a replica set with several hosts', () => {
    expect(describeMongoUri('mongodb://user:secret@a:27017,b:27017,c:27017/nimbus')).toBe(
      'a:27017,b:27017,c:27017/nimbus',
    );
  });

  it('handles a uri with no database name', () => {
    expect(describeMongoUri('mongodb://127.0.0.1:27017')).toBe('127.0.0.1:27017');
  });

  it('never throws on unparseable input', () => {
    expect(describeMongoUri('')).toBe('unknown-host');
    expect(describeMongoUri('mongodb://')).toBe('unknown-host');
  });
});

describe('connection accessors before connecting', () => {
  it('reports not connected', () => {
    expect(isDatabaseConnected()).toBe(false);
  });

  it('throws a named error from getDb instead of returning undefined', () => {
    expect(() => getDb()).toThrow(DatabaseNotConnectedError);
  });

  it('throws a named error from getMongoClient', () => {
    expect(() => getMongoClient()).toThrow(DatabaseNotConnectedError);
  });

  it('closes without error when nothing was ever opened', async () => {
    await expect(closeDatabase()).resolves.toBeUndefined();
  });
});
