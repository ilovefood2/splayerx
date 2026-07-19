function removeEmptyStringFromObject(obj) {
  // non-translated strings synced from crowdin becomes empty string
  // remove them to use fallbackLocale
  Object.keys(obj).forEach((key) => {
    const val = obj[key];
    if (typeof val === 'string') {
      if (val.length) return;
      delete obj[key];
    } else if (typeof val === 'object') {
      obj[key] = removeEmptyStringFromObject(obj[key]);
    }
  });
  return obj;
}

const messages = {
  ar: removeEmptyStringFromObject(ar),
  en,
  es: removeEmptyStringFromObject(es),
  ja: removeEmptyStringFromObject(ja),
  ko: removeEmptyStringFromObject(ko),
  ru: removeEmptyStringFromObject(ru),
  'zh-Hans': removeEmptyStringFromObject(zhHans),
  'zh-Hant': removeEmptyStringFromObject(zhHant),
};

export default messages;
import ar from './lang/ar.json';
import en from './lang/en.json';
import es from './lang/es.json';
import ja from './lang/ja.json';
import ko from './lang/ko.json';
import ru from './lang/ru.json';
import zhHans from './lang/zh-Hans.json';
import zhHant from './lang/zh-Hant.json';
