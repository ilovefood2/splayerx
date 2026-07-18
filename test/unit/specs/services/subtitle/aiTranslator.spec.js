import {
  existsSync, mkdtempSync, rmdirSync, unlinkSync, writeFileSync,
} from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import {
  translateLines, AITranslationError,
  RealtimeSubtitleTranslator, TranslationCache,
  resolveAIProvider, isLocalhostUrl, LOCAL_TUNING,
  contentRangeTotal, sha256File, inspectManagedModel, managedModelById,
  MANAGED_MODELS, DEFAULT_MANAGED_MODEL_ID, MANAGED_MODEL_NAME, MANAGED_MODEL_ALIAS,
  parseWhisperCues, parseWhisperProgress, parseFfmpegProgress, checkTranscribeEnvironment,
  chunkPlanOf, whisperArgs,
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
    let systemPrompt = '';
    global.fetch = mockFetch((url, init) => {
      seenUrl = url;
      const request = JSON.parse(init.body);
      systemPrompt = request.messages[0].content;
      const { lines } = JSON.parse(request.messages[1].content);
      return { body: { choices: [{ message: { content: JSON.stringify({ translations: lines.map(l => `T:${l}`) }) } }] } };
    });
    const out = await translateLines(['hello', 'world'], config);
    expect(out).to.deep.equal(['T:hello', 'T:world']);
    expect(seenUrl).to.equal('https://api.openai.com/v1/chat/completions');
    expect(systemPrompt).to.contain('whole batch as context');
    expect(systemPrompt).to.contain('speaker intent');
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

describe('services/subtitle/ai - managed translation model', () => {
  it('offers three verified downloads and defaults to Tower+ 72B', () => {
    expect(MANAGED_MODELS.map(model => model.id)).to.deep.equal([
      'qwen3-14b', 'qwen3-32b', 'tower-plus-72b',
    ]);
    expect(DEFAULT_MANAGED_MODEL_ID).to.equal('tower-plus-72b');
    expect(MANAGED_MODEL_NAME).to.equal('Tower-Plus-72B.i1-IQ3_M.gguf');
    expect(MANAGED_MODEL_ALIAS).to.equal('splayer-tower-plus-72b');
    expect(managedModelById('tower-plus-72b').sha256)
      .to.equal('fd76288e9d0908b64eb3aa0e8524498a44eec0cc8be1ed9260b8725ea57500b3');
    expect(managedModelById('tower-plus-72b').url)
      .to.contain('mradermacher/Tower-Plus-72B-i1-GGUF');
    MANAGED_MODELS.forEach((model) => {
      expect(model.sha256).to.match(/^[a-f0-9]{64}$/);
      expect(model.url).to.contain(model.fileName);
    });
  });

  it('resolves a selected model and safely falls back for old preferences', () => {
    expect(managedModelById('qwen3-14b').downloadSize).to.equal('9 GB');
    expect(managedModelById('tower-plus-72b').downloadSize).to.equal('35.5 GB');
    expect(managedModelById('tower-plus-72b').personalUseOnly).to.equal(true);
    expect(managedModelById('qwen3-4b').id).to.equal(DEFAULT_MANAGED_MODEL_ID);
    expect(managedModelById('unknown').id).to.equal(DEFAULT_MANAGED_MODEL_ID);
  });

  it('parses total bytes from resumable download headers', () => {
    expect(contentRangeTotal('bytes 1048576-2097151/2621440')).to.equal(2621440);
    expect(contentRangeTotal(undefined)).to.equal(0);
    expect(contentRangeTotal('invalid')).to.equal(0);
  });

  it('reports visible progress while verifying a model file', async () => {
    const modelDir = mkdtempSync(join(tmpdir(), 'splayer-model-hash-test-'));
    const modelPath = join(modelDir, 'model.gguf');
    const contents = Buffer.alloc(256 * 1024, 7);
    const progress = [];
    writeFileSync(modelPath, contents);

    try {
      const digest = await sha256File(modelPath, undefined, (received, total) => {
        progress.push({ received, total });
      });
      expect(digest).to.have.length(64);
      expect(progress[0]).to.deep.equal({ received: 0, total: contents.length });
      expect(progress[progress.length - 1]).to.deep.equal({
        received: contents.length,
        total: contents.length,
      });
    } finally {
      unlinkSync(modelPath);
      rmdirSync(modelDir);
    }
  });

  it('reports missing app-owned runtime and model without probing the network', () => {
    const status = inspectManagedModel({
      serverPath: '/path/that/does/not/exist/llama-server',
      modelDir: '/path/that/does/not/exist/models',
    });
    expect(status.runtimeAvailable).to.equal(false);
    expect(status.modelDownloaded).to.equal(false);
    expect(status.ready).to.equal(false);
    expect(status.modelPath.endsWith(MANAGED_MODEL_NAME)).to.equal(true);
  });

  it('inspects each selected download independently', () => {
    const modelDir = mkdtempSync(join(tmpdir(), 'splayer-model-test-'));
    const qwenModel = join(modelDir, managedModelById('qwen3-14b').fileName);
    writeFileSync(qwenModel, 'downloaded model');

    try {
      expect(inspectManagedModel({ serverPath: __filename, modelDir }, 'qwen3-14b')
        .modelDownloaded).to.equal(true);
      expect(inspectManagedModel({ serverPath: __filename, modelDir }, 'tower-plus-72b')
        .modelDownloaded).to.equal(false);
      expect(existsSync(qwenModel)).to.equal(true);
    } finally {
      unlinkSync(qwenModel);
      rmdirSync(modelDir);
    }
  });
});

describe('services/subtitle/ai - resolveAIProvider', () => {
  let originalFetch;
  beforeEach(() => { originalFetch = global.fetch; });
  afterEach(() => { global.fetch = originalFetch; });

  it('uses SPlayer-managed translation when its private endpoint is ready', async () => {
    global.fetch = () => { throw new Error('provider resolution must not probe the network'); };
    const resolved = await resolveAIProvider({}, {
      localEndpoint: { baseUrl: 'http://127.0.0.1:43123/v1', model: MANAGED_MODEL_ALIAS },
    });
    expect(resolved.ok).to.equal(true);
    expect(resolved.kind).to.equal('local');
    expect(resolved.reason).to.equal('local-ready');
    expect(resolved.endpoint.apiKey).to.equal('');
    expect(resolved.endpoint.baseUrl).to.equal('http://127.0.0.1:43123/v1');
    expect(resolved.endpoint.model).to.equal(MANAGED_MODEL_ALIAS);
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
    global.fetch = () => { throw new Error('should not probe'); };
    const resolved = await resolveAIProvider({}, { localReason: 'local-runtime-missing' });
    expect(resolved.ok).to.equal(false);
    expect(resolved.reason).to.equal('local-runtime-missing');
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

  it('uses the stable CPU backend while media playback owns the GPU', () => {
    const args = whisperArgs({
      ok: true,
      modelPath: '/models/whisper.bin',
      vadModelPath: '/models/vad.bin',
      missing: [],
    }, '/tmp/audio.wav', '/tmp/subtitles', 'en', 4);
    expect(args).to.include('--no-gpu');
    expect(args).to.include('--print-progress');
    expect(args).to.include('--vad');
    expect(args).to.include('/models/vad.bin');
  });

  it('parses the latest native progress update even across buffered output', () => {
    const stderr = 'callback: progress =  10%\ncallback: progress =  35%\n';
    expect(parseWhisperProgress(stderr)).to.equal(35);
    expect(parseWhisperProgress('loading model')).to.equal(undefined);
  });

  it('parses ffmpeg extraction progress in both machine-readable formats', () => {
    expect(parseFfmpegProgress('out_time_us=12500000\nprogress=continue')).to.equal(12.5);
    expect(parseFfmpegProgress('out_time=00:01:02.500000\n')).to.equal(62.5);
    expect(parseFfmpegProgress('opening input')).to.equal(undefined);
  });

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
