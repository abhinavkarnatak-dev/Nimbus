import { describe, expect, it } from 'vitest';

import { LIMITS } from './limits.js';
import {
  MAX_ARGUMENTS_CHARS,
  MAX_INTENT_CHARS,
  NextActionSchema,
  NextActionWireSchema,
  SCOPE_OUTCOMES,
  ScopeResultSchema,
  ScopeVerdictSchema,
} from './reasoning.js';

const ACTION = {
  intent: 'Read the redirect helper to see where it sends people.',
  tool: 'read_file',
  toolArguments: { path: 'src/auth/redirect.ts' },
};

describe('NextActionSchema', () => {
  it('accepts one well formed action', () => {
    expect(NextActionSchema.parse(ACTION)).toEqual(ACTION);
  });

  it('refuses a tool that is not one of the known names', () => {
    expect(NextActionSchema.safeParse({ ...ACTION, tool: 'push_branch' }).success).toBe(false);
  });

  it('accepts a name that is defined but not yet built, leaving that to the registry', () => {
    expect(NextActionSchema.safeParse({ ...ACTION, tool: 'semantic_search' }).success).toBe(true);
  });

  it('refuses an action with no reason given', () => {
    expect(NextActionSchema.safeParse({ ...ACTION, intent: '' }).success).toBe(false);
  });

  it('refuses an intent longer than a user would read', () => {
    const long = 'a'.repeat(MAX_INTENT_CHARS + 1);

    expect(NextActionSchema.safeParse({ ...ACTION, intent: long }).success).toBe(false);
  });

  it('refuses a second action smuggled in beside the first', () => {
    expect(NextActionSchema.safeParse({ ...ACTION, then: { tool: 'run_command' } }).success).toBe(
      false,
    );
  });

  it('refuses arguments that are not an object', () => {
    expect(NextActionSchema.safeParse({ ...ACTION, toolArguments: 'path=a.ts' }).success).toBe(
      false,
    );
  });

  it('refuses an arguments object too large to be a real call', () => {
    const huge = { contents: 'a'.repeat(MAX_ARGUMENTS_CHARS + 1) };

    expect(NextActionSchema.safeParse({ ...ACTION, toolArguments: huge }).success).toBe(false);
  });

  it('accepts an arguments object right at the limit', () => {
    const contents = 'a'.repeat(MAX_ARGUMENTS_CHARS - 20);
    const parsed = NextActionSchema.safeParse({ ...ACTION, toolArguments: { contents } });

    expect(parsed.success).toBe(true);
  });

  it('leaves the arguments alone, because the tool checks them itself', () => {
    const parsed = NextActionSchema.parse({
      ...ACTION,
      toolArguments: { path: 'a.ts', nested: { deep: [1, 2] } },
    });

    expect(parsed.toolArguments).toEqual({ path: 'a.ts', nested: { deep: [1, 2] } });
  });
});

describe('NextActionWireSchema', () => {
  const WIRE = {
    intent: ACTION.intent,
    tool: ACTION.tool,
    toolArgumentsJson: JSON.stringify(ACTION.toolArguments),
  };

  it('accepts one action with the arguments written out as a string', () => {
    expect(NextActionWireSchema.parse(WIRE)).toEqual(WIRE);
  });

  it('takes the arguments only as a string, because a strict provider cannot send an object', () => {
    expect(
      NextActionWireSchema.safeParse({ ...WIRE, toolArgumentsJson: { path: 'a.ts' } }).success,
    ).toBe(false);
  });

  it('does not read the string, leaving that to the node that calls the tool', () => {
    const parsed = NextActionWireSchema.safeParse({ ...WIRE, toolArgumentsJson: 'not json' });

    expect(parsed.success).toBe(true);
  });

  it('refuses a written out arguments string too large to be a real call', () => {
    const long = 'a'.repeat(MAX_ARGUMENTS_CHARS + 1);

    expect(NextActionWireSchema.safeParse({ ...WIRE, toolArgumentsJson: long }).success).toBe(
      false,
    );
  });

  it('holds the same intent and tool rules as the action it becomes', () => {
    expect(NextActionWireSchema.safeParse({ ...WIRE, intent: '' }).success).toBe(false);
    expect(NextActionWireSchema.safeParse({ ...WIRE, tool: 'push_branch' }).success).toBe(false);
  });

  it('refuses a field the model adds of its own', () => {
    expect(NextActionWireSchema.safeParse({ ...WIRE, toolArguments: {} }).success).toBe(false);
  });
});

describe('ScopeVerdictSchema', () => {
  it('accepts a clear verdict with no question', () => {
    expect(ScopeVerdictSchema.parse({ clear: true, question: '' }).clear).toBe(true);
  });

  it('accepts an unclear verdict with a question', () => {
    const verdict = { clear: false, question: 'Which page should people land on?' };

    expect(ScopeVerdictSchema.parse(verdict).question).toBe(verdict.question);
  });

  it('refuses a question longer than a message', () => {
    const long = 'a'.repeat(LIMITS.messageMaxChars + 1);

    expect(ScopeVerdictSchema.safeParse({ clear: false, question: long }).success).toBe(false);
  });

  it('refuses anything the model adds of its own', () => {
    const verdict = { clear: false, question: 'why?', confidence: 0.4 };

    expect(ScopeVerdictSchema.safeParse(verdict).success).toBe(false);
  });

  it('needs both fields, so a missing verdict is never read as clear', () => {
    expect(ScopeVerdictSchema.safeParse({ question: 'why?' }).success).toBe(false);
  });
});

describe('ScopeResultSchema', () => {
  it('accepts every outcome the nodes can produce', () => {
    for (const outcome of SCOPE_OUTCOMES) {
      const result = { outcome, question: null, reason: 'because', askedModel: false };

      expect(ScopeResultSchema.safeParse(result).success).toBe(true);
    }
  });

  it('refuses an outcome nobody defined', () => {
    const result = { outcome: 'maybe', question: null, reason: 'because', askedModel: false };

    expect(ScopeResultSchema.safeParse(result).success).toBe(false);
  });

  it('always carries a reason, so a user can be told why', () => {
    const result = { outcome: 'clear', question: null, reason: '', askedModel: false };

    expect(ScopeResultSchema.safeParse(result).success).toBe(false);
  });

  it('lets the question be absent rather than empty', () => {
    const result = {
      outcome: 'clear',
      question: null,
      reason: 'it names a file',
      askedModel: true,
    };

    expect(ScopeResultSchema.parse(result).question).toBeNull();
  });
});
