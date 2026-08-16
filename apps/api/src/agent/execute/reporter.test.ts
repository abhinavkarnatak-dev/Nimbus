import { LIMITS } from '@nimbus/contracts';
import { describe, expect, it } from 'vitest';

import { reportedStreams } from './executor.js';
import { EXECUTE_LIMITS } from './limits.js';
import { chunkOutput } from './reporter.js';

describe('cutting output into pieces a socket can carry', () => {
  it('sends nothing at all for nothing at all', () => {
    expect(chunkOutput('')).toEqual([]);
  });

  it('sends one piece when it fits', () => {
    expect(chunkOutput('two tests passed')).toEqual([
      { chunk: 'two tests passed', truncated: false },
    ]);
  });

  it('never sends a piece bigger than the contract allows', () => {
    const pieces = chunkOutput('x'.repeat(LIMITS.toolOutputChunkMaxChars * 2 + 10));

    for (const piece of pieces) {
      expect(piece.chunk.length).toBeLessThanOrEqual(LIMITS.toolOutputChunkMaxChars);
    }
  });

  it('puts the pieces back together exactly as they came', () => {
    const text = Array.from({ length: 2_000 }, (_one, at) => `line ${String(at)}`).join('\n');
    const pieces = chunkOutput(text);

    expect(text.length).toBeLessThan(EXECUTE_LIMITS.reportedOutputMaxChars);
    expect(pieces.length).toBeGreaterThan(1);
    expect(pieces.map((piece) => piece.chunk).join('')).toBe(text);
  });

  it('stops at the total cap rather than flooding a browser', () => {
    const pieces = chunkOutput('y'.repeat(EXECUTE_LIMITS.reportedOutputMaxChars * 3));
    const total = pieces.reduce((sum, piece) => sum + piece.chunk.length, 0);

    expect(total).toBe(EXECUTE_LIMITS.reportedOutputMaxChars);
  });

  it('says so on the last piece when it had to cut', () => {
    const pieces = chunkOutput('y'.repeat(EXECUTE_LIMITS.reportedOutputMaxChars + 1));

    expect(pieces[pieces.length - 1]?.truncated).toBe(true);
    expect(pieces.slice(0, -1).every((piece) => !piece.truncated)).toBe(true);
  });

  it('says nothing was cut when nothing was', () => {
    expect(chunkOutput('short').every((piece) => !piece.truncated)).toBe(true);
  });
});

describe('telling stdout from stderr', () => {
  it('sends a tool that only has text as stdout, because that is all it is', () => {
    expect(reportedStreams({ summary: 'read', text: 'the file contents' })).toEqual([
      { stream: 'stdout', text: 'the file contents' },
    ]);
  });

  it('sends nothing for a tool that returned nothing to show', () => {
    expect(reportedStreams({ summary: 'done' })).toEqual([]);
    expect(reportedStreams({ summary: 'done', text: '' })).toEqual([]);
  });

  it('keeps a command two streams apart, in the order a terminal shows them', () => {
    expect(
      reportedStreams({ summary: 'ran', text: 'outbad', stdout: 'out', stderr: 'bad' }),
    ).toEqual([
      { stream: 'stdout', text: 'out' },
      { stream: 'stderr', text: 'bad' },
    ]);
  });

  it('sends only stderr when a command wrote only to stderr', () => {
    expect(reportedStreams({ summary: 'ran', text: 'bad', stdout: '', stderr: 'bad' })).toEqual([
      { stream: 'stderr', text: 'bad' },
    ]);
  });

  it('prefers what the command reported over the blob the model reads', () => {
    const sent = reportedStreams({
      summary: 'ran',
      text: 'outbad',
      stdout: 'out',
      stderr: 'bad',
    });

    expect(sent.map((one) => one.text)).not.toContain('outbad');
  });
});
