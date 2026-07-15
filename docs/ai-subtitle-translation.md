# AI Realtime Subtitle Translation

An opt-in feature that translates an existing subtitle track into the viewer's
language on the fly using a Large Language Model. It is designed for the common
case where a video ships with subtitles in some language, but **not** in the
language the viewer wants.

It runs against **a local [Ollama](https://ollama.com) by default**, so it needs
no API key and no account, and the subtitle text never leaves the machine. If the
user does configure an OpenAI-compatible key, that is used instead.

The feature is **off by default**; nothing is translated until it is enabled in
*Preferences → Subtitle*.

## How it works

```
 existing subtitle track (e.g. English embedded/online/local)
        │  cues (text + timestamps)
        ▼
 resolveAIProvider() ──► local Ollama (no key)  ── or ──► your OpenAI-compatible API
        │
        ▼
 RealtimeSubtitleTranslator ──► translateLines() ──► /v1/chat/completions
        │  translates a look-ahead window as playback approaches each cue
        ▼
 AITranslatedParser  ──►  shown like any other subtitle track
```

## Choosing a provider

`Preferences → Subtitle → Provider`:

| Setting | Behaviour |
| ------- | --------- |
| **Automatic** (default) | Uses your API key if you set one, otherwise a local Ollama. |
| **Local Ollama only** | Always local, even if a key is set. Point *API Endpoint* at a non-default host if needed. |
| **OpenAI-compatible API only** | Never falls back to local; requires a key or a custom endpoint. |

The provider is resolved **once**, before translation starts, so no
unauthenticated request is ever sent: without a key we go straight to Ollama
rather than getting a 401 back from OpenAI (which would both leak the subtitle
text and permanently disable translation for the session). The one exception is a
key that turns out to be **rejected** at request time — in `Automatic` mode that
triggers a single failover to a local Ollama.

## Model selection

With Ollama we ask `/api/tags` and pick a model ourselves:

- **Embedding models are excluded.** They report `capabilities: ['embedding']`
  (e.g. `bge-m3`) and cannot chat at all.
- **Non-thinking models are strongly preferred.** Measured on this project's own
  prompt, a 16-line batch takes ~29s on `qwen3:14b` (which emits reasoning
  tokens) versus ~5s on the *larger* 30.5B `qwen3-coder`. For realtime subtitles
  latency dominates, so reasoning models are ranked down and parameter count is
  only a mild tiebreak.
- Setting *Model* explicitly always overrides the automatic pick.

A local model is much slower than a hosted one, so when running locally the
request timeout is raised to 120s and the look-ahead window to 90s (a cold model
load alone can take ~30s).

- When enabled, after subtitles finish loading the app checks whether a subtitle
  already exists in the target language. If not — and there is another track to
  translate from — it creates an **AI-translated** track and selects it
  (`SubtitleManager/ensureAITranslation`).
- Translation happens **ahead of the playhead**: cues starting within the next
  ~20 seconds are translated in the background, so a cue is usually ready by the
  time it appears. Until a cue is translated, its **original text** is shown, so
  subtitles never blank out.
- Results are cached (in-memory LRU) and identical lines are de-duplicated, so
  re-watching a segment costs nothing and repeated lines are translated once.
- Failures never interrupt playback: on network/auth errors — or a reply that
  cannot be aligned to the input — the original text keeps showing and the
  translator backs off exponentially before retrying (auth errors stop retrying
  entirely). An untranslated line is never cached as if it were a translation.
- AI tracks live only for the current session: they are not written to the
  subtitle database, the selection is not persisted, and the registry is cleared
  when the player switches media. The track is re-offered on each open instead.

## Configuration (Preferences → Subtitle)

| Field            | Meaning                                                        | Default                        |
| ---------------- | -------------------------------------------------------------- | ------------------------------ |
| Enable           | Master switch for the feature                                  | **off**                        |
| API Endpoint     | Base URL of an OpenAI-compatible API                           | `https://api.openai.com/v1`    |
| API Key          | Bearer token (stored locally, never uploaded elsewhere)        | empty                          |
| Model            | Chat model id                                                  | `gpt-4o-mini`                  |
| Translate Into   | Target language, or *Auto* to follow the app/display language  | Auto                           |

Any endpoint that speaks the OpenAI Chat Completions API works — OpenAI, a local
gateway such as Ollama's `/v1`, OpenRouter, Groq, etc. For local gateways that
need no auth, leave the key empty.

## Privacy

- Subtitle text for the cues around the current playhead is sent **only** to the
  endpoint the user configures. Requests go directly from the app to that
  endpoint.
- The API key is stored in the local preferences file and is **not** written to
  the subtitle cache/database and **not** part of any exported subtitle.
- AI-translated tracks are session-scoped: they are regenerated per playback
  rather than persisted, so a stored video never carries the key or the
  translation.

## Code map

| Path | Responsibility |
| ---- | -------------- |
| `src/renderer/services/subtitle/ai/translator.ts` | OpenAI-compatible batch translation over `fetch` (timeouts, robust JSON parsing, typed errors) |
| `src/renderer/services/subtitle/ai/realtimeTranslator.ts` | Look-ahead, cache, de-dup, back-off; turns cues + time into translated cues |
| `src/renderer/services/subtitle/ai/cache.ts` | Bounded LRU translation cache |
| `src/renderer/services/subtitle/ai/registry.ts` | Links an AI subtitle entity to its source cues + config (kept out of the DB) |
| `src/renderer/services/subtitle/loaders/aiTranslated.ts` | `AITranslatedGenerator` — describes the entity |
| `src/renderer/services/subtitle/parsers/aiTranslated.ts` | `AITranslatedParser` — realtime cue provider |
| `src/renderer/store/modules/SubtitleManager.ts` | `addAITranslatedSubtitle`, `ensureAITranslation`, `canTranslateWithAI` |
| `src/renderer/components/Preferences/Translate.vue` | Settings UI |

Unit tests: `test/unit/specs/services/subtitle/aiTranslator.spec.ts`.

## Scope / limitations

- This translates an **existing** subtitle track. If a video has *no* subtitle
  at all, there is nothing to translate — generating subtitles from audio needs
  speech recognition (ASR), which is a separate capability (the app already has
  a server-based speech-to-text flow under *AI Translate*).
- Quality and latency depend on the chosen model. Small/fast models
  (`gpt-4o-mini` and equivalents) are recommended for realtime use.
