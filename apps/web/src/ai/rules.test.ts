import { describe, expect, it } from 'vitest';
import { ruleState, stateText } from './rules';

// AD-031: what a release means depends on the providers actually set up.
describe('release state with the set-up providers', () => {
  const onlyCloud = { local: [], cloud: ['Ollama Cloud'] };
  const onlyLocal = { local: ['Ollama'], cloud: [] };
  const both = { local: ['Ollama'], cloud: ['Ollama Cloud'] };

  it('without cloud providers the cloud flag does not matter', () => {
    expect(ruleState({ level: 'suggest', cloud: false }, onlyLocal)).toBe('released');
    expect(ruleState({ level: 'suggest', cloud: true }, onlyLocal)).toBe('released');
  });

  it('own network only: reaches the local provider, or nobody when there is none', () => {
    expect(ruleState({ level: 'suggest', cloud: false }, both)).toBe('local');
    expect(ruleState({ level: 'suggest', cloud: false }, onlyCloud)).toBe('ineffective');
    expect(stateText({ level: 'suggest', cloud: false }, onlyCloud)).toContain('Ollama Cloud sieht das nicht');
    expect(ruleState({ level: 'suggest', cloud: true }, onlyCloud)).toBe('released');
  });

  it('a block is a block, whatever the providers', () => {
    for (const kinds of [onlyCloud, onlyLocal, both]) expect(ruleState({ level: 'none', cloud: true }, kinds)).toBe('blocked');
  });
});
