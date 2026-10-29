import { describe, expect, it } from 'vitest';
import { fill, langFromHeader, matchLanguage, messageTranslator, placeholders, translate } from './i18n.js';

describe('i18n', () => {
  it('picks the first supported browser language, else English', () => {
    expect(matchLanguage(['de-AT', 'en'])).toBe('de');
    expect(matchLanguage(['fr-FR', 'en-US'])).toBe('en');
    expect(matchLanguage(['fr-FR'])).toBe('en');
    expect(matchLanguage([])).toBe('en');
  });

  it('reads Accept-Language with weights', () => {
    expect(langFromHeader('fr-CH, de;q=0.8, en;q=0.9')).toBe('en');
    expect(langFromHeader('de-DE,de;q=0.9')).toBe('de');
    expect(langFromHeader('fr')).toBeUndefined();
    expect(langFromHeader(undefined)).toBeUndefined();
  });

  it('fills only known placeholders', () => {
    expect(fill('{n} Notizen in {name}', { n: 3, name: 'Wiki' })).toBe('3 Notizen in Wiki');
    expect(fill('Vorlage {{date}} und {x}', {})).toBe('Vorlage {{date}} und {x}');
    expect(placeholders('{b} und {a}')).toEqual(['a', 'b']);
  });

  it('translates or keeps the German text', () => {
    const dict = { 'Quelle „{name}“ löschen?': 'Delete source “{name}”?' };
    expect(translate(dict, 'Quelle „{name}“ löschen?', { name: 'Wiki' })).toBe('Delete source “Wiki”?');
    expect(translate(dict, 'Unbekannt')).toBe('Unbekannt');
    expect(translate(undefined, 'Hallo {x}', { x: 1 })).toBe('Hallo 1');
  });

  it('a context before „::“ tells words apart that German writes alike (Benutzer = user / users)', () => {
    const dict = { 'Rolle::Benutzer': 'User', Benutzer: 'Users' };
    expect(translate(dict, 'Rolle::Benutzer')).toBe('User');
    expect(translate(dict, 'Benutzer')).toBe('Users');
    expect(translate(undefined, 'Rolle::Benutzer')).toBe('Benutzer');
    expect(translate({}, 'Rolle::{n} Benutzer', { n: 2 })).toBe('2 Benutzer');
  });

  it('translates finished messages by pattern, the most specific first', () => {
    const tr = messageTranslator({
      'Nicht gefunden': 'Not found',
      'Ordner „{path}“ existiert nicht': 'Folder “{path}” does not exist',
      'Ordner „{path}“ existiert nicht ({why})': 'Folder “{path}” does not exist ({why})',
    });
    expect(tr('Nicht gefunden')).toBe('Not found');
    expect(tr('Ordner „a/b“ existiert nicht')).toBe('Folder “a/b” does not exist');
    expect(tr('Ordner „a“ existiert nicht (gelöscht)')).toBe('Folder “a” does not exist (gelöscht)');
    expect(tr('Etwas anderes')).toBeUndefined();
  });
});
