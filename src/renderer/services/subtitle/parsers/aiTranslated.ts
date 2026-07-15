import {
  Format, TextCue, IParser, IVideoSegments, ITags,
} from '@/interfaces/ISubtitle';
import { getDialogues } from '../utils';
import { AITranslatedLoader } from '../utils/loaders';
import { getAITranslator, makeAITranslationKey } from '../ai';

/**
 * Parser for on-the-fly LLM translations. On every `getDialogues(time)` it asks
 * the realtime translator for the cues around the playhead, translating a
 * lookahead window in the background. Until a cue is translated its original text
 * is returned, so subtitles never blank out while the API responds.
 */
export class AITranslatedParser implements IParser {
  public get format() { return Format.AITranslated; }

  public readonly loader: AITranslatedLoader;

  public readonly videoSegments: IVideoSegments;

  private readonly key: string;

  /** How many cues have been fed to videoSegments so far. */
  private seededCues = 0;

  private readonly baseTags: ITags = { alignment: 2, pos: undefined };

  public constructor(loader: AITranslatedLoader, videoSegments: IVideoSegments) {
    this.loader = loader;
    this.videoSegments = videoSegments;
    const { referenceHash, targetLanguage } = loader.source.source;
    this.key = makeAITranslationKey(referenceHash, targetLanguage);
  }

  public async getMetadata() { return { PlayResX: '', PlayResY: '' }; }

  private toTextCue(cue: { start: number, end: number, text: string }): TextCue {
    return {
      start: cue.start,
      end: cue.end,
      text: cue.text,
      tags: this.baseTags,
      format: this.format,
    };
  }

  /**
   * Seed only the cues we have not seen yet. A transcription streams in chunk by
   * chunk, so the cue list grows after the first call — seeding once would leave
   * everything past the first chunk missing from the played-time segments.
   */
  private seedSegments(cues: ReadonlyArray<{ start: number, end: number }>) {
    for (let i = this.seededCues; i < cues.length; i += 1) {
      this.videoSegments.insert(cues[i].start, cues[i].end);
    }
    this.seededCues = cues.length;
  }

  public async getDialogues(time?: number): Promise<TextCue[]> {
    const translator = getAITranslator(this.key);
    if (!translator) return [];
    this.seedSegments(translator.sourceCues);
    if (time === undefined) {
      return translator.getAllCues().map(cue => this.toTextCue(cue));
    }
    // The translator already returns only the cues overlapping `time`, but run it
    // through getDialogues too for parity with the other parsers.
    const cues = translator.getCuesAt(time).map(cue => this.toTextCue(cue));
    return getDialogues(cues, time);
  }
}
