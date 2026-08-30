import { cloneDeep } from 'lodash';
import { LanguageCode } from '@/libs/language';
import {
  IOrigin, IEntityGenerator, Type, Format,
} from '@/interfaces/ISubtitle';

export interface IAITranslatedOrigin extends IOrigin {
  type: Type.AITranslated;
  source: {
    /** hash of the reference subtitle this translation is derived from */
    referenceHash: string;
    /** target language the reference is translated into */
    targetLanguage: LanguageCode;
  };
}

/**
 * Produces the entity for an on-the-fly LLM translation of an existing subtitle
 * track. The heavy lifting (fetching source cues, calling the API) happens in the
 * loader/parser; this only describes the subtitle so it can appear in the list.
 */
export class AITranslatedGenerator implements IEntityGenerator {
  private readonly origin: IAITranslatedOrigin;

  private readonly language: LanguageCode;

  private readonly delay: number;

  public constructor(referenceHash: string, targetLanguage: LanguageCode, delay = 0) {
    this.origin = {
      type: Type.AITranslated,
      source: { referenceHash, targetLanguage },
    };
    this.language = targetLanguage;
    this.delay = Number.isFinite(delay) ? delay : 0;
  }

  public async getDisplaySource() { return cloneDeep(this.origin); }

  public async getRealSource() { return cloneDeep(this.origin); }

  public async getLanguage() { return this.language; }

  public async getDelay() { return this.delay; }

  private readonly format = Format.AITranslated;

  public async getFormat() { return this.format; }

  // Deterministic so re-selecting the same reference + target reuses the entity.
  public async getHash() {
    return `ai-${this.origin.source.referenceHash}-${this.language}`;
  }
}
