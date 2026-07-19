import {
  MutationTree, GetterTree, ActionTree,
  Module, ActionContext,
} from 'vuex';
import { v4 as uuidv4 } from 'uuid';
import {
  isEqual, sortBy, differenceWith, flatten, remove, debounce, difference, cloneDeep,
} from 'lodash';
import { remote, SaveDialogReturnValue } from 'electron';
import { extname, basename, join } from 'path';
import { existsSync } from 'fs';
import { rendererEventBus } from '@/services/globalEvents';
import store from '@/store';
import { SubtitleManager as m } from '@/store/mutationTypes';
import {
  SubtitleManager as a,
  newSubtitle as subActions,
  Subtitle as legacyActions,
  // UserInfo as usActions,
} from '@/store/actionTypes';
import {
  ISubtitleControlListItem, Type, IEntityGenerator, IEntity, NOT_SELECTED_SUBTITLE, Cue, TextCue,
} from '@/interfaces/ISubtitle';
import {
  TranscriptInfo,
  searchForLocalList, retrieveEmbeddedList, fetchOnlineList,
  OnlineGenerator, LocalGenerator, EmbeddedGenerator, TranslatedGenerator,
  AITranslatedGenerator,
} from '@/services/subtitle';
import {
  registerAITranslation, makeAITranslationKey, clearAllAITranslations,
  appendAITranslationCues, getAITranslator, resolveAIProvider, configFor,
  isLocalhostUrl,
  checkTranscribeEnvironment, transcribeVideo, downloadModel,
  ensureManagedModelServer, stopManagedModelServer,
  managedModelById,
  AIProviderResolution, AIProviderTuning, AIProviderPrefs, AITranslatorConfig,
  RealtimeTranslatorOptions, TimedText, BundledPaths, TranscribeEnvironment,
  ManagedModelPaths, ManagedModelProgress,
} from '@/services/subtitle/ai';
import { generateHints, calculatedName } from '@/libs/utils';
import { log } from '@/libs/Log';
import { IStoredSubtitleItem, SelectedSubtitle } from '@/interfaces/ISubtitleStorage';
import {
  retrieveSubtitlePreference, DatabaseGenerator,
  storeSubtitleLanguage, addSubtitleItemsToList, removeSubtitleItemsFromList,
  storeSelectedSubtitles, updateSubtitleList,
} from '@/services/storage/subtitle';
import { LanguageCode, codeToLanguageName, normalizeCode } from '@/libs/language';
import { ISubtitleStream } from '@/plugins/mediaTasks';
import { IEmbeddedOrigin } from '@/services/subtitle/utils/loaders';
import { sagiSubtitleToSRT } from '@/services/subtitle/utils/transcoders';
import { write } from '@/libs/file';
import {
  ONLINE_LOADING, REQUEST_TIMEOUT,
  SUBTITLE_UPLOAD, UPLOAD_SUCCESS, UPLOAD_FAILED,
  CANNOT_UPLOAD,
  LOCAL_SUBTITLE_REMOVED,
  AI_TRANSLATE_NO_SOURCE,
  AI_TRANSLATE_NO_PROVIDER,
  AI_TRANSLATE_NO_WHISPER,
  AI_TRANSCRIBE_FAILED,
  AI_TRANSCRIBE_NO_SPEECH,
  // APPX_EXPORT_NOT_WORK,
} from '../../helpers/notificationcodes';
import { addBubble } from '../../helpers/notificationControl';
import SubtitleModule from './Subtitle';

const sortOfTypes = {
  local: 0,
  embedded: 1,
  online: 2,
  translated: 3,
  aiTranslated: 3,
  modified: 4,
};

type SubtitleSelection = string | { id: string, explicit?: boolean };

function unpackSubtitleSelection(selection: SubtitleSelection) {
  return typeof selection === 'string'
    ? { id: selection, explicit: false }
    : selection;
}

let unwatch: Function;

/** A list item is a candidate source for AI translation when it is not itself an
 *  AI translation and is not already in the target language. */
function isAITranslatable(item: ISubtitleControlListItem, targetCode: LanguageCode): boolean {
  return !!item && item.type !== Type.AITranslated && normalizeCode(item.language) !== targetCode;
}

/** Prefer an explicitly requested / currently-selected track, else the first
 *  translatable one in the list. */
function pickAIReference(
  list: ISubtitleControlListItem[],
  targetCode: LanguageCode,
  preferredId?: string,
): ISubtitleControlListItem | undefined {
  if (preferredId) {
    const preferred = list.find(sub => sub.id === preferredId);
    if (preferred && isAITranslatable(preferred, targetCode)) return preferred;
  }
  return list.find(sub => isAITranslatable(sub, targetCode));
}

function languagesFor(
  targetCode: LanguageCode,
  sourceCode?: LanguageCode,
): {
    targetLanguage: string, sourceLanguage?: string,
  } {
  // An untagged track (Default/No) has no meaningful language name — passing it
  // through would put "translate from Default" in the prompt. Leave it out and
  // let the model detect the source language itself.
  const hasKnownSource = !!sourceCode
    && sourceCode !== LanguageCode.Default && sourceCode !== LanguageCode.No;
  return {
    targetLanguage: codeToLanguageName(targetCode),
    sourceLanguage: hasKnownSource ? codeToLanguageName(sourceCode as LanguageCode) : undefined,
  };
}

function aiPrefsOf(getters: {
  aiTranslateProvider?: string, aiTranslateApiUrl?: string,
  aiTranslateApiKey?: string, aiTranslateModel?: string, aiTranslateManagedModel?: string,
}) {
  return {
    aiTranslateProvider: getters.aiTranslateProvider as
      'auto' | 'openai' | 'local' | undefined,
    aiTranslateApiUrl: getters.aiTranslateApiUrl,
    aiTranslateApiKey: getters.aiTranslateApiKey,
    aiTranslateModel: getters.aiTranslateModel,
    aiTranslateManagedModel: getters.aiTranslateManagedModel,
  };
}

/** The reference track's text cues, or an empty list if it has none to translate. */
async function collectSourceCues(
  dispatch: (type: string, payload?: unknown) => Promise<{ dialogues?: Cue[] }>,
  referenceId: string,
): Promise<TimedText[]> {
  let dialogues: Cue[] = [];
  try {
    const result = await dispatch(`${referenceId}/${subActions.getDialogues}`, undefined);
    dialogues = (result && result.dialogues) || [];
  } catch (error) {
    log.warn('SubtitleManager', error);
    return [];
  }
  const cues = dialogues
    .filter((cue): cue is TextCue => !!cue && typeof (cue as TextCue).text === 'string'
      && !!(cue as TextCue).text)
    .map(cue => ({ start: cue.start, end: cue.end, text: cue.text }));
  if (!cues.length) log.warn('SubtitleManager', 'AI translate: reference subtitle has no text cues');
  return cues;
}

export interface AITextReference {
  reference: ISubtitleControlListItem,
  cues: TimedText[],
}

/**
 * Resolve the first candidate that actually exposes text. Blu-ray subtitles
 * are commonly PGS images: they look selectable in the menu, but an LLM cannot
 * translate their bitmap payload. Prefer the selected track, then try the
 * remaining language-compatible tracks before falling back to speech.
 */
export async function findAITextReference(
  list: ISubtitleControlListItem[],
  targetCode: LanguageCode,
  preferredId: string | undefined,
  collect: (referenceId: string) => Promise<TimedText[]>,
): Promise<AITextReference | undefined> {
  const preferred = pickAIReference(list, targetCode, preferredId);
  const candidates = list.filter(item => isAITranslatable(item, targetCode));
  const ordered = preferred
    ? [preferred, ...candidates.filter(item => item.id !== preferred.id)]
    : candidates;
  for (const reference of ordered) {
    const cues = await collect(reference.id);
    if (cues.length) return { reference, cues };
  }
  return undefined;
}

/**
 * whisper wants a bare ISO-639-1 code ('ja'), not our regional codes ('zh-CN').
 * Returns undefined for "auto", which lets whisper detect — less reliable, since
 * it only listens to the opening seconds.
 */
function whisperLanguageOf(code?: string): string | undefined {
  if (!code) return undefined;
  const normalized = normalizeCode(code);
  if (normalized === LanguageCode.No || normalized === LanguageCode.Default) return undefined;
  return String(normalized).split('-')[0].toLowerCase();
}

function tuningOptions(tuning: AIProviderTuning, hideUntranslated: boolean) {
  return {
    requestTimeout: tuning.requestTimeout,
    lookaheadSeconds: tuning.lookaheadSeconds,
    hideUntranslated,
  };
}

/**
 * Translator options for a resolved provider.
 *
 * Provider-dependent timing for the realtime translator.
 */
