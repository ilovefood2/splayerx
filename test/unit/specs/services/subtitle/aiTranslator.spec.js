import {
  translateLines, AITranslationError,
  RealtimeSubtitleTranslator, TranslationCache,
  probeOllama, pickChatModel, isEmbeddingModel, parseParameterSize, apiRootOf,
  resolveAIProvider, isLocalhostUrl, LOCAL_TUNING,
  parseWhisperCues, checkTranscribeEnvironment, chunkPlanOf,
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

  it('throws when the reply cannot be aligned to the input (never silently returns originals)', async () => {
    global.fetch = mockFetch(() => ({ body: { choices: [{ message: { content: '{"translations":["only-one"]}' } }] } }));
    let error;
    try { await translateLines(['a', 'b', 'c'], config); } catch (e) { error = e; }
    // Returning ['a','b','c'] here would be indistinguishable from a successful
    // translation, and the caller would cache the untranslated text forever.
    expect(error).to.be.an.instanceof(AITranslationError);
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

// Captured verbatim from a real `GET /api/tags` on a machine running Ollama.
const TAGS_FIXTURE = {
  models: [
    {
      name: 'bge-m3:latest',
      capabilities: ['embedding'],
      details: { family: 'bert', parameter_size: '566.70M' },
    },
    {
      name: 'qwen3:14b',
      capabilities: ['completion', 'tools', 'thinking'],
      details: { family: 'qwen3', parameter_size: '14.8B' },
    },
    {
      name: 'qwen3-coder:latest',
      capabilities: ['completion', 'tools'],
      details: { family: 'qwen3moe', parameter_size: '30.5B' },
    },
  ],
};

function mockJsonFetch(routes) {
  return (url) => {
    const key = Object.keys(routes).find(k => url.indexOf(k) !== -1);
    if (key === undefined) {
      return Promise.resolve({ ok: false, status: 404, json: () => Promise.resolve({}) });
    }
    const body = routes[key];
    if (body === 'error') return Promise.reject(new TypeError('Failed to fetch'));
    return Promise.resolve({ ok: true, status: 200, json: () => Promise.resolve(body) });
  };
}

describe('services/subtitle/ai - ollama detection', () => {
  let originalFetch;
  beforeEach(() => { originalFetch = global.fetch; });
  afterEach(() => { global.fetch = originalFetch; });

  it('parses the suffixed parameter_size string', () => {
    // Naive parseFloat would score a 0.57B embedding model as 566B.
    expect(parseParameterSize('14.8B')).to.equal(14.8);
    expect(parseParameterSize('566.70M')).to.be.closeTo(0.5667, 1e-6);
    expect(parseParameterSize('30.5B')).to.equal(30.5);
    expect(parseParameterSize(undefined)).to.equal(undefined);
  });

  it('normalises any endpoint shape to the api root', () => {
    expect(apiRootOf('http://127.0.0.1:11434/v1')).to.equal('http://127.0.0.1:11434');
    expect(apiRootOf('http://127.0.0.1:11434/v1/chat/completions')).to.equal('http://127.0.0.1:11434');
    expect(apiRootOf('http://127.0.0.1:11434/')).to.equal('http://127.0.0.1:11434');
    expect(apiRootOf('')).to.equal('http://127.0.0.1:11434');
  });

  it('excludes embedding models, which cannot chat', () => {
    expect(isEmbeddingModel({ id: 'bge-m3:latest', family: 'bert', capabilities: ['embedding'] })).to.equal(true);
    expect(isEmbeddingModel({ id: 'bge-m3:latest' })).to.equal(true); // name only
    expect(isEmbeddingModel({ id: 'x', family: 'bert' })).to.equal(true);
    expect(isEmbeddingModel({ id: 'qwen3:14b', capabilities: ['completion', 'tools'] })).to.equal(false);
    // declared capabilities beat the name heuristic
    expect(isEmbeddingModel({ id: 'nomic-embed-odd', capabilities: ['completion'] })).to.equal(false);
  });

  it('prefers a non-thinking model even when it is much larger', async () => {
    // Measured: qwen3:14b (thinking) takes ~29s for a 16-line batch while the
    // 30.5B qwen3-coder takes ~5s. Reasoning tokens dominate; size does not.
    global.fetch = mockJsonFetch({ '/api/tags': TAGS_FIXTURE });
    const probe = await probeOllama();
    expect(probe.available).to.equal(true);
    expect(probe.recommended).to.equal('qwen3-coder:latest');
    expect(probe.chatModels.map(m => m.id)).to.not.include('bge-m3:latest');
    expect(probe.degraded).to.equal(false);
  });

  it('never recommends an embedding model', () => {
    expect(pickChatModel([
      {
        id: 'bge-m3:latest', chatCapable: false, thinking: false,
      },
    ])).to.equal(undefined);
    expect(pickChatModel([])).to.equal(undefined);
  });

  it('falls back to /v1/models when /api/tags is unavailable', async () => {
    global.fetch = mockJsonFetch({
      '/v1/models': { data: [{ id: 'bge-m3:latest' }, { id: 'qwen3-coder:latest' }] },
    });
    const probe = await probeOllama();
    expect(probe.available).to.equal(true);
    expect(probe.degraded).to.equal(true);
    // bge-m3 must still be excluded, by name, without capabilities to consult.
    expect(probe.recommended).to.equal('qwen3-coder:latest');
  });

  it('reports unreachable instead of throwing when ollama is absent', async () => {
    global.fetch = () => Promise.reject(new TypeError('Failed to fetch'));
    const probe = await probeOllama();
    expect(probe.reachable).to.equal(false);
    expect(probe.reason).to.equal('unreachable');
  });

  it('does not hang when the endpoint never answers', async () => {
    global.fetch = () => new Promise(() => {}); // never settles
    const probe = await probeOllama(undefined, { timeout: 30 });
    expect(probe.reachable).to.equal(false);
  });

  it('reports no-chat-model when only embedding models are installed', async () => {
    global.fetch = mockJsonFetch({
      '/api/tags': { models: [TAGS_FIXTURE.models[0]] },
    });
    const probe = await probeOllama();
    expect(probe.reachable).to.equal(true);
    expect(probe.available).to.equal(false);
    expect(probe.reason).to.equal('no-chat-model');
  });
});

describe('services/subtitle/ai - resolveAIProvider', () => {
  let originalFetch;
  beforeEach(() => { originalFetch = global.fetch; });
  afterEach(() => { global.fetch = originalFetch; });

  it('uses a local ollama when no api key is configured', async () => {
    global.fetch = mockJsonFetch({ '/api/tags': TAGS_FIXTURE });
    const resolved = await resolveAIProvider({});
    expect(resolved.ok).to.equal(true);
    expect(resolved.kind).to.equal('ollama');
    expect(resolved.reason).to.equal('ollama-detected');
    expect(resolved.endpoint.apiKey).to.equal('');
    expect(resolved.endpoint.baseUrl).to.equal('http://127.0.0.1:11434/v1');
    expect(resolved.endpoint.model).to.equal('qwen3-coder:latest');
    // A local model is far slower than a hosted one.
    expect(resolved.tuning.requestTimeout).to.equal(LOCAL_TUNING.requestTimeout);
  });

  it('honours a configured api key without probing at all', async () => {
    global.fetch = () => { throw new Error('should not probe when a key is set'); };
    const resolved = await resolveAIProvider({ aiTranslateApiKey: 'sk-test' });
    expect(resolved.ok).to.equal(true);
    expect(resolved.kind).to.equal('openai');
    expect(resolved.reason).to.equal('user-key');
    expect(resolved.endpoint.baseUrl).to.equal('https://api.openai.com/v1');
    expect(resolved.tuning).to.deep.equal({});
  });

  it('never fires an unauthenticated request at openai', async () => {
    // The old behaviour: no key -> request -> 401 -> translation dead for the
    // session, after the subtitle text had already left the machine.
    global.fetch = () => { throw new Error('should not be called'); };
    const resolved = await resolveAIProvider({ aiTranslateProvider: 'openai' });
    expect(resolved.ok).to.equal(false);
    expect(resolved.reason).to.equal('missing-key');
  });

  it('reports why it could not use a local model', async () => {
    global.fetch = () => Promise.reject(new TypeError('Failed to fetch'));
    const resolved = await resolveAIProvider({});
    expect(resolved.ok).to.equal(false);
    expect(resolved.reason).to.equal('ollama-unreachable');
  });

  it('lets an explicit model override the recommendation', async () => {
    global.fetch = mockJsonFetch({ '/api/tags': TAGS_FIXTURE });
    const resolved = await resolveAIProvider({ aiTranslateModel: 'llama3.2' });
    expect(resolved.endpoint.model).to.equal('llama3.2');
  });

  it('normalises a custom ollama url so the endpoint is not doubled', async () => {
    global.fetch = mockJsonFetch({ '/api/tags': TAGS_FIXTURE });
    const resolved = await resolveAIProvider({
      aiTranslateProvider: 'ollama', aiTranslateApiUrl: 'http://127.0.0.1:11434',
    });
    expect(resolved.endpoint.baseUrl).to.equal('http://127.0.0.1:11434/v1');
    expect(resolved.reason).to.equal('ollama-forced');
  });

  it('treats a localhost key endpoint as local for tuning', () => {
    expect(isLocalhostUrl('http://localhost:1234/v1')).to.equal(true);
    expect(isLocalhostUrl('https://api.openai.com/v1')).to.equal(false);
  });
});

describe('services/subtitle/ai - whisper transcription', () => {
  // Captured from a real `whisper-cli -oj` run (whisper.cpp 1.9).
  const WHISPER_JSON = {
    result: { language: 'en' },
    transcription: [
      {
        offsets: { from: 0, to: 10400 },
        text: ' And so, my fellow Americans, ask not what your country can do for you.',
      },
    ],
  };

  it('converts whisper millisecond offsets into second-based cues', () => {
    const cues = parseWhisperCues(WHISPER_JSON);
    expect(cues.length).to.equal(1);
    // 10400ms is 10.4s, not 10400s — getting this wrong puts every cue hours away
    expect(cues[0].start).to.equal(0);
    expect(cues[0].end).to.equal(10.4);
    expect(cues[0].text).to.equal('And so, my fellow Americans, ask not what your country can do for you.');
  });

  it('drops the text whisper invents when it hears no speech', () => {
    // Both of these were produced by whisper from audio that was music only:
    // the Chinese one appeared on screen, the Japanese one was reproduced from
    // the same file's opening minute. They are memorised training data, emitted
    // with confident timestamps, and must never reach a subtitle.
    const cues = parseWhisperCues({
      transcription: [
        {
          offsets: { from: 0, to: 29980 },
          text: 'ご視聴ありがとうございました',
        },
        {
          offsets: { from: 30000, to: 59980 },
          text: '请不吝点赞、订阅、转发、打赏，支持明镜与点点栏目',
        },
        { offsets: { from: 60000, to: 61000 }, text: 'Thanks for watching!' },
        { offsets: { from: 62000, to: 63000 }, text: 'Subtitles by the Amara.org community' },
        { offsets: { from: 64000, to: 65000 }, text: '本当にありがとうございました' },
      ],
    });
    // the last line is ordinary speech that merely resembles the sign-off, and
    // must survive: the filter matches whole cues, not substrings
    expect(cues.map(c => c.text)).to.deep.equal(['本当にありがとうございました']);
  });

  it('drops non-speech markers and empty segments', () => {
    const cues = parseWhisperCues({
      transcription: [
        { offsets: { from: 0, to: 1000 }, text: '[Music]' },
        { offsets: { from: 1000, to: 2000 }, text: '(applause)' },
        { offsets: { from: 2000, to: 3000 }, text: '   ' },
        { offsets: { from: 3000, to: 4000 }, text: 'real speech' },
      ],
    });
    // translating "[Music]" would waste a call and show junk as a subtitle
    expect(cues.map(c => c.text)).to.deep.equal(['real speech']);
  });

  it('survives a reply with no transcription at all', () => {
    expect(parseWhisperCues({})).to.deep.equal([]);
    expect(parseWhisperCues({ transcription: [] })).to.deep.equal([]);
    expect(parseWhisperCues({ transcription: [{ text: 'no offsets' }] })).to.deep.equal([]);
  });

  it('accepts cues that stream in after construction, keeping indices stable', async () => {
    const translate = texts => Promise.resolve(texts.map(t => `Z:${t}`));
    const first = [{ start: 0, end: 2, text: 'chunk one' }];
    const rt = new RealtimeSubtitleTranslator(first, config, { translate, lookaheadSeconds: 10 });
    rt.getCuesAt(0);
    await delay(5);
    expect(rt.getCuesAt(0)[0].text).to.equal('Z:chunk one');

    // A later chunk of the transcription lands.
    const appended = rt.appendCues([{ start: 4, end: 6, text: 'chunk two' }]);
    expect(appended).to.equal(1);
    // the already-translated cue must not be disturbed by the append
    expect(rt.getCuesAt(0)[0].text).to.equal('Z:chunk one');
    rt.getCuesAt(4);
    await delay(5);
    expect(rt.getCuesAt(4)[0].text).to.equal('Z:chunk two');
    expect(rt.sourceCues.length).to.equal(2);
  });

  it('splits a long video into chunks that cover it exactly once', () => {
    // A 193-minute file: transcribing it in one pass means no subtitle for
    // minutes, so it is cut into pieces that each land as they finish.
    const plan = chunkPlanOf(193 * 60, 120);
    expect(plan.length).to.equal(97);
    expect(plan[0]).to.deep.equal({ start: 0, length: 120 });
    // no gaps: each chunk starts where the previous one ended
    plan.slice(1).forEach((c, i) => {
      expect(c.start).to.equal(plan[i].start + plan[i].length);
    });
    // and the last one stops exactly at the end, never past it
    const last = plan[plan.length - 1];
    expect(last.start + last.length).to.equal(193 * 60);
  });

  it('falls back to one pass when the duration is unknown', () => {
    // length 0 means "to the end of the file"; ffmpeg must not be given -t 0.
    expect(chunkPlanOf(0, 120)).to.deep.equal([{ start: 0, length: 0 }]);
  });

  it('reports exactly which tools are missing', () => {
    // Nothing is installed under a bogus prefix, so every piece is missing and
    // the UI can name them instead of saying "it didn't work".
    const env = checkTranscribeEnvironment('/nonexistent/userdata', '/nonexistent/home');
    expect(env.missing).to.include('model');
    expect(env.ok).to.equal(false);
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
    const sent = [];
    const translate = (texts) => { sent.push(...texts); return Promise.resolve(texts.map(t => `Z:${t}`)); };
    const rt = new RealtimeSubtitleTranslator(cues, config, { translate, lookaheadSeconds: 10 });
    rt.getCuesAt(0);
    await delay(5);
    // the cue at 100s is outside the 10s lookahead, so it must not be requested
    // or translated while playing near 0s
    expect(sent).to.not.include('far');
    expect(rt.getAllCues()[2].text).to.equal('far');
    // ...and once the playhead reaches it, it does get translated
    rt.getCuesAt(100);
    await delay(5);
    expect(sent).to.include('far');
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

  it('retries a failed batch instead of caching the untranslated original', async () => {
    let calls = 0;
    const translate = (texts) => {
      calls += 1;
      if (calls === 1) return Promise.reject(new AITranslationError('bad reply'));
      return Promise.resolve(texts.map(t => `Z:${t}`));
    };
    const rt = new RealtimeSubtitleTranslator(cues, config, { translate, lookaheadSeconds: 10 });
    rt.getCuesAt(0);
    await delay(5);
    // the failure must not be recorded as a translation
    expect(rt.getCuesAt(0)[0].text).to.equal('one');
    // the next poll retries and succeeds
    rt.getCuesAt(0);
    await delay(5);
    expect(rt.getCuesAt(0)[0].text).to.equal('Z:one');
  });

  it('shows nothing until a cue is translated when hiding untranslated text', async () => {
    let release;
    const gate = new Promise((resolve) => { release = resolve; });
    const translate = texts => gate.then(() => texts.map(t => `Z:${t}`));
    const rt = new RealtimeSubtitleTranslator(cues, config, {
      translate, hideUntranslated: true, lookaheadSeconds: 10,
    });
    // The AI track is the target-language track: showing 'one' here and swapping
    // it to Chinese a moment later is the flicker this option exists to stop.
    expect(rt.getCuesAt(0)).to.deep.equal([]);
    release();
    await delay(5);
    expect(rt.getCuesAt(0)[0].text).to.equal('Z:one');
  });

  it('still falls back to the source text when not hiding', async () => {
    const translate = () => new Promise(() => {}); // never resolves
    const rt = new RealtimeSubtitleTranslator(cues, config, { translate });
    expect(rt.getCuesAt(0)[0].text).to.equal('one');
  });

  it('reports translation progress for the status line', async () => {
    const translate = texts => Promise.resolve(texts.map(t => `Z:${t}`));
    const rt = new RealtimeSubtitleTranslator(cues, config, {
      translate, hideUntranslated: true, lookaheadSeconds: 10,
    });
    expect(rt.progress).to.deep.equal({ translated: 0, total: 3 });
    rt.getCuesAt(0);
    await delay(5);
    // the two cues inside the 10s window are done; the one at 100s is not
    expect(rt.progress.translated).to.equal(2);
    expect(rt.progress.total).to.equal(3);
  });

  it('forwards the request timeout to the translate call', async () => {
    // The client default is 30s; a cold local model can exceed that on its own.
    let seen;
    const translate = (texts, cfg, opts) => { seen = opts; return Promise.resolve(texts.map(t => `Z:${t}`)); };
    const rt = new RealtimeSubtitleTranslator(cues, config, { translate, requestTimeout: 120000 });
    rt.getCuesAt(0);
    await delay(5);
    expect(seen).to.deep.equal({ timeout: 120000 });
  });

  it('falls back to a local provider when the api key is rejected', async () => {
    let calls = 0;
    const translate = (texts, cfg) => {
      calls += 1;
      if (cfg.apiKey === 'bad-key') return Promise.reject(new AITranslationError('unauthorized', 401));
      return Promise.resolve(texts.map(t => `L:${t}`));
    };
    const onAuthFailure = () => Promise.resolve({
      config: { ...config, apiKey: '', model: 'qwen3-coder:latest' },
      requestTimeout: 120000,
    });
    const rt = new RealtimeSubtitleTranslator(
      cues, { ...config, apiKey: 'bad-key' },
      { translate, onAuthFailure, lookaheadSeconds: 10 },
    );
    rt.getCuesAt(0);
    await delay(10);
    expect(rt.getCuesAt(0)[0].text).to.equal('one'); // still original, key rejected
    // the next poll runs on the local provider
    rt.getCuesAt(0);
    await delay(10);
    expect(rt.getCuesAt(0)[0].text).to.equal('L:one');
    expect(rt.activeModel).to.equal('qwen3-coder:latest');
    expect(rt.error).to.equal(undefined);
    expect(calls).to.be.greaterThan(1);
  });

  it('does not let a second concurrent 401 re-kill the rescued session', async () => {
    // Two batches are in flight by default (maxConcurrentBatches: 2). Both 401.
    // The second must not undo the failover the first one triggered.
    let failoverCalls = 0;
    const translate = (texts, cfg) => (cfg.apiKey === 'bad-key'
      ? Promise.reject(new AITranslationError('unauthorized', 401))
      : Promise.resolve(texts.map(t => `L:${t}`)));
    const onAuthFailure = () => {
      failoverCalls += 1;
      return Promise.resolve({ config: { ...config, apiKey: '', model: 'local' } });
    };
    const many = [];
    for (let i = 0; i < 40; i += 1) many.push({ start: i, end: i + 1, text: `line${i}` });
    const rt = new RealtimeSubtitleTranslator(
      many, { ...config, apiKey: 'bad-key' },
      {
        translate, onAuthFailure, batchSize: 4, lookaheadSeconds: 30,
      },
    );
    rt.getCuesAt(0);
    await delay(15);
    expect(failoverCalls).to.equal(1);
    rt.getCuesAt(0);
    await delay(15);
    expect(rt.getCuesAt(0)[0].text).to.equal('L:line0');
  });

  it('carries the local look-ahead across an auth failover, not just the timeout', async () => {
    // A rescued session runs on a local model, which needs the bigger window as
    // much as the longer timeout: with the hosted default of 20s its
    // translations would land after the cues had already been shown.
    const far = [
      { start: 0, end: 2, text: 'near' },
      { start: 60, end: 62, text: 'far' },
    ];
    const requested = [];
    const translate = (texts, cfg) => {
      requested.push(...texts);
      if (cfg.apiKey === 'bad-key') return Promise.reject(new AITranslationError('unauthorized', 401));
      return Promise.resolve(texts.map(t => `L:${t}`));
    };
    const rt = new RealtimeSubtitleTranslator(far, { ...config, apiKey: 'bad-key' }, {
      translate,
      // no lookaheadSeconds: takes the hosted default of 20s
      onAuthFailure: () => Promise.resolve({
        config: { ...config, apiKey: '', model: 'local' },
        requestTimeout: 120000,
        lookaheadSeconds: 90,
      }),
    });
    rt.getCuesAt(0);
    await delay(10);
    rt.getCuesAt(0);
    await delay(10);
    // the cue 60s out is outside a 20s window but inside the local 90s one
    expect(requested).to.include('far');
  });

  it('stays disabled when there is no local fallback available', async () => {
    const translate = () => Promise.reject(new AITranslationError('unauthorized', 401));
    const rt = new RealtimeSubtitleTranslator(
      cues, config, { translate, onAuthFailure: () => Promise.resolve(undefined) },
    );
    rt.getCuesAt(0);
    await delay(10);
    expect(rt.getCuesAt(0)[0].text).to.equal('one');
    expect(rt.error).to.be.an.instanceof(AITranslationError);
    expect(rt.error.status).to.equal(401);
  });

  it('keeps the old permanent-disable behaviour without a failover hook', async () => {
    let calls = 0;
    const translate = () => { calls += 1; return Promise.reject(new AITranslationError('unauthorized', 401)); };
    const rt = new RealtimeSubtitleTranslator(cues, config, { translate });
    rt.getCuesAt(0);
    await delay(10);
    const after = calls;
    rt.getCuesAt(0);
    await delay(10);
    expect(calls).to.equal(after); // no further attempts
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
