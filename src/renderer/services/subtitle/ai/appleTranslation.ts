import { spawn } from 'child_process';
import { join } from 'path';
import { AITranslationError, AITranslatorConfig, TranslateOptions } from './translator';

export interface AppleTranslationProbe {
  available: boolean;
  status: 'installed' | 'download-required' | 'unsupported' | 'unavailable';
  sourceLanguage?: string;
  message?: string;
}

interface HelperReply {
  ok: boolean;
  status?: AppleTranslationProbe['status'];
  translations?: string[];
  sourceLanguage?: string;
  message?: string;
}

function helperPath(): string {
  return join(process.resourcesPath, 'apple-translation', 'apple-translation-helper');
}

function runHelper(payload: object, timeout = 15000): Promise<HelperReply> {
  return new Promise((resolve, reject) => {
    const child = spawn(helperPath(), [], { stdio: ['pipe', 'pipe', 'pipe'] });
    let output = '';
    let errorOutput = '';
    let settled = false;
    const finish = (error?: Error, reply?: HelperReply) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      if (error) reject(error); else resolve(reply as HelperReply);
    };
    const timer = setTimeout(() => {
      child.kill();
      finish(new AITranslationError(`Apple Translation timed out after ${timeout}ms`));
    }, timeout);
    child.stdout.on('data', (data) => { output += data.toString(); });
    child.stderr.on('data', (data) => { errorOutput += data.toString(); });
    child.on('error', error => finish(new AITranslationError(
      `Apple Translation is unavailable: ${error.message}`,
    )));
    child.on('close', () => {
      try {
        const reply = JSON.parse(output.trim()) as HelperReply;
        if (!reply.ok) {
          finish(new AITranslationError(reply.message || 'Apple Translation is unavailable'));
          return;
        }
        finish(undefined, reply);
      } catch (error) {
        finish(new AITranslationError(
          `Apple Translation returned an invalid response${errorOutput ? `: ${errorOutput}` : ''}`,
        ));
      }
    });
    child.stdin.end(JSON.stringify(payload));
  });
}

export async function probeAppleTranslation(
  sourceLanguage: string | undefined,
  targetLanguage: string,
  sampleText: string,
): Promise<AppleTranslationProbe> {
  try {
    const reply = await runHelper({
      command: 'probe', sourceLanguage, targetLanguage, texts: [sampleText],
    }, 5000);
    return {
      available: reply.status === 'installed',
      status: reply.status || 'unavailable',
      sourceLanguage: reply.sourceLanguage,
      message: reply.message,
    };
  } catch (error) {
    return {
      available: false,
      status: 'unavailable',
      message: (error as Error).message,
    };
  }
}

export async function translateWithApple(
  texts: string[],
  config: AITranslatorConfig,
  options: TranslateOptions = {},
): Promise<string[]> {
  if (!texts.length) return [];
  const reply = await runHelper({
    command: 'translate',
    texts,
    sourceLanguage: config.sourceLanguageCode,
    targetLanguage: config.targetLanguageCode,
  }, options.timeout);
  if (!reply.translations || reply.translations.length !== texts.length) {
    throw new AITranslationError('Apple Translation returned an incomplete batch');
  }
  return reply.translations;
}