function buildTranslatorOptions(
  resolution: AIProviderResolution,
) {
  const endpointIsLocal = !!resolution.endpoint
    && isLocalhostUrl(resolution.endpoint.baseUrl);
  // A local model can fall behind dense dialogue or pause briefly under memory
  // pressure. Keep the source subtitle visible until its translation lands so
  // playback never turns into a long subtitle-free section.
  const hideUntranslated = resolution.kind !== 'local' && !endpointIsLocal;
  return tuningOptions(resolution.tuning, hideUntranslated);
}

function managedPaths(): ManagedModelPaths {
  const runtimeDir = remote.app.isPackaged
    ? join(process.resourcesPath, 'llama')
    : join(remote.app.getAppPath(), 'build', 'llama');
  return {
    serverPath: join(runtimeDir, 'llama-server'),
    modelDir: join(remote.app.getPath('userData'), 'qwen3'),
  };
}

function managedProgressText(progress: ManagedModelProgress, modelName: string): string {
  if (progress.stage === 'verifying') {
    const received = progress.received || 0;
    const total = progress.total || 0;
    const percent = total > 0 ? Math.min(100, Math.round((received / total) * 100)) : 0;
    return progressText('errorFile.aiProgress.verifyingModel', { model: modelName, percent });
  }
  if (progress.stage === 'starting') {
    return progressText('errorFile.aiProgress.startingModel', { model: modelName });
  }
  const received = progress.received || 0;
  const total = progress.total || 0;
  const percent = total > 0 ? Math.min(100, Math.round((received / total) * 100)) : 0;
  return progressText('errorFile.aiProgress.downloadingTranslationModel', {
    model: modelName, percent,
  });
}

async function translationPlan(
  prefs: AIProviderPrefs,
  languages: ReturnType<typeof languagesFor>,
): Promise<{ config?: AITranslatorConfig, options?: RealtimeTranslatorOptions, reason: string }> {
  let resolution: AIProviderResolution;
  const preference = prefs.aiTranslateProvider || 'auto';
  const useManaged = preference === 'local'
    || (preference === 'auto' && !prefs.aiTranslateApiKey);
  if (useManaged) {
    const managedModel = managedModelById(prefs.aiTranslateManagedModel);
    let progressShown = false;
    try {
      const endpoint = await ensureManagedModelServer({
        paths: managedPaths(),
        modelId: managedModel.id,
        onProgress: (progress) => {
          const content = managedProgressText(progress, managedModel.name);
          if (!progressShown) {
            progressShown = true;
            showAIProgress(content);
          } else {
            updateAIProgress(content);
          }
        },
      });
      resolution = await resolveAIProvider(prefs, { localEndpoint: endpoint });
    } catch (error) {
      endAIProgress();
      log.warn('SubtitleManager', `Managed ${managedModel.name} unavailable: ${(error as Error).message}`);
      resolution = await resolveAIProvider(prefs, { localReason: 'local-start-failed' });
    }
  } else {
    resolution = await resolveAIProvider(prefs);
  }
  return {
    config: configFor(resolution, languages),
    options: buildTranslatorOptions(resolution),
    reason: resolution.reason,
  };
}

interface ISubtitleManagerState {
  mediaHash: string,
  primarySubtitleId: string,
  secondarySubtitleId: string,
  isRefreshing: boolean,
  allSubtitles: { [id: string]: IEntity },
  primaryDelay: number,
  secondaryDelay: number,
  deleteModifiedConfirm: boolean,
}
const state = {
  mediaHash: '',
  isRefreshing: false,
  allSubtitles: {},
  primarySubtitleId: '',
  secondarySubtitleId: '',
  primaryDelay: 0,
  secondaryDelay: 0,
  deleteModifiedConfirm: false,
};
const getters: GetterTree<ISubtitleManagerState, {}> = {
  list(state): ISubtitleControlListItem[] {
    const list = Object.keys(state.allSubtitles)
      .filter(id => state.allSubtitles[id])
      .map(id => ({ id, sub: state.allSubtitles[id] }));
    const controlList = sortBy(list, ({ sub }) => {
      const { type } = sub.displaySource;
      if ((type === Type.Online || type === Type.Translated)
        && sub.language !== store.getters.primaryLanguage) {
        return sortOfTypes[type] + 2;
      }
      if (type === Type.Embedded) {
        const embeddedRank = (sub.displaySource as IEmbeddedOrigin).source.streamIndex / 10;
        return sortOfTypes[type] + embeddedRank;
      }
      return sortOfTypes[type];
    }).map(({ id, sub }) => ({
      id,
      hash: sub.hash,
      language: sub.language,
      source: sub.displaySource,
      type: sub.displaySource.type,
    }));
    return controlList.map(sub => ({ ...sub, name: calculatedName(sub, controlList) }));
  },
  primarySubtitleId(state): string { return state.primarySubtitleId; },
  secondarySubtitleId(state): string { return state.secondarySubtitleId; },
  isRefreshing(state): boolean { return state.isRefreshing; },
  canTryToUploadCurrentSubtitle(state, getters, rootState, rootGetters): boolean {
    const { primarySubtitleId: pid, secondarySubtitleId: sid } = state;
    return (((store.hasModule(sid) || store.hasModule(pid))
      && ((!store.hasModule(pid) || rootGetters[`${pid}/canTryToUpload`])))
      && ((!store.hasModule(sid) || rootGetters[`${sid}/canTryToUpload`])));
  },
  primaryDelay({ primaryDelay }) { return primaryDelay; },
  secondaryDelay({ secondaryDelay }) { return secondaryDelay; },
  calculatedNoSub(state, { list }) { return !list.length; },
  isPrimarySubtitleIsImage({ primarySubtitleId }, getters, rootState, rootGetters): boolean {
    return !!rootGetters[`${primarySubtitleId}/isImage`];
  },
  isSecondarySubtitleIsImage({ secondarySubtitleId }, getters, rootState, rootGetters): boolean {
    return !!rootGetters[`${secondarySubtitleId}/isImage`];
  },
  canTranslateWithAI(state, getters): boolean {
    if (!getters.aiTranslateEnabled) return false;
    // 'openai' means the user explicitly wants the hosted API, which needs a key
    // or a custom endpoint. 'auto'/'local' can run entirely on a local model,
    // so they need no configuration at all — whether one is actually reachable
    // is settled by resolveAIProvider when a translation is requested.
    if (getters.aiTranslateProvider === 'openai') {
      return !!(getters.aiTranslateApiKey || getters.aiTranslateApiUrl);
    }
    return true;
  },
};
const mutations: MutationTree<ISubtitleManagerState> = {
  [m.setMediaHash](state, hash: string) {
    state.mediaHash = hash;
  },
  [m.setPrimarySubtitleId](state, id: string) {
    const lastId = state.primarySubtitleId;
    state.primarySubtitleId = id;
    if (store.hasModule(lastId)) store.dispatch(`${lastId}/${subActions.pause}`);
    if (store.hasModule(id)) store.dispatch(`${id}/${subActions.resume}`);
  },
  [m.setSecondarySubtitleId](state, id: string) {
    const lastId = state.secondarySubtitleId;
    state.secondarySubtitleId = id;
    if (store.hasModule(lastId)) store.dispatch(`${lastId}/${subActions.pause}`);
    if (store.hasModule(id)) store.dispatch(`${id}/${subActions.resume}`);
  },
  [m.setNotSelectedSubtitle](state, subtitle?: 'primary' | 'secondary') {
    if (subtitle === 'primary') state.primarySubtitleId = NOT_SELECTED_SUBTITLE;
    else if (subtitle === 'secondary') state.secondarySubtitleId = NOT_SELECTED_SUBTITLE;
    else {
      state.primarySubtitleId = NOT_SELECTED_SUBTITLE;
      state.secondarySubtitleId = NOT_SELECTED_SUBTITLE;
    }
  },
  [m.setIsRefreshing](state, isRefreshing: boolean) {
    state.isRefreshing = isRefreshing;
  },
  [m.addSubtitleId](state, { id, entity }: { id: string, entity: IEntity }) {
    state.allSubtitles[id] = entity;
    const { primarySubtitleId, secondarySubtitleId } = state;
    if (primarySubtitleId && !state.allSubtitles[primarySubtitleId]) state.primarySubtitleId = '';
    if (secondarySubtitleId && !state.allSubtitles[secondarySubtitleId]) state.secondarySubtitleId = '';
  },
  [m.deleteSubtitleId](state, id: string) {
    delete state.allSubtitles[id];
  },
  [m.setPrimaryDelay](state, delayInSeconds: number) {
    state.primaryDelay = delayInSeconds;
    const subtitle = state.allSubtitles[state.primarySubtitleId];
    if (subtitle) subtitle.delay = delayInSeconds;
  },
  [m.setSecondaryDelay](state, delayInSeconds: number) {
    state.secondaryDelay = delayInSeconds;
    const subtitle = state.allSubtitles[state.secondarySubtitleId];
    if (subtitle) subtitle.delay = delayInSeconds;
  },
  [m.updateDeleteModifiedSubtitleStatus](state, payload: boolean) {
    state.deleteModifiedConfirm = payload;
  },
};
interface IAddSubtitlesOptions<SourceType> {
  mediaHash: string,
  source: SourceType[],
}
interface IAddSubtitleOptions {
  generator: IEntityGenerator,
  mediaHash: string,
}
function privacyConfirm(): Promise<boolean> {
  const $bus = rendererEventBus;
  $bus.$emit('privacy-confirm');
  return new Promise((resolve) => {
    $bus.$once('subtitle-refresh-continue', resolve);
  });
}

