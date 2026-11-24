// Owner find 24.11.: „Eigenes Emoji“ took any text („testtest“), which then ran over the name in the tree.
import { describe, expect, it } from 'vitest';
import { isEmoji } from './icons';

describe('isEmoji', () => {
  it('takes exactly one emoji, also with modifiers, joiners, flags and keycaps', () => {
    for (const e of ['📘', '🖥️', '❤️', '👍🏽', '👩‍💻', '👨‍👩‍👧‍👦', '🏳️‍🌈', '🇦🇹', '🏴󠁧󠁢󠁥󠁮󠁧󠁿', '1️⃣', '1⃣', '#️⃣', '©️', '↔️', ' 🐳 ']) expect(isEmoji(e), e).toBe(true);
  });
  it('refuses text, two emoji and the empty value', () => {
    for (const e of ['testtest', 'a', '1', '📘📗', '📘 x', '', '  ', 'ab🐳', '🇦', 'a⃣', '⃣', '🐳' + '\u0301'.repeat(20)]) expect(isEmoji(e), e).toBe(false);
  });
});
