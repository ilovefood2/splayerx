export {
  AITranslationError,
  translateLines,
  isTowerModel,
  DEFAULT_BASE_URL,
  DEFAULT_MODEL,
} from './translator';
export type { AITranslatorConfig, TranslateOptions } from './translator';
export { TranslationCache } from './cache';
export {
  RealtimeSubtitleTranslator,
} from './realtimeTranslator';
export type {
  TimedText,
  RealtimeTranslatorOptions,
  AuthFailover,
} from './realtimeTranslator';
export {
  checkTranscribeEnvironment,
  downloadModel,
  parseWhisperCues,
  parseWhisperProgress,
  parseFfmpegProgress,
  chunkPlanOf,
  whisperArgs,
  durationOf,
  transcribeVideo,
} from './transcribe';
export type {
  TranscribeTool,
  TranscribeEnvironment,
  BundledPaths,
  TranscribeResult,
  WhisperJson,
  TranscribeOptions,
  DownloadProgress,
  DownloadModelOptions,
} from './transcribe';
export {
  LOCAL_TUNING,
  isLocalhostUrl,
  resolveAIProvider,
  configFor,
} from './provider';
export type {
  AIProviderPreference,
  AIProviderKind,
  AIProviderReason,
  AIProviderPrefs,
  AIProviderTuning,
  AIProviderResolution,
} from './provider';
export {
  MANAGED_MODEL_NAME,
  MANAGED_MODEL_ALIAS,
  MANAGED_MODEL_SHA256,
  MANAGED_MODEL_URL,
  MANAGED_MODELS,
  DEFAULT_MANAGED_MODEL_ID,
  contentRangeTotal,
  sha256File,
  managedModelById,
  inspectManagedModel,
  ensureManagedModelFile,
  ensureManagedModelServer,
  stopManagedModelServer,
} from './managedModel';
export type {
  ManagedModelDefinition,
  ManagedModelPaths,
  ManagedModelStage,
  ManagedModelProgress,
  ManagedModelStatus,
  ManagedModelEndpoint,
  EnsureManagedModelOptions,
} from './managedModel';
export {
  makeAITranslationKey,
  registerAITranslation,
  hasAITranslation,
  appendAITranslationCues,
  getAITranslator,
  clearAITranslation,
  clearAllAITranslations,
} from './registry';