function deleteModifiedConfirm(): Promise<boolean> {
  const $bus = rendererEventBus;
  $bus.$emit('delete-modified-confirm', true);
  return new Promise((resolve) => {
    $bus.$once('delete-modified-cancel', (result: boolean) => {
      resolve(result);
    });
  });
}

let primarySelectionComplete = false;
let secondarySelectionComplete = false;
/** Media currently being transcribed, so a second menu click cannot start a
 *  duplicate multi-minute job for the same video. */
let transcribingMediaHash = '';

/**
 * A single live status line while subtitles are being prepared.
 *
 * Nothing is shown until a line is translated, so without this the screen just
 * sits empty and the app looks broken. The bubble is updated in place rather
 * than re-added, so it does not flicker.
 */
const AI_PROGRESS_ID = 'ai-subtitle-progress';
let aiProgressTimer: number | undefined;

/** i18n lives on the store here, the same way notificationControl reaches it. */
function progressText(key: string, values: object): string {
  const i18n = (store as { $i18n?: { t: Function, locale: string } }).$i18n;
  if (!i18n) return '';
  // vue-i18n 11 uses the active global locale automatically. Passing the
  // legacy Vue 2 `(key, locale, values)` signature drops named values, which
  // leaves progress bubbles showing a bare "%" instead of the percentage.
  return i18n.t(key, values) as string;
}

function showAIProgress(content: string): void {
  // A previous translation timer may still be alive after a failed attempt on
  // the same media. It would suppress every transcription update below and
  // recreate the exact "0% forever" symptom on retry.
  if (aiProgressTimer !== undefined) {
    clearInterval(aiProgressTimer);
    aiProgressTimer = undefined;
  }
  store.dispatch('addMessages', { id: AI_PROGRESS_ID, content });
}

function updateAIProgress(content: string): void {
  store.dispatch('changeMessageState', { id: AI_PROGRESS_ID, property: 'content', value: content });
}

function endAIProgress(): void {
  if (aiProgressTimer !== undefined) {
    clearInterval(aiProgressTimer);
    aiProgressTimer = undefined;
  }
  store.dispatch('removeMessages', AI_PROGRESS_ID);
}

// Quitting or reloading the window must not orphan a transcription. This fires
// on both, and is the only hook that covers quitting mid-transcription.
window.addEventListener('beforeunload', () => {
  abortTranscription();
  stopManagedModelServer();
  if (aiProgressTimer !== undefined) clearInterval(aiProgressTimer);
});

/**
 * Keep the status line current until the first translated line is ready, which
 * is the moment the wait visibly ends.
 */
function trackAIProgress(key: string, describe: (translated: number, total: number) => string) {
  if (aiProgressTimer !== undefined) clearInterval(aiProgressTimer);
  aiProgressTimer = window.setInterval(() => {
    const translator = getAITranslator(key);
    if (!translator) return;
    const { translated, total } = translator.progress;
    if (translated > 0) {
      endAIProgress();
      return;
    }
    updateAIProgress(describe(translated, total));
  }, 500);
}
/** Aborts the in-flight transcription, killing its ffmpeg/whisper children. */
let transcribeAbort: AbortController | undefined;

/**
 * Stop transcribing and kill the child processes.
 *
 * ffmpeg and whisper are separate processes: they do NOT die with the renderer
 * that spawned them, so quitting mid-transcription would otherwise leave
 * whisper running on the GPU indefinitely.
 */
function abortTranscription(): void {
  if (!transcribeAbort) return;
  transcribeAbort.abort();
  transcribeAbort = undefined;
}

/**
 * whisper-cli and ffmpeg ship with the app, so on a fresh install the only thing
 * missing is the speech model — download it once (showing progress) and re-probe,
 * instead of sending the user to the command line. A no-op when nothing is
 * missing, or when something other than the model is (dev without Homebrew).
 *
 * Returns the up-to-date environment, or undefined if a download was needed but
 * failed or is already running — in which case the caller should abort.
 */
async function ensureTranscribeModel(
  env: TranscribeEnvironment,
  reprobe: () => TranscribeEnvironment,
  mediaHash: string,
): Promise<TranscribeEnvironment | undefined> {
  const onlyModelMissing = env.missing.length === 1 && env.missing[0] === 'model';
  if (env.ok || !onlyModelMissing || !env.modelDir) return env;
  if (transcribingMediaHash === mediaHash) return undefined; // already downloading
  transcribingMediaHash = mediaHash;
  transcribeAbort = new AbortController();
  showAIProgress(progressText('errorFile.aiProgress.downloading', { percent: 0 }));
  try {
    await downloadModel({
      modelDir: env.modelDir,
      signal: transcribeAbort.signal,
      onProgress: ({ received, total }) => {
        const percent = total > 0 ? Math.round((received / total) * 100) : 0;
        updateAIProgress(progressText('errorFile.aiProgress.downloading', { percent }));
      },
    });
  } catch (error) {
    endAIProgress();
    transcribingMediaHash = '';
    addBubble(AI_TRANSLATE_NO_WHISPER, { missing: 'model (download failed)' });
    log.warn('SubtitleManager', `AI transcribe: model download failed — ${error}`);
    return undefined;
  }
  transcribingMediaHash = ''; // real transcription re-claims it in the caller
  return reprobe();
}
let alterDelayTimeoutId: NodeJS.Timer;
function setDelayTimeout() {
  clearTimeout(alterDelayTimeoutId);
  alterDelayTimeoutId = setTimeout(() => store.dispatch(a.storeSubtitleDelays), 10000);
}
function fetchOnlineListWrapper(
  bubble: boolean,
  videoSrc: string,
  languageCode: LanguageCode,
  hints?: string,
): Promise<TranscriptInfo[]> {
  let results: TranscriptInfo[] = [];
  return new Promise(async (resolve, reject) => {
    const onlineTimeoutId = setTimeout(() => {
      if (bubble) {
        addBubble(REQUEST_TIMEOUT, { id: `fetchOnlineListWithBubble-${videoSrc}` });
      }
      reject(results);
    }, 10000);
    try {
      results = await fetchOnlineList(videoSrc, languageCode, hints);
    } catch (err) {
      results = [];
    } finally {
      resolve(results);
      clearTimeout(onlineTimeoutId);
    }
  });
}
function initializeManager(context: ActionContext<ISubtitleManagerState, {}>) {
  const { commit, dispatch, getters } = context;
  commit(m.setMediaHash, getters.mediaHash);
  dispatch(a.refreshSubtitlesInitially);
}

