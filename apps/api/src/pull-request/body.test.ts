import { describe, expect, it } from 'vitest';

import {
  AI_NOTICE,
  BACKTICK,
  MIN_FENCE,
  buildPullRequestBody,
  failingChecks,
  fenced,
  longestBacktickRun,
} from './body.js';
import { FAILING_CHECKS, PASSING_CHECKS, openRequest } from './pull-request.fixtures.js';

function bodyOf(overrides: Parameters<typeof openRequest>[0] = {}): string {
  const request = openRequest(overrides);

  return buildPullRequestBody({
    task: request.task,
    summary: request.summary,
    branch: request.branch,
    baseCommitSha: request.baseCommitSha,
    report: request.report,
    checks: request.checks,
  });
}

describe('fencing untrusted text', () => {
  it('wraps it so nothing inside is interpreted', () => {
    expect(fenced('hello')).toBe(
      [BACKTICK.repeat(MIN_FENCE), 'hello', BACKTICK.repeat(MIN_FENCE)].join('\n'),
    );
  });

  it('grows the fence past the longest run inside', () => {
    expect(longestBacktickRun(`a${BACKTICK.repeat(4)}b`)).toBe(4);
    expect(fenced(`a${BACKTICK.repeat(4)}b`).startsWith(BACKTICK.repeat(5))).toBe(true);
  });

  it('counts only unbroken runs', () => {
    expect(longestBacktickRun(`${BACKTICK}a${BACKTICK}${BACKTICK}`)).toBe(2);
  });

  it('says something rather than leaving an empty block', () => {
    expect(fenced('   ')).toContain('(nothing was given)');
  });
});

describe('text nobody trusted', () => {
  it('never lets a task mention a real person', () => {
    const body = bodyOf({ task: 'fix @torvalds and be quick' });
    const lines = body.split('\n');
    const mention = lines.findIndex((line) => line.includes('@torvalds'));
    const opening = lines.findIndex((line) => line.startsWith(BACKTICK.repeat(MIN_FENCE)));

    expect(mention).toBeGreaterThan(opening);
    expect(opening).toBeGreaterThan(-1);
  });

  it('never lets a task cross link a real issue', () => {
    const body = bodyOf({ task: 'closes #1' });
    const afterHeading = (body.split('## What was asked')[1] ?? '').trimStart();

    expect(body).toContain('closes #1');
    expect(afterHeading.startsWith(BACKTICK.repeat(MIN_FENCE))).toBe(true);
  });

  it('keeps a summary full of backticks inside a longer fence', () => {
    const summary = `use ${BACKTICK.repeat(3)}code${BACKTICK.repeat(3)} blocks`;
    const body = bodyOf({ summary });

    expect(body).toContain(BACKTICK.repeat(4));
    expect(body).toContain(summary);
  });

  it('does not let html out of the fence', () => {
    const body = bodyOf({ task: '<img src=x onerror=alert(1)>' });
    const afterHeading = body.split('## What was asked')[1] ?? '';

    expect(afterHeading.trimStart().startsWith(BACKTICK.repeat(MIN_FENCE))).toBe(true);
  });
});

describe('failing checks are not hidden', () => {
  it('puts the warning before anything else', () => {
    const body = bodyOf({ checks: FAILING_CHECKS });

    expect(body.startsWith('## Checks did not all pass')).toBe(true);
    expect(body.indexOf('## Checks did not all pass')).toBeLessThan(
      body.indexOf('## What was asked'),
    );
  });

  it('names what failed and what never ran', () => {
    const body = bodyOf({ checks: FAILING_CHECKS });

    expect(body).toContain('test: failed');
    expect(body).toContain('typecheck: did not run');
  });

  it('says nothing at all when everything passed', () => {
    const body = bodyOf({ checks: PASSING_CHECKS });

    expect(body).not.toContain('## Checks did not all pass');
    expect(body.toLowerCase()).not.toContain('all checks passed');
  });

  it('is honest when no checks were run at all', () => {
    expect(bodyOf({ checks: [] })).toContain('- none were run');
  });

  it('picks out every check that is not a pass', () => {
    expect(failingChecks(FAILING_CHECKS)).toHaveLength(2);
    expect(failingChecks(PASSING_CHECKS)).toHaveLength(0);
  });
});

describe('what the body always says', () => {
  it('carries the ai notice', () => {
    expect(bodyOf()).toContain(AI_NOTICE);
    expect(bodyOf({ checks: FAILING_CHECKS })).toContain(AI_NOTICE);
  });

  it('says plainly that nothing was merged', () => {
    expect(bodyOf()).toContain('Nothing has been merged.');
  });

  it('names the branch and the commit it was based on', () => {
    const request = openRequest();

    expect(bodyOf()).toContain(request.branch);
    expect(bodyOf()).toContain(request.baseCommitSha);
  });

  it('lists the files that changed', () => {
    expect(bodyOf()).toContain('modified src/app.ts +1 -1');
  });
});
