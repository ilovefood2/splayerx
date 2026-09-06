// @ts-ignore
import { parse, toMS } from '@splayer/subtitle';
import {
  Format, TextCue, IParser, IVideoSegments,
} from '@/interfaces/ISubtitle';
import { tagsGetter, getDialogues } from '../utils';
import { LocalTextLoader } from '../utils/loaders';

type ParsedSubtitle = {
  start: number,
  end: number,
  text: string,
  settings: string,
}[];

export class VttParser implements IParser {
  public get format() { return Format.SubRip; }

  public readonly loader: LocalTextLoader;

  public readonly videoSegments: IVideoSegments;

  public constructor(textLoader: LocalTextLoader, videoSegments: IVideoSegments) {
    this.loader = textLoader;
    this.videoSegments = videoSegments;
  }

  public async getMetadata() { return { PlayResX: '', PlayResY: '' }; }

  private dialogues: TextCue[] = [];

  private baseTags = { alignment: 2, pos: undefined };

  private normalizer(parsedSubtitle: ParsedSubtitle) {
    const finalDialogues: TextCue[] = [];
    (Array.isArray(parsedSubtitle) ? parsedSubtitle : [])
      .filter(({ text }) => text)
      .forEach((subtitle) => {
        finalDialogues.push({
          start: toMS(subtitle.start) / 1000,
          end: toMS(subtitle.end) / 1000,
          tags: tagsGetter(subtitle.text, this.baseTags),
          text: subtitle.text
            .replace(/<\/?[^bius]+?>/g, '')
            .replace(/\{[^{}]*\}/g, '')
            .replace(/[\\/][Nn]|\r?\n|\r/g, '\n'),
          format: this.format,
        });
      });
    this.dialogues = finalDialogues;
    this.dialogues.forEach(({ start, end }) => this.videoSegments.insert(start, end));
  }

  public async getDialogues(time?: number) {
    if (!this.loader.fullyRead) {
      const payload = await this.loader.getPayload() as string;
      if (this.loader.fullyRead) {
        try {
          this.normalizer(parse(payload || ''));
        } catch (error) {
          this.normalizer([]);
        }
      }
    }
    return getDialogues(this.dialogues, time);
  }
}
