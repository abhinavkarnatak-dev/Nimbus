import { describe, expect, it } from 'vitest';

import { InFlight } from './in-flight.js';

interface Gate {
  wait: Promise<void>;
  open: () => void;
}

function gate(): Gate {
  let open: () => void = () => undefined;

  const wait = new Promise<void>((resolve) => {
    open = resolve;
  });

  return { wait, open };
}

describe('running one thing at a time', () => {
  it('runs the work and gives back what it answered', async () => {
    const flight = new InFlight();

    expect(await flight.run(async () => Promise.resolve('done'))).toBe('done');
  });

  it('refuses a second start while the first is still going', async () => {
    const flight = new InFlight();
    const held = gate();

    const first = flight.run(async () => {
      await held.wait;
      return 'first';
    });
    const second = await flight.run(async () => Promise.resolve('second'));

    held.open();

    expect(second).toBeNull();
    expect(await first).toBe('first');
  });

  it('runs again once the one before it finished', async () => {
    const flight = new InFlight();

    await flight.run(async () => Promise.resolve('first'));

    expect(await flight.run(async () => Promise.resolve('second'))).toBe('second');
  });

  it('says whether it is busy', async () => {
    const flight = new InFlight();
    const held = gate();

    const running = flight.run(async () => held.wait);

    expect(flight.busy).toBe(true);

    held.open();
    await running;

    expect(flight.busy).toBe(false);
  });
});

describe('settling', () => {
  it('waits for the work that is already going', async () => {
    const flight = new InFlight();
    const held = gate();
    let finished = false;

    const running = flight.run(async () => {
      await held.wait;
      finished = true;
    });

    const settling = flight.settle();
    held.open();
    await settling;

    expect(finished).toBe(true);
    await running;
  });

  it('returns at once when nothing is going', async () => {
    const flight = new InFlight();

    await expect(flight.settle()).resolves.toBeUndefined();
  });

  it('refuses new work afterwards, so nothing starts during a shutdown', async () => {
    const flight = new InFlight();
    await flight.settle();

    expect(await flight.run(async () => Promise.resolve('late'))).toBeNull();
    expect(flight.closed).toBe(true);
  });

  it('refuses work that starts asking after settling began', async () => {
    const flight = new InFlight();
    const held = gate();

    const running = flight.run(async () => held.wait);
    const settling = flight.settle();

    expect(await flight.run(async () => Promise.resolve('late'))).toBeNull();

    held.open();
    await settling;
    await running;
  });

  it('is harmless twice', async () => {
    const flight = new InFlight();

    await flight.settle();
    await expect(flight.settle()).resolves.toBeUndefined();
  });
});

describe('work that fails', () => {
  it('does not leave it busy forever', async () => {
    const flight = new InFlight();

    await expect(flight.run(async () => Promise.reject(new Error('no')))).rejects.toThrow('no');
    expect(flight.busy).toBe(false);
  });

  it('still lets a settle finish rather than hanging a shutdown', async () => {
    const flight = new InFlight();
    const held = gate();

    const running = flight.run(async () => {
      await held.wait;
      throw new Error('no');
    });

    const settling = flight.settle();
    held.open();

    await expect(running).rejects.toThrow('no');
    await expect(settling).resolves.toBeUndefined();
  });

  it('lets the next one run once it has failed', async () => {
    const flight = new InFlight();

    await expect(flight.run(async () => Promise.reject(new Error('no')))).rejects.toThrow('no');

    expect(await flight.run(async () => Promise.resolve('after'))).toBe('after');
  });
});
