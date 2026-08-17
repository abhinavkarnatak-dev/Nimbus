import { randomBytes } from 'node:crypto';

import { createTestDatabase, type TestDatabase } from '@nimbus/test-utils';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';

import { ensureDatabaseSchema } from '../../src/db/bootstrap.js';
import { auditEventsCollection } from '../../src/db/models/audit-event.js';
import { providerKeysCollection } from '../../src/db/models/provider-key.js';
import { ApiError } from '../../src/http/api-error.js';
import { SecretBox, SECRET_BOX_KEY_BYTES } from '../../src/lib/secret-box.js';
import { capturingLogger } from '../../src/llm/llm.fixtures.js';
import { ProviderKeyService } from '../../src/llm/provider-keys.js';
import type { ProviderKeyVerifier, VerifiedKey } from '../../src/llm/verify.js';

const OWNER_ID = 'usr_aaaaaaaaaaaaaaaaaaaaa';
const OTHER_ID = 'usr_bbbbbbbbbbbbbbbbbbbbb';

const GEMINI_KEY = `AIza${'k'.repeat(35)}`;
const ALTERNATE_SHAPE_KEY = `AQ.Ab8${'k'.repeat(50)}`;

class FixedVerifier implements ProviderKeyVerifier {
  readonly #verdict: VerifiedKey;

  constructor(verdict: VerifiedKey) {
    this.#verdict = verdict;
  }

