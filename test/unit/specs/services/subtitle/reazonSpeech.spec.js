import { expect } from 'chai';
import {
  REAZON_SPEECH_MODEL_FILES,
  REAZON_SPEECH_TOTAL_BYTES,
  cueizeReazonWords,
  parseReazonSpeechStdout,
  reazonSpeechChunkPlanOf,
  reazonSpeechCliArgs,
  stitchReazonChunks,
} from '@/services/subtitle/ai';

const tokensOf = (text, start = 0, step = 0.2) => Array.from(text).map((token, index) => ({
  text: token,
  start: start + index * step,
}));

describe('services/subtitle/ai - ReazonSpeech', () => {
  it('pins the four-file official int8-fp32 model', () => {
    expect(REAZON_SPEECH_MODEL_FILES.map(file => file.fileName)).to.deep.equal([
      'encoder-epoch-99-avg-1.int8.onnx',
      'decoder-epoch-99-avg-1.onnx',
      'joiner-epoch-99-avg-1.int8.onnx',
      'tokens.txt',
    ]);
    expect(REAZON_SPEECH_TOTAL_BYTES).to.equal(169180699);
    REAZON_SPEECH_MODEL_FILES.forEach((file) => {
      expect(file.sha256).to.match(/^[a-f0-9]{64}$/);
    });
  });

  it('builds the minimal offline transducer command', () => {
    const args = reazonSpeechCliArgs({
      encoderPath: '/model/encoder.onnx',
      decoderPath: '/model/decoder.onnx',
      joinerPath: '/model/joiner.onnx',
      tokensPath: '/model/tokens.txt',
    }, ['/tmp/one.wav', '/tmp/two.wav']);
    expect(args).to.include.members([
      '--model-type=transducer', '--provider=cpu', '--num-threads=2',
      '--decoding-method=greedy_search', '--print-args=false',
    ]);
    expect(args.slice(-2)).to.deep.equal(['/tmp/one.wav', '/tmp/two.wav']);
  });

  it('strictly parses aligned token timestamps with an absolute offset', () => {
    expect(parseReazonSpeechStdout(JSON.stringify({
      text: '日本', tokens: ['日', '本'], timestamps: [0.1, 0.4],
    }), 12)).to.deep.equal([
      { text: '日', start: 12.1 },
      { text: '本', start: 12.4 },
    ]);
    expect(() => parseReazonSpeechStdout(JSON.stringify({
      text: '日本', tokens: ['日'], timestamps: [0.1],
    }))).to.throw(/token text/);
    expect(() => parseReazonSpeechStdout('{}')).to.throw(/unaligned/);
  });

  it('deduplicates an exact overlap and removes only the isolated leading artefact', () => {
    const result = stitchReazonChunks([
      {
        inputStart: 0, inputEnd: 26, coreStart: 0, coreEnd: 24,
        tokens: [{ text: 'カ', start: 0 }, ...tokensOf('私は王子です', 7)],
      },
      {
        inputStart: 22, inputEnd: 40, coreStart: 24, coreEnd: 40,
        tokens: tokensOf('王子です次です', 22),
      },
    ]);
    expect(result.map(token => token.text).join('')).to.equal('私は王子です次です');
  });

  it('chooses whole Japanese words when overlapping windows use different spelling', () => {
    const result = stitchReazonChunks([
      {
        inputStart: 94, inputEnd: 122, coreStart: 96, coreEnd: 120,
        tokens: tokensOf('姫の顔を直接見た者はこの世でも僅かしかおりませんので大変', 116, 0.16),
      },
      {
        inputStart: 118, inputEnd: 130, coreStart: 120, coreEnd: 130,
        tokens: tokensOf('姫の顔を直接見た者はこの世でもわずかしかおりませんので大変難航', 116, 0.16),
      },
    ]);
    const text = result.map(token => token.text).join('');
    expect((text.match(/この世でも/g) || []).length).to.equal(1);
    expect(text).to.contain('難航');
    expect(text).to.not.contain('大変姫の顔');
    expect(result.every((token, index) => index === 0 || token.start >= result[index - 1].start))
      .to.equal(true);
  });

  it('creates readable cues without splitting Japanese words', () => {
    const source = '申し訳ない王子です';
    const cues = cueizeReazonWords(tokensOf(source, 1, 0.18), {
      maxCharacters: 4, maxDuration: 8, pauseSeconds: 0.8,
    });
    expect(cues.map(cue => cue.text).join('')).to.equal(source);
    expect(cues.map(cue => cue.text)).to.deep.equal(['申し訳', 'ない王子', 'です']);
    expect(cues.every(cue => cue.end > cue.start)).to.equal(true);
  });

  it('uses 24-second cores with two seconds of context on both sides', () => {
    const chunks = reazonSpeechChunkPlanOf(50);
    expect(chunks.map(chunk => ({
      coreStart: chunk.coreStart, coreEnd: chunk.coreEnd,
      inputStart: chunk.inputStart, inputEnd: chunk.inputEnd,
    }))).to.deep.equal([
      { coreStart: 0, coreEnd: 24, inputStart: 0, inputEnd: 26 },
      { coreStart: 24, coreEnd: 48, inputStart: 22, inputEnd: 50 },
      { coreStart: 48, coreEnd: 50, inputStart: 46, inputEnd: 50 },
    ]);
  });
});
