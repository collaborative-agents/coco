## `external_api`

### Model providers

`external_api/llm.py` provides a provider-agnostic LLM wrapper, so a single `provider/model` ID is enough to switch backends. A recognized prefix selects an alternate backend; anything else falls through to [LiteLLM](https://docs.litellm.ai/docs/providers).

> **⚠️ Privacy.** Coco's observer is multimodal: it sends **screenshots of your screen** to whichever model you select, so your provider choice determines where those pixels go. The following approaches offer stronger privacy guarantees than standard cloud APIs:
> - Self-hosted VLMs, e.g., via [vLLM](https://github.com/vllm-project/vllm), [LM Studio](https://lmstudio.ai/)
> - Trusted Execution Environment (TEE) providers — open-weight models hosted on attested secure hardware, e.g. [Tinfoil](https://tinfoil.sh/)
> - [Unlinkable inference](https://openanonymity.ai/blog/unlinkable-inference/) — relays requests to any model provider while adding confidentiality, e.g. [Open Anonymity](https://chat.openanonymity.ai/)


| Prefix       | Backend                                                            | Example handle                                                                 | Requires                                                                        | Where your data goes                       |
| ------------ | ------------------------------------------------------------------ | ------------------------------------------------------------------------------ | ------------------------------------------------------------------------------- | ------------------------------------------ |
| `hosted_vllm/` | **vLLM** — your own OpenAI-compatible [vLLM](https://docs.vllm.ai/) server, via LiteLLM | `hosted_vllm/Qwen/Qwen3.5-35B-A3B` | `HOSTED_VLLM_API_BASE` (e.g. `http://localhost:8000/v1`); optional `HOSTED_VLLM_API_KEY` | Stays on your own server / infra           |
| `lm_studio/` | **LM Studio** — local server (default `localhost:1234`)            | `lm_studio/nvidia/nemotron-3-nano-omni`                                        | LM Studio running; optional `LM_STUDIO_HOST`                                    | Stays on your machine                      |
| `tinfoil/`   | **Tinfoil** — confidential inference in attested hardware enclaves | `tinfoil/gemma4-31b`                                                         | `TINFOIL_API_KEY`                                                               | A verified enclave the provider can't read |
| `oa/`        | **Open Anonymity Project** — unlinkable relay                      | `oa/openai/gpt-5.2-chat`                                                       | `OA_TICKET_FILE` (+ optional `OA_DESTINATION`, `OA_BASE_URL`)                   | Relayed so queries aren't linkable to you  |
| *(none)*     | **LiteLLM** → Anthropic / Google / OpenAI / …                      | `anthropic/claude-sonnet-4-6`, `gemini/gemini-3-pro-preview`, `openai/gpt-5.2` | `ANTHROPIC_API_KEY` / `GEMINI_API_KEY` (or `GOOGLE_API_KEY`) / `OPENAI_API_KEY` / ... | The provider's cloud                       |
