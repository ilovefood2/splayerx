import {
  afterEach, beforeEach, describe, expect, it, vi,
} from 'vitest';

const transcribeVideo = vi.hoisted(() => vi.fn());

vi.mock('@/services/subtitle/ai', async (importOriginal) => {
  const original = await importOriginal();
  return {
    ...original,
    // Everything present: go straight to transcription.
    checkTranscribeEnvironment: () => ({
      ok: true,
      whisperPath: '/bin/whisper-cli',
      ffmpegPath: '/bin/ffmpeg',
      ffprobePath: '/bin/ffprobe',
      modelPath: '/models/ggml-large-v3.bin',
      preferredModelReady: true,
      modelDir: '/models',
      missing: [],
    }),
    transcribeVideo,
  };
});

// eslint-disable-next-line import/first
import SubtitleManager from '@/store/modules/SubtitleManager';
// eslint-disable-next-line import/first
import { SubtitleManager as subtitleActions } from '@/store/actionTypes';
// eslint-disable-next-line import/first
import { LanguageCode } from '@/libs/language';

const CHUNKS = 6;

describe('store/modules/SubtitleManager transcription', () => {
  let chunksTranscribed;

  beforeEach(() => {
    chunksTranscribed = 0;
    // Stand-in for whisper: one chunk at a time, stopping when aborted.
    transcribeVideo.mockImplementation(async (videoPath, env, options) => {
      const cues = [];
      for (let i = 0; i < CHUNKS; i += 1) {
        if (options.signal.aborted) break;
        chunksTranscribed += 1;
        const chunk = [{ start: i * 30, end: i * 30 + 2, text: `line ${i}` }];
        cues.push(...chunk);
        // eslint-disable-next-line no-await-in-loop
        await options.onCues(chunk, { language: 'en', done: i + 1, total: CHUNKS });
      }
      return { language: 'en', cues };
    });
  });

  afterEach(() => {
    transcribeVideo.mockReset();
  });

  it('stops transcribing when the translated track cannot be created', async () => {
    const dispatched = [];
    const context = {
      state: { mediaHash: 'media-1' },
      getters: {
        originSrc: '/Movies/talk.mp4',
        aiTranscribeLanguage: LanguageCode.en,
        aiTranslateProvider: 'openai',
        aiTranslateApiKey: 'key',
        duration: CHUNKS * 30,
      },
      dispatch: (type) => {
        dispatched.push(type);
        // No provider could be set up, so no track exists to receive cues.
        return Promise.resolve(undefined);
      },
    };

    const result = await SubtitleManager.actions[subtitleActions.transcribeAndTranslate](
      context, { targetCode: LanguageCode['zh-CN'] },
    );

    expect(result).to.equal(undefined);
    expect(dispatched.filter(type => type === subtitleActions.addTranscribedSubtitle))
      .to.have.length(1);
    // Previously every remaining chunk was still transcribed, for nothing.
    expect(chunksTranscribed).to.equal(1);
  });

  it('does not start when the video changed before transcription begins', async () => {
    const state = { mediaHash: 'media-1' };
    const context = {
      state,
      getters: {
        originSrc: '/Movies/first.mp4',
        aiTranscribeLanguage: LanguageCode.en,
        aiTranslateProvider: 'openai',
        aiTranslateApiKey: 'key',
        duration: 60,
      },
      dispatch: () => Promise.resolve(undefined),
    };

    const running = SubtitleManager.actions[subtitleActions.transcribeAndTranslate](
      context, { targetCode: LanguageCode['zh-CN'] },
    );
    // The next video finishes loading while the environment is prepared.
    state.mediaHash = 'media-2';

    expect(await running).to.equal(undefined);
    expect(transcribeVideo).not.toHaveBeenCalled();
  });
});