const debouncedInitializeManager = debounce(initializeManager, 1000);
const actions: ActionTree<ISubtitleManagerState, {}> = {
  async [a.initializeManager](context) {
    debouncedInitializeManager(context);
  },
  async [a.resetManager]({ commit, dispatch }) {
    commit(m.setMediaHash, '');
    commit(m.setNotSelectedSubtitle);
    commit(m.setIsRefreshing, false);
    primarySelectionComplete = false;
    secondarySelectionComplete = false;
    // AI 翻译只属于上一个视频，registry 里存着 API key 和全部源字幕，换片时一并释放
    abortTranscription();
    clearAllAITranslations();
    endAIProgress();
    await Promise.all(Object.keys(state.allSubtitles).map(id => dispatch(a.removeSubtitle, id)));
  },
  async [a.refreshSubtitlesInitially]({
    state, getters, dispatch, commit,
  }) {
    primarySelectionComplete = false;
    secondarySelectionComplete = false;
    commit(m.setIsRefreshing, true);

    const {
      primaryLanguage, secondaryLanguage,
      originSrc,
      privacyAgreement,
    } = getters;
    const { mediaHash } = state;

    const preference = await retrieveSubtitlePreference(state.mediaHash);
    const hasStoredSubtitles = !!preference && !!preference.list.length;
    const languageHasChanged = (
      !preference
      || !!differenceWith(
        Object.values(preference.language),
        [primaryLanguage, secondaryLanguage],
      ).length
    );

    if (!preference || (!preference.selected.primary && !preference.selected.secondary)) {
      dispatch(a.startAISelection);
    }

    if (hasStoredSubtitles && !languageHasChanged && preference) {
      return Promise.race([
        dispatch(a.addDatabaseSubtitles, {
          source: preference.list,
          mediaHash: state.mediaHash,
        }),
        new Promise((resolve, reject) => setTimeout(() => reject(new Error('Timeout: addDatabaseSubtitles')), 10000)),
      ])
        .then(async () => dispatch(a.addLocalSubtitles, { // 如果该视频已经有记录的字幕，还需要加载同目录同名本地字幕
          mediaHash,
          source: await searchForLocalList(originSrc),
        }))
        .then(() => dispatch(a.chooseSelectedSubtitles, preference.selected))
        .catch(console.error)
        .finally(async () => {
          commit(m.setIsRefreshing, false);
          dispatch(legacyActions.UPDATE_SUBTITLE_TYPE, true);
          dispatch(a.stopAISelection);
          retrieveEmbeddedList(originSrc)
            .then(streams => dispatch(a.addEmbeddedSubtitles, { mediaHash, source: streams }));
          // AI 字幕不会持久化，每次打开都要重新生成，否则重看时不会再提供翻译
          dispatch(a.ensureAITranslation);
        });
    }

    if (hasStoredSubtitles && preference) {
      await dispatch(a.addDatabaseSubtitles, {
        source: preference.list,
        mediaHash: state.mediaHash,
      }).then(() => {
        dispatch(a.chooseSelectedSubtitles, preference.selected);
        retrieveEmbeddedList(originSrc)
          .then(streams => dispatch(a.addEmbeddedSubtitles, { mediaHash, source: streams }));
      });
    }

    let onlinePromise = Promise.resolve();
    /** whether or not to refresh online subtitles */
    const onlineNeeded = (languageHasChanged || !hasStoredSubtitles) && ['mkv', 'avi', 'ts', 'mp4'].includes(extname(originSrc).slice(1)) && privacyAgreement;
    if (onlineNeeded) {
      onlinePromise = dispatch(a.refreshOnlineSubtitles, { mediaHash, bubble: false });
    }

    retrieveEmbeddedList(originSrc)
      .then(streams => dispatch(a.addEmbeddedSubtitles, { mediaHash, source: streams }));
    return Promise.race([
      Promise.all([
        onlinePromise,
        dispatch(a.addLocalSubtitles, {
          mediaHash,
          source: await searchForLocalList(originSrc),
        }),
      ]),
      new Promise((resolve, reject) => setTimeout(() => reject(new Error('Timeout: addLocalSubtitles')), 10000)),
    ])
      .catch(console.error)
      .finally(() => {
        dispatch(a.stopAISelection);
        storeSubtitleLanguage([primaryLanguage, secondaryLanguage], state.mediaHash);
        dispatch(a.checkLocalSubtitles);
        dispatch(a.checkSubtitleList);
        dispatch(a.ensureAITranslation);
        commit(m.setIsRefreshing, false);
        dispatch(legacyActions.UPDATE_SUBTITLE_TYPE, true);
      });
  },
  async [a.refreshSubtitles]({
    state, getters, dispatch, commit,
  }) {
    const {
      originSrc,
      primaryLanguage, secondaryLanguage,
      privacyAgreement,
    } = getters;
    const { mediaHash } = state;
    primarySelectionComplete = false;
    secondarySelectionComplete = false;
    commit(m.setIsRefreshing, true);
    dispatch(a.startAISelection);
    const onlineNeeded = privacyAgreement ? true : await privacyConfirm();
    const onlinePromise = onlineNeeded
      ? dispatch(a.refreshOnlineSubtitles, { mediaHash, bubble: true })
      : Promise.resolve();

    return Promise.race([
      Promise.all([
        onlinePromise,
        dispatch(a.addLocalSubtitles, { mediaHash, source: await searchForLocalList(originSrc) }),
      ]),
      new Promise((resolve, reject) => setTimeout(() => reject(new Error('Timeout: refreshOnlineSubtitles')), 10000)),
    ])
      .catch(console.error)
      .finally(() => {
        dispatch(a.stopAISelection);
        storeSubtitleLanguage([primaryLanguage, secondaryLanguage], mediaHash);
        dispatch(a.checkLocalSubtitles);
        dispatch(a.checkSubtitleList);
        dispatch(a.ensureAITranslation);
        commit(m.setIsRefreshing, false);
        dispatch(legacyActions.UPDATE_SUBTITLE_TYPE, true);
      });
  },
  async [a.refreshOnlineSubtitles](
    { getters, dispatch },
    { mediaHash, bubble }: { mediaHash: string, bubble: boolean },
  ) {
    const {
      originSrc,
      primaryLanguage, secondaryLanguage,
    } = getters;
    if (bubble) addBubble(ONLINE_LOADING);
    const hints = generateHints(originSrc);
    return Promise.all([
      fetchOnlineListWrapper(!!bubble, originSrc, primaryLanguage, hints),
      fetchOnlineListWrapper(!!bubble, originSrc, secondaryLanguage, hints),
    ]).then(async (resultsList) => {
      const results = flatten(resultsList);
      const newSubtitlesToAdd: TranscriptInfo[] = [];
      const oldSubtitlesToDel: ISubtitleControlListItem[] = [];
      const oldSubtitles: ISubtitleControlListItem[] = [...getters.list];
      // delete subtitles not matching the current language preference
      const wrongLanguageSubs = remove(
        oldSubtitles,
        ({ type, language }) => (
          (type === Type.Online || type === Type.Translated)
          && language !== primaryLanguage
          && language !== secondaryLanguage
        ),
      );
      // delete subtitles not existed in the new subtitles
      const notExistedOldSubs = remove(
        oldSubtitles,
        ({ type, hash }) => (
          (type === Type.Online || type === Type.Translated)
          && !results.find(({ transcriptIdentity }) => transcriptIdentity === hash)
        ),
      );
      oldSubtitlesToDel.push(...wrongLanguageSubs, ...notExistedOldSubs);
      // add subtitles not existed in the old subtitles
      const notExistedNewSubs = results
        .filter(({ transcriptIdentity }) => !oldSubtitles
          .find(({ hash }) => hash === transcriptIdentity));
      newSubtitlesToAdd.push(...notExistedNewSubs);
      return {
        delete: oldSubtitlesToDel,
        add: newSubtitlesToAdd,
      };
    }).then(async (result) => {
      await dispatch(a.addOnlineSubtitles, { mediaHash, source: result.add })
        .then(() => dispatch(a.deleteSubtitlesByUuid, result.delete.map(({ id }) => id)));
    });
  },
  [a.checkLocalSubtitles]({ state, dispatch }) {
    const localInvalidSubtitleIds = Object.keys(state.allSubtitles)
      .filter(id => state.allSubtitles[id])
      .filter((id) => {
        const subtitle = state.allSubtitles[id];
        const source = subtitle.displaySource;
        return source && source.type === Type.Local && !existsSync(source.source as string);
      });
    if (localInvalidSubtitleIds.length) {
      dispatch(a.deleteSubtitlesByUuid, localInvalidSubtitleIds)
        .then(() => addBubble(LOCAL_SUBTITLE_REMOVED));
    }
  },
  async [a.addLocalSubtitles](
    { dispatch, getters },
    { mediaHash, source = [] }: IAddSubtitlesOptions<string>,
  ) {
    const list = cloneDeep(getters.list);
    const ids: string[] = [];
    return Promise.all(
      source.map((path: string) => dispatch(a.addSubtitle, {
        generator: new LocalGenerator(path),
        mediaHash,
      })),
    ).then(async (subtitles) => {
      // 如果本地同名字幕的内容被改了，那么会把这个字幕重新加载，这个时候需要把之前缓存的删除掉
      subtitles.forEach((sub) => {
        const existedSub = list
          .find((s: ISubtitleControlListItem) => isEqual(s.source, sub.realSource));
        if (existedSub && existedSub.hash) {
          ids.push(existedSub.hash);
        }
      });
      try {
        await dispatch(a.deleteSubtitlesByHash, ids);
      } catch (error) {
        // empty
      }
      return addSubtitleItemsToList(subtitles, mediaHash);
    });
  },
  async [a.addLocalSubtitlesWithSelect]({ state, dispatch, getters }, paths: string[]) {
    let selectedHash = paths[0];
    const { mediaHash } = state;
    // tempoary solution, need db validation schema to ensure data consistent
    if (mediaHash) {
      return Promise.all(
        paths.map(async (path: string, i: number) => {
          const g = new LocalGenerator(path);
          if (i === 0) {
            try {
              selectedHash = await g.getHash();
            } catch (ex) { console.error(ex); }
          }
          return dispatch(a.addSubtitle, { generator: g, mediaHash });
        }),
      )
        .then((list: IEntity[]) => addSubtitleItemsToList(list, state.mediaHash))
        .then(() => {
          const sub = getters.list
            .find((sub: ISubtitleControlListItem) => sub.hash === selectedHash);
          if (sub && getters.isFirstSubtitle) {
            dispatch(a.manualChangePrimarySubtitle, sub.id);
          } else if (sub && !getters.isFirstSubtitle) {
            dispatch(a.manualChangeSecondarySubtitle, sub.id);
          }
        });
    }
    return {};
  },
  async [a.addEmbeddedSubtitles](
    { dispatch },
    { mediaHash, source = [] }: IAddSubtitlesOptions<[string, ISubtitleStream]>,
  ) {
    return Promise.all(
      source.map(stream => dispatch(a.addSubtitle, {
        generator: new EmbeddedGenerator(stream[0], stream[1]),
        mediaHash,
      })),
    ).then(subtitles => addSubtitleItemsToList(subtitles, mediaHash));
  },
  async [a.addOnlineSubtitles](
    { dispatch },
    { mediaHash, source = [] }: IAddSubtitlesOptions<TranscriptInfo>,
  ) {
    return Promise.all(
      source.map((info: TranscriptInfo) => {
        if (info.tagsList.length > 0 && info.tagsList.indexOf('AI') > -1) {
          // 如果在线字幕有AI标签，就使用TranslatedGenerator
          return dispatch(a.addSubtitle, {
            generator: new TranslatedGenerator(info),
            mediaHash,
          });
        }
        return dispatch(a.addSubtitle, {
          generator: new OnlineGenerator(info),
          mediaHash,
        });
      }),
    ).then(subtitles => addSubtitleItemsToList(subtitles, mediaHash));
  },
  async [a.addDatabaseSubtitles](
    { dispatch },
    { source = [], mediaHash }: IAddSubtitlesOptions<IStoredSubtitleItem>,
  ) {
    return Promise.all(
      source.map(async stored => dispatch(a.addSubtitle, {
        generator: await DatabaseGenerator.from(stored),
        mediaHash,
      })),
    );
  },
  async [a.addSubtitle]({ state, dispatch, commit }, options: IAddSubtitleOptions) {
    if (options.mediaHash === state.mediaHash) {
      const subtitleGenerator = options.generator;
      try {
        const list = Object.values(state.allSubtitles).filter(v => v);
        const hash = await subtitleGenerator.getHash();
        const source = await subtitleGenerator.getDisplaySource();
        const existed = list
          .find(subtitle => subtitle.hash === hash && isEqual(subtitle.displaySource, source));
        if (!existed) {
          const id = uuidv4();
          store.registerModule([id], { ...SubtitleModule, name: `${id}` });
          dispatch(`${id}/${subActions.initialize}`, { id, mediaHash: state.mediaHash });
          const subtitle: IEntity = await dispatch(`${id}/${subActions.add}`, subtitleGenerator);
          await dispatch(`${id}/${subActions.store}`);
          commit(m.addSubtitleId, { id, entity: subtitle });
          return Object.assign(subtitle, { id });
        }
      } catch (ex) {
        log.warn('SubtitleManager addSubtitle action', ex);
      }
    }
    return {};
  },
  async [a.removeSubtitle]({ commit, getters, dispatch }, id: string) {
    commit(m.deleteSubtitleId, id);
    if (getters.isFirstSubtitle && getters.primarySubtitleId === id) {
      dispatch(a.autoChangePrimarySubtitle, '');
    } else if (!getters.isFirstSubtitle && getters.secondarySubtitleId === id) {
      dispatch(a.autoChangeSecondarySubtitle, '');
    }
    if (store.hasModule(id)) {
      await dispatch(`${id}/${subActions.destroy}`);
      store.unregisterModule(id);
    }
  },
  async [a.deleteSubtitlesByUuid]({
    state, commit, dispatch,
  }, ids: string[]) {
    if (state.deleteModifiedConfirm) return true;
    // 检查是不是modified字幕
    const id = ids[0];
    const item = id && state.allSubtitles[id];
    if (item && item.displaySource.type === Type.Modified) {
      commit(m.updateDeleteModifiedSubtitleStatus, true);
      const cancel = await deleteModifiedConfirm();
      if (!cancel) {
        removeSubtitleItemsFromList(
          ids.map(inid => state.allSubtitles[inid]), state.mediaHash,
        );
        ids.forEach(inid => dispatch(a.removeSubtitle, inid));
      }
      commit(m.updateDeleteModifiedSubtitleStatus, false);
      return true;
    }
    const p = removeSubtitleItemsFromList(ids.map(id => state.allSubtitles[id]), state.mediaHash);
    ids.forEach(id => dispatch(a.removeSubtitle, id));
    return p;
  },
  async [a.deleteSubtitlesByHash]({ state, dispatch }, hashes: string[]) {
    const { allSubtitles } = state;
    const ids = hashes
      .map(hash => Object.keys(allSubtitles).find(id => allSubtitles[id].hash === hash) || '')
      .filter(id => id);
    const p = removeSubtitleItemsFromList(ids.map(id => state.allSubtitles[id]), state.mediaHash);
    ids.forEach(id => dispatch(a.removeSubtitle, id));
    return p;
  },
  async [a.autoChangePrimarySubtitle]({
    dispatch, commit, getters, state,
  }, selection: SubtitleSelection) {
    const { id, explicit } = unpackSubtitleSelection(selection);
    const lastSelected = [state.primarySubtitleId, state.secondarySubtitleId];
    if (getters.subtitleOff && !explicit) commit(m.setPrimarySubtitleId, '');
    else {
      const primaryId = id;
      let secondaryId = state.secondarySubtitleId;

      if (primaryId === secondaryId) {
        secondaryId = '';
        if (!primaryId) commit(m.setNotSelectedSubtitle);
        else commit(m.setNotSelectedSubtitle, 'secondary');
      }

      if (!primaryId) commit(m.setNotSelectedSubtitle, 'primary');
      else {
        commit(m.setPrimarySubtitleId, primaryId);
        if (state.allSubtitles[primaryId]) {
          commit(m.setPrimaryDelay, state.allSubtitles[primaryId].delay);
        }
      }

      const finalSelected = [state.primarySubtitleId, state.secondarySubtitleId];
      difference(lastSelected, finalSelected).forEach((id) => {
        if (store.hasModule(id)) dispatch(`${id}/${subActions.pause}`);
      });
      difference(finalSelected, lastSelected).forEach((id) => {
        if (store.hasModule(id)) dispatch(`${id}/${subActions.resume}`);
      });

      dispatch(a.storeSelectedSubtitles, [primaryId, secondaryId]);
    }
  },
  async [a.manualChangePrimarySubtitle]({ dispatch, commit, state }, id: string) {
    dispatch('setSubtitleOff', !id)
      .catch(error => log.warn('SubtitleManager store subtitle preference', error));
    if (!id) await dispatch(a.autoChangeSecondarySubtitle, '');
    else if (!state.secondarySubtitleId) commit(m.setNotSelectedSubtitle, 'secondary');
    await dispatch(a.autoChangePrimarySubtitle, { id, explicit: !!id });
  },
  /**
   * Create (or re-select) an LLM realtime translation of an existing subtitle
   * track into the user's language, and make it the primary subtitle. Opt-in:
   * does nothing unless the feature is enabled and configured in Preferences.
   */
  async [a.addAITranslatedSubtitle](
    { state, dispatch, getters }, payload: { referenceId?: string, force?: boolean } = {},
  ) {
    // `force` is the explicit menu command: asking for it IS the opt-in, so it
    // does not also require the Preferences toggle. Whether a provider is
    // actually reachable is still settled by resolveAIProvider below.
    if (!payload.force && !getters.canTranslateWithAI) return undefined;
    const targetCode = normalizeCode(
      getters.aiTranslateTargetLanguage || getters.displayLanguage || getters.primaryLanguage,
    );
    if (targetCode === LanguageCode.No || targetCode === LanguageCode.Default) return undefined;

    const list = getters.list as ISubtitleControlListItem[];
    const source = await findAITextReference(
      list,
      targetCode,
      payload.referenceId || getters.primarySubtitleId,
      referenceId => collectSourceCues(dispatch, referenceId),
    );
    if (!source) {
      log.warn('SubtitleManager', 'AI translate: no translatable source subtitle available');
      return undefined;
    }
    const { reference, cues: sourceCues } = source;

    const targetHash = `ai-${reference.hash}-${targetCode}`;
    const existing = list.find(sub => sub.hash === targetHash);
    if (existing) {
      await dispatch(a.manualChangePrimarySubtitle, existing.id);
      return existing;
    }
    if (!store.hasModule(reference.id)) return undefined;

    const languages = languagesFor(targetCode, normalizeCode(reference.language));
    // Resolve the built-in model or configured API before registering the
    // subtitle, so the realtime track never starts with an unusable provider.
    const plan = await translationPlan(aiPrefsOf(getters), languages);
    if (!plan.config) {
      log.warn('SubtitleManager', `AI translate: no provider available (${plan.reason})`);
      return undefined;
    }
    registerAITranslation(
      makeAITranslationKey(reference.hash, targetCode),
      sourceCues,
      plan.config,
      plan.options,
    );
    await dispatch(a.addSubtitle, {
      generator: new AITranslatedGenerator(reference.hash, targetCode),
      mediaHash: state.mediaHash,
    });
    const added = (getters.list as ISubtitleControlListItem[]).find(sub => sub.hash === targetHash);
    if (added) await dispatch(a.manualChangePrimarySubtitle, added.id);
    return added;
  },
  /**
   * Auto-offer AI translation when the video has no subtitle in the user's
   * language but does have some other subtitle to translate from. Guarded so a
   * failure here never disrupts normal subtitle loading.
   */
  /**
   * Translate the current subtitle now, because the user asked from the menu.
   *
   * Unlike `ensureAITranslation` this does not wait for the feature to be
   * enabled in Preferences, and does not bail out when a subtitle already exists
   * in the target language — the user asked for a translation, so make one and
   * show it.
   */
  async [a.translateWithAI]({ getters, dispatch }) {
    const targetCode = normalizeCode(
      getters.aiTranslateTargetLanguage || getters.displayLanguage || getters.primaryLanguage,
    );
    if (targetCode === LanguageCode.No || targetCode === LanguageCode.Default) {
      addBubble(AI_TRANSLATE_NO_SOURCE, { target: codeToLanguageName(targetCode) });
      return undefined;
    }
    const source = await findAITextReference(
      getters.list as ISubtitleControlListItem[],
      targetCode,
      getters.primarySubtitleId,
      referenceId => collectSourceCues(dispatch, referenceId),
    );
    // Nothing textual to translate from: image-only PGS subtitles need the same
    // speech-transcription fallback as a video that ships with no subtitles.
    if (!source) return dispatch(a.transcribeAndTranslate, { targetCode });

    // Nothing shows until a line is translated, so say so while it happens.
    showAIProgress(progressText('errorFile.aiProgress.translating', { done: 0, total: '?' }));
    const added = await dispatch(a.addAITranslatedSubtitle, {
      force: true, referenceId: source.reference.id,
    });
    if (!added) {
      endAIProgress();
      // A source exists, so anything left is a provider startup/configuration
      // failure.
      addBubble(AI_TRANSLATE_NO_PROVIDER);
      return undefined;
    }
    trackAIProgress(
      makeAITranslationKey(source.reference.hash, targetCode),
      (done, total) => progressText('errorFile.aiProgress.translating', { done, total }),
    );
    return added;
  },
  /**
   * Generate a subtitle from the video's own audio with whisper.cpp, then run it
   * through the normal AI translation so it comes out in the target language.
   *
   * Transcription is minutes of GPU work, so it is only ever started by an
   * explicit menu command, never automatically.
   */
  async [a.transcribeAndTranslate]({ state, getters, dispatch }, { targetCode }) {
    const { originSrc } = getters;
    if (!originSrc) return undefined;
    // The packaged app ships whisper-cli + ffmpeg in Resources/; prefer those so
    // a fresh Mac needs nothing installed. In dev we fall back to Homebrew.
    const bundled: BundledPaths = remote.app.isPackaged ? {
      binDir: join(process.resourcesPath, 'bin'),
      whisperDir: join(process.resourcesPath, 'whisper'),
    } : {};
    const userData = remote.app.getPath('userData');
    const home = remote.app.getPath('home');
    const probe = () => checkTranscribeEnvironment(userData, home, bundled);

    // With whisper + ffmpeg bundled, the only thing a fresh install lacks is the
    // model — fetch it once (with progress) instead of the command line.
    const env = await ensureTranscribeModel(probe(), probe, state.mediaHash);
    if (!env) return undefined; // download failed or already in progress
    if (!env.ok) {
      // Name exactly what is missing: "it didn't work" sends people hunting.
      addBubble(AI_TRANSLATE_NO_WHISPER, { missing: env.missing.join(', ') });
      log.warn('SubtitleManager', `AI transcribe: missing ${env.missing.join(', ')}`);
      return undefined;
    }
    if (transcribingMediaHash === state.mediaHash) return undefined; // already running
    const mediaHash = state.mediaHash;
    transcribingMediaHash = mediaHash;
    // Two phases to wait through, and nothing on screen during either.
    showAIProgress(progressText('errorFile.aiProgress.transcribing', { percent: 0 }));
    transcribeAbort = new AbortController();
    const { signal } = transcribeAbort;
    let added: ISubtitleControlListItem | undefined;
    let key = '';
    let trackCreationFailed = false;
    try {
      const { cues } = await transcribeVideo(originSrc, env, {
        tmpDir: remote.app.getPath('temp'),
        // The player already opened the source, so reuse its duration instead
        // of probing a network share or URL a second time before progress starts.
        duration: getters.duration,
        language: whisperLanguageOf(getters.aiTranscribeLanguage),
        signal,
        onProgress: (percent) => {
          if (signal.aborted || state.mediaHash !== mediaHash) return;
          if (aiProgressTimer === undefined) {
            updateAIProgress(progressText('errorFile.aiProgress.transcribing', { percent }));
          }
        },
        // Each chunk is shown as soon as it lands: whisper runs far faster than
        // playback, so the viewer starts watching in seconds instead of waiting
        // for a three-hour file to finish.
        onCues: async (chunk, info) => {
          if (signal.aborted || state.mediaHash !== mediaHash) return;
          // Report transcription progress even for a silent chunk, otherwise a
          // long musical opening looks like a hang.
          if (aiProgressTimer === undefined) {
            updateAIProgress(progressText('errorFile.aiProgress.transcribing', {
              percent: Math.round((info.done / info.total) * 100),
            }));
          }
          if (!chunk.length) return;
          if (added && key) {
            appendAITranslationCues(key, chunk);
            return;
          }
          if (trackCreationFailed) return;
          try {
            const entity = await dispatch(a.addTranscribedSubtitle, {
              targetCode, language: info.language, cues: chunk, mediaHash,
            });
            if (signal.aborted || state.mediaHash !== mediaHash) return;
            added = entity;
            if (!entity) {
              trackCreationFailed = true;
              return;
            }
            key = makeAITranslationKey(`whisper-${mediaHash}`, targetCode);
            // Speech is found; from here the wait is the translation.
            trackAIProgress(key, (done, total) => progressText(
              'errorFile.aiProgress.translating', { done, total },
            ));
          } catch (error) {
            trackCreationFailed = true;
            log.warn('SubtitleManager', error);
          }
        },
      });
      if (signal.aborted || state.mediaHash !== mediaHash) return undefined;
      if (!cues.length) {
        endAIProgress();
        addBubble(AI_TRANSCRIBE_NO_SPEECH);
        return undefined;
      }
      return added;
    } catch (error) {
      // An abort is us stopping it on purpose, not a failure to report.
      if (signal.aborted) return undefined;
      log.warn('SubtitleManager', error);
      endAIProgress();
      addBubble(AI_TRANSCRIBE_FAILED);
      return undefined;
    } finally {
      transcribingMediaHash = '';
      transcribeAbort = undefined;
    }
  },
  /**
   * Register whisper's cues as the source for an AI-translated track, so the
   * existing translator, cache and cue rendering are reused as-is.
   */
  async [a.addTranscribedSubtitle]({ state, getters, dispatch }, {
    targetCode, language, cues, mediaHash,
  }: {
    targetCode: LanguageCode,
    language: string,
    cues: TimedText[],
    mediaHash: string,
  }) {
    if (state.mediaHash !== mediaHash) return undefined;
    const sourceCode = normalizeCode(language);
    const languages = languagesFor(targetCode, sourceCode);
    const plan = await translationPlan(aiPrefsOf(getters), languages);
    if (!plan.config) {
      addBubble(AI_TRANSLATE_NO_PROVIDER);
      log.warn('SubtitleManager', `AI transcribe: no provider (${plan.reason})`);
      return undefined;
    }
    if (state.mediaHash !== mediaHash) return undefined;
    // A distinct reference hash per media, so a transcript is never confused
    // with a translation of a real subtitle track.
    const referenceHash = `whisper-${mediaHash}`;
    registerAITranslation(
      makeAITranslationKey(referenceHash, targetCode),
      cues,
      plan.config,
      plan.options,
    );
    await dispatch(a.addSubtitle, {
      generator: new AITranslatedGenerator(referenceHash, targetCode),
      mediaHash,
    });
    if (state.mediaHash !== mediaHash) return undefined;
    const targetHash = `ai-${referenceHash}-${targetCode}`;
    const added = (getters.list as ISubtitleControlListItem[]).find(sub => sub.hash === targetHash);
    if (added) await dispatch(a.manualChangePrimarySubtitle, added.id);
    return added;
  },
  async [a.ensureAITranslation]({ getters, dispatch }) {
    try {
      if (!getters.canTranslateWithAI) return;
      const targetCode = normalizeCode(
        getters.aiTranslateTargetLanguage || getters.displayLanguage || getters.primaryLanguage,
      );
      if (targetCode === LanguageCode.No || targetCode === LanguageCode.Default) return;
      const list = getters.list as ISubtitleControlListItem[];
      const hasTargetLanguage = list.some(sub => sub.type !== Type.AITranslated
        && normalizeCode(sub.language) === targetCode);
      if (hasTargetLanguage) return;
      if (!pickAIReference(list, targetCode, getters.primarySubtitleId)) return;
      await dispatch(a.addAITranslatedSubtitle, {});
    } catch (error) {
      log.warn('SubtitleManager', error);
    }
  },
  async [a.autoChangeSecondarySubtitle]({
    dispatch, commit, getters, state,
  }, selection: SubtitleSelection) {
    const { id, explicit } = unpackSubtitleSelection(selection);
    const lastSelected = [state.primarySubtitleId, state.secondarySubtitleId];
    if (getters.subtitleOff && !explicit) commit(m.setSecondarySubtitleId, '');
    else {
      let primaryId = state.primarySubtitleId;
      const secondaryId = id;

      if (primaryId === secondaryId) {
        primaryId = '';
        if (!secondaryId) commit(m.setNotSelectedSubtitle);
        else commit(m.setNotSelectedSubtitle, 'primary');
      }

      if (!secondaryId) commit(m.setNotSelectedSubtitle, 'secondary');
      else {
        commit(m.setSecondarySubtitleId, secondaryId);
        if (state.allSubtitles[secondaryId]) {
          commit(m.setSecondaryDelay, state.allSubtitles[secondaryId].delay);
        }
      }

      const finalSelected = [state.primarySubtitleId, state.secondarySubtitleId];
      difference(lastSelected, finalSelected).forEach((id) => {
        if (store.hasModule(id)) dispatch(`${id}/${subActions.pause}`);
      });
      difference(finalSelected, lastSelected).forEach((id) => {
        if (store.hasModule(id)) dispatch(`${id}/${subActions.resume}`);
      });

      dispatch(a.storeSelectedSubtitles, [primaryId, secondaryId]);
    }
  },
  async [a.manualChangeSecondarySubtitle]({ dispatch, commit, state }, id: string) {
    dispatch('setSubtitleOff', !id)
      .catch(error => log.warn('SubtitleManager store subtitle preference', error));
    if (!id) await dispatch(a.autoChangePrimarySubtitle, '');
    else if (!state.primarySubtitleId) commit(m.setNotSelectedSubtitle, 'primary');
    await dispatch(a.autoChangeSecondarySubtitle, { id, explicit: !!id });
  },
  async [a.storeSelectedSubtitles]({ state }, ids: string[]) {
    const { allSubtitles, mediaHash } = state;
    // 位置有意义：[0] 是主字幕，[1] 是副字幕，所以不能用 filter 压缩数组，
    // 否则主字幕被跳过时副字幕会被提升成主字幕。
    const subtitles = ids
      .map((id) => {
        const subtitle = allSubtitles[id];
        if (!subtitle) return undefined;
        const source = subtitle.displaySource;
        if (!source || !source.source) return undefined;
        // AI 字幕只存在于当前会话（见 services/subtitle/ai/registry），不在 preference.list 里。
        // 存下来的话下次打开会因为在列表里找不到对应条目而选不中任何字幕。
        if (source.type === Type.AITranslated) return undefined;
        return { hash: subtitle.hash, source };
      });
    storeSelectedSubtitles(subtitles as SelectedSubtitle[], mediaHash);
  },
  async [a.chooseSelectedSubtitles](
    { getters, dispatch },
    { primary, secondary }: { primary: SelectedSubtitle, secondary?: SelectedSubtitle },
  ) {
    const { list } = getters as { list: ISubtitleControlListItem[] };
    let primaryId = '';
    let secondaryId = '';
    if (primary) {
      let subtitles = list
        .filter((sub: ISubtitleControlListItem) => sub.hash === primary.hash);
      if (subtitles.length > 1) {
        subtitles = subtitles.filter(sub => isEqual(sub.source, primary.source));
      }
      if (subtitles.length) primaryId = subtitles[0].id;
    }
    if (secondary) {
      let subtitles = list
        .filter((sub: ISubtitleControlListItem) => sub.hash === secondary.hash);
      if (subtitles.length > 1) {
        subtitles = subtitles.filter(sub => isEqual(sub.source, secondary.source));
      }
      if (subtitles.length) secondaryId = subtitles[0].id;
    }
    return Promise.all([
      dispatch(a.autoChangePrimarySubtitle, primaryId),
      dispatch(a.autoChangeSecondarySubtitle, secondaryId),
    ]).then(() => {
      primarySelectionComplete = true;
      secondarySelectionComplete = true;
    });
  },
  async [a.startAISelection]({ dispatch }) {
    unwatch = store.watch(
      (state: ISubtitleManagerState, getters: { list: ISubtitleControlListItem[] }) => getters.list
        .map(({
          id, type, source, language,
        }) => ({
          id, type, source, language,
        })),
      () => dispatch(a.checkSubtitleList),
    );
  },
  [a.checkSubtitleList]({ getters, dispatch, commit }) {
    const { list } = getters as { list: ISubtitleControlListItem[] };
    if (list.length) {
      const { primaryLanguage, secondaryLanguage } = getters;
      if (!primarySelectionComplete || !secondarySelectionComplete) {
        const hasPrimaryLanguage = list
          .find(({ language, type }) => language === primaryLanguage
            && type !== Type.Translated);
        const hasSecondaryLanguage = list
          .find(({ language, type }) => language === secondaryLanguage
            && type !== Type.Translated);
        if (hasPrimaryLanguage) {
          dispatch(a.autoChangePrimarySubtitle, hasPrimaryLanguage.id);
          primarySelectionComplete = true;
          if (hasSecondaryLanguage) {
            dispatch(a.autoChangeSecondarySubtitle, hasSecondaryLanguage.id);
            secondarySelectionComplete = true;
          }
        } else if (hasSecondaryLanguage) {
          if (primarySelectionComplete) {
            dispatch(a.autoChangeSecondarySubtitle, hasSecondaryLanguage.id);
            secondarySelectionComplete = true;
          } else {
            dispatch(a.autoChangePrimarySubtitle, hasSecondaryLanguage.id);
            dispatch(a.autoChangeSecondarySubtitle, '');
            primarySelectionComplete = true;
            secondarySelectionComplete = true;
          }
        } else if (!getters.subtitleOff) {
          commit(m.setNotSelectedSubtitle);
        }
        if (primarySelectionComplete && secondarySelectionComplete) dispatch(a.stopAISelection);
      }
    }
  },
  async [a.stopAISelection]({
    dispatch,
  }) {
    if (!secondarySelectionComplete) {
      dispatch(a.autoChangeSecondarySubtitle, '');
    }
    if (!primarySelectionComplete) {
      dispatch(a.autoChangePrimarySubtitle, '');
    }
    if (typeof unwatch === 'function') unwatch();
  },
  async [a.getCues]({ dispatch, getters }, time?: number) {
    const firstSub = {
      cues: [],
      subPlayResX: 720,
      subPlayResY: 405,
    };
    const secondSub = {
      cues: [],
      subPlayResX: 720,
      subPlayResY: 405,
    };
    if (getters.primarySubtitleId && store.hasModule(getters.primarySubtitleId)) {
      try {
        const { metadata = {}, dialogues = [] } = await dispatch(`${getters.primarySubtitleId}/${subActions.getDialogues}`, time);
        firstSub.cues = dialogues;
        if (metadata) {
          if (metadata.PlayResX) firstSub.subPlayResX = parseInt(metadata.PlayResX, 10);
          if (metadata.PlayResY) firstSub.subPlayResY = parseInt(metadata.PlayResY, 10);
        }
      } catch (error) {
        log.error('SubtitleManager', error);
      }
    }

    if (getters.enabledSecondarySub
      && getters.secondarySubtitleId
      && store.hasModule(getters.secondarySubtitleId)) {
      try {
        const { metadata = {}, dialogues = [] } = await dispatch(`${getters.secondarySubtitleId}/${subActions.getDialogues}`, time);
        secondSub.cues = dialogues;
        if (metadata) {
          if (metadata.PlayResX) firstSub.subPlayResX = parseInt(metadata.PlayResX, 10);
          if (metadata.PlayResY) firstSub.subPlayResY = parseInt(metadata.PlayResY, 10);
        }
      } catch (error) {
        log.error('SubtitleManager', error);
      }
    }
    return [firstSub, secondSub];
  },
  async [a.updatePlayedTime](
    { state, dispatch, getters },
    times: { start: number, end: number },
  ) {
    const actions: Promise<unknown>[] = [];
    if (times.start !== times.end) {
      const { primarySubtitleId, secondarySubtitleId } = state;
      const bubbleId = `${Date.now()}-${Math.random()}`;
      if (primarySubtitleId && store.hasModule(primarySubtitleId)) {
        actions.push(
          dispatch(`${primarySubtitleId}/${subActions.updatePlayedTime}`, times)
            .then((playedTime: number) => {
              if (playedTime >= getters.duration * 0.6) {
                addBubble(SUBTITLE_UPLOAD, { id: `${SUBTITLE_UPLOAD}-${bubbleId}` });
                dispatch(`${primarySubtitleId}/${subActions.upload}`).then((result: boolean) => {
                  const bubbleType = result ? UPLOAD_SUCCESS : UPLOAD_FAILED;
                  addBubble(bubbleType, { id: `${bubbleType}-${bubbleId}` });
                });
              }
            }),
        );
      }
      if (secondarySubtitleId && store.hasModule(secondarySubtitleId)) {
        actions.push(
          dispatch(`${secondarySubtitleId}/${subActions.updatePlayedTime}`, times)
            .then((playedTime: number) => {
              if (playedTime >= getters.duration * 0.6) {
                addBubble(SUBTITLE_UPLOAD, { id: `${SUBTITLE_UPLOAD}-${bubbleId}` });
                dispatch(`${secondarySubtitleId}/${subActions.upload}`).then((result: boolean) => {
                  const bubbleType = result ? UPLOAD_SUCCESS : UPLOAD_FAILED;
                  addBubble(bubbleType, { id: `${bubbleType}-${bubbleId}` });
                });
              }
            }),
        );
      }
    }
    return Promise.all(actions);
  },
  async [a.manualUploadAllSubtitles]({ state, dispatch, rootGetters }) {
    if (navigator.onLine) {
      const { primarySubtitleId, secondarySubtitleId } = state;
      const isAllImages = [primarySubtitleId, secondarySubtitleId]
        .filter(id => store.hasModule(id))
        .every(id => rootGetters[`${id}/isImage`]);
      if (!isAllImages) addBubble(SUBTITLE_UPLOAD);
      const actions: Promise<number>[] = [];
      if (primarySubtitleId && store.hasModule(primarySubtitleId)) actions.push(dispatch(`${primarySubtitleId}/${subActions.manualUpload}`));
      if (secondarySubtitleId && store.hasModule(secondarySubtitleId)) actions.push(dispatch(`${secondarySubtitleId}/${subActions.manualUpload}`));
      return Promise.all(actions)
        .then((result: number[]) => {
          result = result.filter(res => res >= 0);
          if (result.length) addBubble(result.every(res => res) ? UPLOAD_SUCCESS : UPLOAD_FAILED);
          else addBubble(CANNOT_UPLOAD);
        });
    }
    return addBubble(UPLOAD_FAILED);
  },
  async [a.alterPrimaryDelay]({ state, dispatch, commit }, deltaInSeconds: number) {
    const { primarySubtitleId } = state;
    if (!store.hasModule(primarySubtitleId)) return;
    const delay = await dispatch(`${primarySubtitleId}/${subActions.alterDelay}`, deltaInSeconds);
    commit(m.setPrimaryDelay, delay);
    setDelayTimeout();
  },
  async [a.resetPrimaryDelay]({ state, dispatch, commit }) {
    const { primarySubtitleId } = state;
    await dispatch(`${primarySubtitleId}/${subActions.resetDelay}`);
    commit(m.setPrimaryDelay, 0);
    setDelayTimeout();
  },
  async [a.alterSecondaryDelay]({ state, dispatch, commit }, deltaInSeconds: number) {
    const { secondarySubtitleId } = state;
    const delay = await dispatch(`${secondarySubtitleId}/${subActions.alterDelay}`, deltaInSeconds);
    commit(m.setSecondaryDelay, delay);
    setDelayTimeout();
  },
  async [a.resetSecondaryDelay]({ state, dispatch, commit }) {
    const { secondarySubtitleId } = state;
    await dispatch(`${secondarySubtitleId}/${subActions.resetDelay}`);
    commit(m.setSecondaryDelay, 0);
    setDelayTimeout();
  },
  async [a.storeSubtitleDelays]({ getters, state }) {
    const list = getters.list.map(({ id }: ISubtitleControlListItem) => getters[`${id}/entity`]);
    updateSubtitleList(list, state.mediaHash);
  },
  // eslint-disable-next-line complexity
  async [a.exportSubtitle]({
    getters, dispatch, rootState, rootGetters,
  }, item: ISubtitleControlListItem) {
    const $bus = rendererEventBus;
    // if (process.windowsStore) {
    //   addBubble(APPX_EXPORT_NOT_WORK);
    //   return;
    // }
    const isImage = store.hasModule(item.id) && !!rootGetters[`${item.id}/isImage`];
    if (isImage) {
      $bus.$emit('embedded-subtitle-can-not-export', 'image');
      return;
    }
    // if (!getters.token || !(getters.userInfo && getters.userInfo.isVip)) {
    //   dispatch(usActions.SHOW_FORBIDDEN_MODAL, 'export');
    //   dispatch(usActions.UPDATE_SIGN_IN_CALLBACK, () => {
    //     dispatch(usActions.HIDE_FORBIDDEN_MODAL);
    //     dispatch(a.exportSubtitle, item);
    //   });
    //   return;
    // }
    const subtitle = rootState[item.id];
    if (item && item.type === Type.Embedded && (!subtitle || !subtitle.fullyRead)) {
      // Embedded not cache
      $bus.$emit('embedded-subtitle-can-not-export');
      return;
    }
    const delay = subtitle && subtitle.delay ? subtitle.delay : 0;
    const subName = item.name || '';
    const localName = `${basename(subName, extname(subName))}`;
    if (item) {
      const { dialog } = remote;
      const browserWindow = remote.BrowserWindow;
      const focusWindow = browserWindow.getFocusedWindow();
      const originSrc = getters.originSrc;
      const videoName = `${basename(originSrc, extname(originSrc))}`;
      const left = originSrc.split(videoName)[0];
      const lang = item.language ? `-${codeToLanguageName(item.language)}` : '';
      const name = item.type === Type.Local ? localName : `${videoName}${lang}`;
      const fileName = `${basename(name, '.srt')}.srt`;
      const defaultPath = join(left, fileName);
      if (focusWindow) {
        dialog.showSaveDialog(focusWindow, {
          defaultPath,
        }).then(async (value: SaveDialogReturnValue) => {
          if (value.filePath) {
            const { dialogues = [] } = await dispatch(`${getters.primarySubtitleId}/${subActions.getDialogues}`, undefined);
            const cues = cloneDeep(dialogues);
            cues.forEach((e: Cue) => {
              e.start += delay;
              e.end += delay;
            });
            const str = sagiSubtitleToSRT(cues);
            try {
              write(value.filePath, Buffer.from(`\ufeff${str}`, 'utf8'));
            } catch (err) {
              log.error('exportSubtitle', err);
            }
            dispatch('UPDATE_DEFAULT_DIR', value.filePath);
          }
        }).catch((error: Error) => console.warn(error));
      }
    }
  },
};

const SubtitleManager: Module<ISubtitleManagerState, {}> = {
  state,
  getters,
  mutations,
  actions,
};

export default SubtitleManager;
