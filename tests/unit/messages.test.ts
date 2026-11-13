import { describe, expect, it } from 'vitest';
import { MESSAGES, NEXT_VERBS } from '../../src/app/messages';

const imperative = new RegExp(`^(?:${NEXT_VERBS.join('|')})\\b|^\x60[^\x60]+\x60`);

describe('message contract', () => {
  for (const [id, message] of Object.entries(MESSAGES)) {
    it(`${id} explains the problem and the next action`, () => {
      for (const field of [message.what, message.next]) {
        expect(field.trim()).not.toBe('');
      }
      expect(message.next).toMatch(imperative);
    });
  }
});
