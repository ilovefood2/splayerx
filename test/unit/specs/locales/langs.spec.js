import {
  fromPairs, mapValues, difference,
} from 'lodash';
import ar from '@/locales/lang/ar.json';
import en from '@/locales/lang/en.json';
import es from '@/locales/lang/es.json';
import ja from '@/locales/lang/ja.json';
import ko from '@/locales/lang/ko.json';
import ru from '@/locales/lang/ru.json';
import zhHans from '@/locales/lang/zh-Hans.json';
import zhHant from '@/locales/lang/zh-Hant.json';

const langs = fromPairs([
  ['ar', ar],
  ['en', en],
  ['es', es],
  ['ja', ja],
  ['ko', ko],
  ['ru', ru],
  ['zh-Hans', zhHans],
  ['zh-Hant', zhHant],
]);
const objectDeepKeys = obj => Object.keys(obj).filter(key => obj[key] instanceof Object)
  .map(key => objectDeepKeys(obj[key]).map(k => `${key}.${k}`))
  .reduce((x, y) => x.concat(y), Object.keys(obj));
const langKeys = mapValues(langs, objectDeepKeys);

describe('locales - langs', () => {
  it('should have several mainstream locales', () => {
    expect(langs).to.include.all.keys('en', 'zh-Hans', 'zh-Hant', 'ja');
  });
  it('should have limited key differences between en and in other locales', () => {
    const enKeys = langKeys.en;
    Object.keys(langKeys).forEach((locale) => {
      expect(difference(langKeys[locale], enKeys)).to.have.lengthOf.at.most(enKeys.length / 2);
    });
  });
});
