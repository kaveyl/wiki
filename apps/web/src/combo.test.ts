import { describe, expect, it } from 'vitest';
import { comboShown, comboStep } from './combo';

const models = ['gpt-oss:120b', 'gpt-oss:20b', 'llama3.3', 'qwen3-coder'];

describe('ComboInput suggestions', () => {
  it('lists all suggestions when opened by its button or arrow key, even with a value set', () => {
    expect(comboShown(models, 'gpt-oss:120b', false)).toEqual(models);
    expect(comboShown(models, '', false)).toEqual(models);
  });

  it('filters by the typed text, case-insensitive, anywhere in the entry', () => {
    expect(comboShown(models, 'OSS', true)).toEqual(['gpt-oss:120b', 'gpt-oss:20b']);
    expect(comboShown(models, ' coder ', true)).toEqual(['qwen3-coder']);
    expect(comboShown(models, '', true)).toEqual(models);
  });

  it('offers nothing when the only match is the typed text itself, or nothing matches (free text stays)', () => {
    expect(comboShown(models, 'LLAMA3.3', true)).toEqual([]);
    expect(comboShown(models, 'mistral', true)).toEqual([]);
    expect(comboShown(['pkm', 'pkm-alt'], 'pkm', true)).toEqual(['pkm', 'pkm-alt']);
  });

  it('moves the highlight with ↓/↑, wrapping around; nothing to move in an empty list', () => {
    expect(comboStep(-1, 4, 1)).toBe(0);
    expect(comboStep(-1, 4, -1)).toBe(3);
    expect(comboStep(0, 4, 1)).toBe(1);
    expect(comboStep(3, 4, 1)).toBe(0);
    expect(comboStep(0, 4, -1)).toBe(3);
    expect(comboStep(7, 4, 1)).toBe(0);
    expect(comboStep(2, 0, 1)).toBe(-1);
  });
});