  async verify(): Promise<VerifiedKey> {
    return Promise.resolve(this.#verdict);
  }
}

let testDatabase: TestDatabase;

function serviceWith(verifier: ProviderKeyVerifier): ProviderKeyService {
  return new ProviderKeyService({
    db: testDatabase.db,
    box: new SecretBox(randomBytes(SECRET_BOX_KEY_BYTES)),
    verifier,
    logger: capturingLogger().logger,
  });
}

function accepting(): ProviderKeyService {
  return serviceWith(new FixedVerifier({ verdict: 'valid', status: 200 }));
}

async function codeOf(work: Promise<unknown>): Promise<string> {
  try {
    await work;
  } catch (error) {
    return error instanceof ApiError ? error.code : 'NOT_AN_API_ERROR';
  }
  return 'NO_ERROR';
}

beforeAll(async () => {
  testDatabase = await createTestDatabase();
  await ensureDatabaseSchema(testDatabase.db, capturingLogger().logger);
}, 60_000);

beforeEach(async () => {
  await providerKeysCollection(testDatabase.db).deleteMany({});
  await auditEventsCollection(testDatabase.db).deleteMany({});
});

afterAll(async () => {
  await testDatabase.cleanup();
});

describe('saving a provider key, against the real collection', () => {
  it('passes the collection validator', async () => {
    const keys = accepting();
    await keys.save({ userId: OWNER_ID, provider: 'gemini', apiKey: GEMINI_KEY });

    const stored = await providerKeysCollection(testDatabase.db).findOne({ userId: OWNER_ID });

    expect(stored?.provider).toBe('gemini');
    expect(stored?.lastVerifiedAt).toBeInstanceOf(Date);
  });

  it('never writes the key itself into the document', async () => {
    await accepting().save({ userId: OWNER_ID, provider: 'gemini', apiKey: GEMINI_KEY });

    const stored = await providerKeysCollection(testDatabase.db).findOne({ userId: OWNER_ID });

    expect(JSON.stringify(stored)).not.toContain(GEMINI_KEY);
    expect(JSON.stringify(stored)).not.toContain('AIza');
  });

  it('gives the key back only to the account that saved it', async () => {
    const keys = accepting();
    await keys.save({ userId: OWNER_ID, provider: 'gemini', apiKey: GEMINI_KEY });

    expect((await keys.keysFor(OWNER_ID)).get('gemini')).toBe(GEMINI_KEY);
    expect((await keys.keysFor(OTHER_ID)).size).toBe(0);
  });

  it('shows only a hint of the key in what it returns', async () => {
    const listed = await accepting().save({
      userId: OWNER_ID,
      provider: 'gemini',
      apiKey: GEMINI_KEY,
    });

    expect(JSON.stringify(listed)).not.toContain(GEMINI_KEY);
    expect(listed.keys[0]?.hint).toBe(GEMINI_KEY.slice(-4));
  });

  it('replaces the key for a provider rather than keeping two', async () => {
    const keys = accepting();
    const replacement = `AIza${'z'.repeat(35)}`;

    await keys.save({ userId: OWNER_ID, provider: 'gemini', apiKey: GEMINI_KEY });
    const listed = await keys.save({
      userId: OWNER_ID,
      provider: 'gemini',
      apiKey: replacement,
    });

    expect(listed.keys).toHaveLength(1);
    expect((await keys.keysFor(OWNER_ID)).get('gemini')).toBe(replacement);
  });

  it('holds one key per provider at the same time', async () => {
    const keys = accepting();

    const listed = await keys.save({ userId: OWNER_ID, provider: 'gemini', apiKey: GEMINI_KEY });

    expect(listed.keys.map((one) => one.provider)).toEqual(['gemini']);
    expect(await keys.providersFor(OWNER_ID)).toEqual(['gemini']);
  });

  it('ignores a legacy key for a provider Nimbus no longer supports', async () => {
    const keys = accepting();
    await keys.save({ userId: OWNER_ID, provider: 'gemini', apiKey: GEMINI_KEY });

    const saved = await providerKeysCollection(testDatabase.db).findOne({ userId: OWNER_ID });
    expect(saved).not.toBeNull();

    await testDatabase.db.command({
      insert: 'provider_keys',
      documents: [
        {
          ...saved,
          providerKeyId: 'pky_ccccccccccccccccccccc',
          provider: 'groq',
        },
      ],
      bypassDocumentValidation: true,
    });

    expect((await keys.list(OWNER_ID)).keys.map((one) => one.provider)).toEqual(['gemini']);
    expect(await keys.providersFor(OWNER_ID)).toEqual(['gemini']);
  });

  it('keeps the first save when the same key is saved twice at once', async () => {
    const keys = accepting();

    await Promise.all([
      keys.save({ userId: OWNER_ID, provider: 'gemini', apiKey: GEMINI_KEY }),
      keys.save({ userId: OWNER_ID, provider: 'gemini', apiKey: GEMINI_KEY }),
    ]).catch(() => undefined);

    expect(await providerKeysCollection(testDatabase.db).countDocuments({ userId: OWNER_ID })).toBe(
      1,
    );
  });

  it('refuses a key the provider turned down, and stores nothing', async () => {
    const keys = serviceWith(new FixedVerifier({ verdict: 'rejected', status: 401 }));

    expect(
      await codeOf(keys.save({ userId: OWNER_ID, provider: 'gemini', apiKey: GEMINI_KEY })),
    ).toBe('PROVIDER_KEY_INVALID');
    expect(await providerKeysCollection(testDatabase.db).countDocuments({})).toBe(0);
  });

  it('separates a provider that is down from a key that is wrong', async () => {
    const keys = serviceWith(new FixedVerifier({ verdict: 'unreachable', status: null }));

    expect(
      await codeOf(keys.save({ userId: OWNER_ID, provider: 'gemini', apiKey: GEMINI_KEY })),
    ).toBe('PROVIDER_UNAVAILABLE');
  });

  it('refuses a key of the wrong shape before it asks the provider anything', async () => {
    const keys = serviceWith(new FixedVerifier({ verdict: 'valid', status: 200 }));

    expect(
      await codeOf(
        keys.save({ userId: OWNER_ID, provider: 'gemini', apiKey: 'AIzaAIzaAIzaAIzaAIza' }),
      ),
    ).toBe('PROVIDER_KEY_INVALID');
  });

  it('leaves the provider to say whose key it is', async () => {
    const keys = serviceWith(new FixedVerifier({ verdict: 'rejected', status: 401 }));

    expect(
      await codeOf(
        keys.save({ userId: OWNER_ID, provider: 'gemini', apiKey: ALTERNATE_SHAPE_KEY }),
      ),
    ).toBe('PROVIDER_KEY_INVALID');
    expect(await providerKeysCollection(testDatabase.db).countDocuments({})).toBe(0);
  });

  it('writes an audit event that names the provider and never the key', async () => {
    await accepting().save({
      userId: OWNER_ID,
      provider: 'gemini',
      apiKey: GEMINI_KEY,
      ip: '203.0.113.9',
    });

    const written = await auditEventsCollection(testDatabase.db)
      .find({ action: 'provider_key.added' })
      .toArray();

    expect(written).toHaveLength(1);
    expect(written[0]?.metadata['provider']).toBe('gemini');
    expect(JSON.stringify(written)).not.toContain(GEMINI_KEY);
  });
});

describe('removing a provider key', () => {
  it('takes it away and leaves nothing behind', async () => {
    const keys = accepting();
    await keys.save({ userId: OWNER_ID, provider: 'gemini', apiKey: GEMINI_KEY });

    const left = await keys.remove(OWNER_ID, 'gemini');

    expect(left.keys).toEqual([]);
    expect(await providerKeysCollection(testDatabase.db).countDocuments({})).toBe(0);
  });

  it('refuses to remove a key that was never saved', async () => {
    expect(await codeOf(accepting().remove(OWNER_ID, 'gemini'))).toBe('NOT_FOUND');
  });

  it('never lets one account remove the key of another', async () => {
    const keys = accepting();
    await keys.save({ userId: OWNER_ID, provider: 'gemini', apiKey: GEMINI_KEY });

    expect(await codeOf(keys.remove(OTHER_ID, 'gemini'))).toBe('NOT_FOUND');
    expect((await keys.keysFor(OWNER_ID)).get('gemini')).toBe(GEMINI_KEY);
  });
});

describe('a key sealed under a secret that has since changed', () => {
  it('is reported as unusable rather than handed to a provider', async () => {
    const saved = accepting();
    await saved.save({ userId: OWNER_ID, provider: 'gemini', apiKey: GEMINI_KEY });

    const rekeyed = new ProviderKeyService({
      db: testDatabase.db,
      box: new SecretBox(randomBytes(SECRET_BOX_KEY_BYTES)),
      verifier: new FixedVerifier({ verdict: 'valid', status: 200 }),
      logger: capturingLogger().logger,
    });

    expect((await rekeyed.keysFor(OWNER_ID)).size).toBe(0);
    expect((await rekeyed.list(OWNER_ID)).keys).toHaveLength(1);
  });
});
