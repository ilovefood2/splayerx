import {
  translateLines, AITranslationError,
  RealtimeSubtitleTranslator, TranslationCache,
} from '@/services/subtitle/ai';

const config = {
  baseUrl: 'https://api.openai.com/v1',
  apiKey: 'test-key',
  model: 'gpt-4o-mini',
  targetLanguage: 'Simplified Chinese',
};

function mockFetch(handler) {
  return (url, init) => {
    const { status = 200, body } = handler(url, init);
    return Promise.resolve({
      ok: status >= 200 && status < 300,
      status,
      statusText: 'mock',
      json: () => Promise.resolve(body),
      text: () => Promise.resolve(typeof body === 'string' ? body : JSON.stringify(body)),
    });
  };
}

const delay = ms => new Promise(resolve => setTimeout(resolve, ms));

describe('services/subtitle/ai - translateLines', () => {
  let originalFetch;
  beforeEach(() => { originalFetch = global.fetch; });
  afterEach(() => { global.fetch = originalFetch; });

  it('translates a batch and resolves the OpenAI-style endpoint', async () => {
    let seenUrl = '';
    global.fetch = mockFetch((url, init) => {
      seenUrl = url;
      const { lines } = JSON.parse(JSON.parse(init.body).messages[1].content);
      return { body: { choices: [{ message: { content: JSON.stringify({ translations: lines.map(l => `T:${l}`) }) } }] } };
    });
    const out = await translateLines(['hello', 'world'], config);
    expect(out).to.deep.equal(['T:hello', 'T:world']);
    expect(seenUrl).to.equal('https://api.openai.com/v1/chat/completions');
  });

  it('does not double-append when a full completions URL is configured', async () => {
    let seenUrl = '';
    global.fetch = mockFetch((url) => { seenUrl = url; return { body: { choices: [{ message: { content: '{"translations":["a"]}' } }] } }; });
    await translateLines(['x'], { ...config, baseUrl: 'https://host/v1/chat/completions/' });
    expect(seenUrl).to.equal('https://host/v1/chat/completions');
  });

  it('parses translations wrapped in a markdown code fence', async () => {
    global.fetch = mockFetch(() => ({ body: { choices: [{ message: { content: '```json\n{"translations":["你好"]}\n```' } }] } }));
    const out = await translateLines(['hello'], config);
    expect(out).to.deep.equal(['你好']);
  });

  it('falls back to originals when the count does not match (never drops cues)', async () => {
    global.fetch = mockFetch(() => ({ body: { choices: [{ message: { content: '{"translations":["only-one"]}' } }] } }));
    const out = await translateLines(['a', 'b', 'c'], config);
    expect(out).to.deep.equal(['a', 'b', 'c']);
  });

  it('throws AITranslationError with the HTTP status on failure', async () => {
    global.fetch = mockFetch(() => ({ status: 401, body: 'unauthorized' }));
    let error;
    try { await translateLines(['a'], config); } catch (e) { error = e; }
    expect(error).to.be.an.instanceof(AITranslationError);
    expect(error.status).to.equal(401);
  });

  it('short-circuits on empty input without calling the API', async () => {
    global.fetch = () => { throw new Error('should not be called'); };
    const out = await translateLines([], config);
    expect(out).to.deep.equal([]);
  });
});

describe('services/subtitle/ai - TranslationCache', () => {
  it('evicts the least-recently-used entry when full', () => {
    const cache = new TranslationCache(2);
    cache.set('a', '1');
    cache.set('b', '2');
    cache.get('a'); // 'a' becomes most-recent, 'b' is now LRU
    cache.set('c', '3');
    expect(cache.has('b')).to.equal(false);
    expect(cache.get('a')).to.equal('1');
    expect(cache.get('c')).to.equal('3');
  });
});

describe('services/subtitle/ai - RealtimeSubtitleTranslator', () => {
  const cues = [
    { start: 0, end: 2, text: 'one' },
    { start: 2, end: 4, text: 'two' },
    { start: 100, end: 102, text: 'far' },
  ];

  it('shows the original text first, then the translation once ready', async () => {
    const translate = texts => Promise.resolve(texts.map(t => `Z:${t}`));
    const rt = new RealtimeSubtitleTranslator(cues, config, { translate, lookaheadSeconds: 10 });
    expect(rt.getCuesAt(0)[0].text).to.equal('one');
    await delay(5);
    expect(rt.getCuesAt(0)[0].text).to.equal('Z:one');
  });

  it('respects the lookahead window (far cues untranslated until approached)', async () => {
    const translate = texts => Promise.resolve(texts.map(t => `Z:${t}`));
    const rt = new RealtimeSubtitleTranslator(cues, config, { translate, lookaheadSeconds: 10 });
    rt.getCuesAt(0);
    await delay(5);
    // far cue at 100s has not been fetched while playing near 0s
    rt.getCuesAt(100);
    await delay(5);
    expect(rt.getCuesAt(100)[0].text).to.equal('Z:far');
  });

  it('never throws when translation fails and exposes the error', async () => {
    const translate = () => Promise.reject(new AITranslationError('nope', 500));
    const rt = new RealtimeSubtitleTranslator(cues, config, { translate });
    expect(() => rt.getCuesAt(0)).to.not.throw();
    await delay(5);
    expect(rt.getCuesAt(0)[0].text).to.equal('one');
    expect(rt.error).to.be.an.instanceof(AITranslationError);
  });

  it('deduplicates identical source lines within a batch', async () => {
    let received = [];
    const translate = (texts) => { received = texts; return Promise.resolve(texts.map(t => `Q:${t}`)); };
    const dupCues = [{ start: 0, end: 1, text: 'same' }, { start: 1, end: 2, text: 'same' }];
    const rt = new RealtimeSubtitleTranslator(dupCues, config, { translate });
    rt.getCuesAt(0);
    await delay(5);
    expect(received).to.deep.equal(['same']);
    expect(rt.getCuesAt(1)[0].text).to.equal('Q:same');
  });
});
