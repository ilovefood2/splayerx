#include "common.h"
#include "json.hpp"
#include "llama.h"

#include <algorithm>
#include <cstdint>
#include <iostream>
#include <limits>
#include <string>
#include <tuple>
#include <vector>

using json = nlohmann::json;

static std::string translate(
    llama_model * model,
    llama_context * ctx,
    const std::string & prompt,
    int max_tokens) {
  llama_kv_cache_clear(ctx);
  std::vector<llama_token> input = llama_tokenize(ctx, prompt, true, true);
  if (input.empty()) throw std::runtime_error("translation prompt is empty");
  if (llama_encode(ctx, llama_batch_get_one(input.data(), input.size(), 0, 0)) != 0) {
    throw std::runtime_error("MADLAD encoder failed");
  }

  llama_token current = llama_model_decoder_start_token(model);
  if (current == -1) current = llama_token_bos(model);
  const int32_t vocab_size = llama_n_vocab(model);
  std::string result;
  int32_t position = 0;

  for (int generated = 0; generated < max_tokens; ++generated) {
    if (llama_decode(ctx, llama_batch_get_one(&current, 1, position, 0)) != 0) {
      throw std::runtime_error("MADLAD decoder failed");
    }
    position += 1;

    const float * logits = llama_get_logits_ith(ctx, -1);
    if (!logits) throw std::runtime_error("MADLAD returned no logits");
    llama_token next = 0;
    float best = -std::numeric_limits<float>::infinity();
    for (int32_t token = 0; token < vocab_size; ++token) {
      if (logits[token] > best) {
        best = logits[token];
        next = token;
      }
    }
    if (llama_token_is_eog(model, next)) break;
    result += llama_token_to_piece(ctx, next, false);
    current = next;
  }
  return result;
}

int main(int argc, char ** argv) {
  if (argc != 2) {
    std::cerr << "usage: splayer-madlad-worker MODEL.gguf\n";
    return 2;
  }

  llama_backend_init();
  gpt_params params;
  params.model = argv[1];
  params.n_ctx = 512;
  params.n_batch = 512;
  params.n_ubatch = 512;
  params.n_gpu_layers = 99;

  llama_model * model = nullptr;
  llama_context * ctx = nullptr;
  std::tie(model, ctx) = llama_init_from_gpt_params(params);
  if (!model || !ctx) {
    // Metal can reject an 8.8 GB allocation when the unified-memory working
    // set is already crowded. Retry on CPU so translation still works instead
    // of leaving the player stuck during model verification.
    if (ctx) llama_free(ctx);
    if (model) llama_free_model(model);
    model = nullptr;
    ctx = nullptr;
    params.n_gpu_layers = 0;
    std::cerr << "Metal model load failed; retrying MADLAD on CPU\n";
    std::tie(model, ctx) = llama_init_from_gpt_params(params);
  }
  if (!model || !ctx) {
    std::cerr << "unable to load MADLAD model\n";
    if (ctx) llama_free(ctx);
    if (model) llama_free_model(model);
    llama_backend_free();
    return 1;
  }
  if (!llama_model_has_encoder(model)) {
    std::cerr << "selected model is not an encoder-decoder model\n";
    llama_free(ctx);
    llama_free_model(model);
    llama_backend_free();
    return 1;
  }

  std::cout << json({ { "ready", true } }).dump() << std::endl;
  std::string line;
  while (std::getline(std::cin, line)) {
    json response;
    try {
      const json request = json::parse(line);
      response["id"] = request.at("id");
      const int requested = request.value("maxTokens", 512);
      const int max_tokens = std::max(1, std::min(requested, 1024));
      response["text"] = translate(model, ctx, request.at("prompt").get<std::string>(), max_tokens);
    } catch (const std::exception & error) {
      response["error"] = error.what();
    }
    std::cout << response.dump() << std::endl;
  }

  llama_free(ctx);
  llama_free_model(model);
  llama_backend_free();
  return 0;
}
