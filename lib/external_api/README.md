## `external_api`

### Model providers

In desktop **Settings → Models & providers**, connect a provider through Pi once,
then select **Connected through Pi** for a sensing or tutor model. Instant
suggestions can use any configured tutor model, or follow the default chat model.
Sensing requires image support. Models receiving screenshots in suggestions must
also support images; unsupported input produces an error rather than silently
routing to another provider.

Pi-backed entries use `pi/<provider>/<model>` internally. Python services call an
authenticated loopback inference bridge started by the desktop app; Pi retains
its provider credentials. These calls do not create agent sessions or execute Pi
file/command tools. Coco still owns sensing prompts and suggestion memory tools.
The bridge requires the running desktop app; standalone Python CLI use continues
to support the existing configured providers below. Pi inference currently
accepts text, inline images, and function tools, but not audio input.

Existing model configurations are retained. A legacy Pi chat override becomes a
shared model entry, while the previous sensing and instant-suggestion assignments
are preserved. Saving settings completes the migration.

`external_api/llm.py` provides a provider-agnostic LLM wrapper, so a single `provider/model` ID is enough to switch backends. A recognized prefix selects an alternate backend; anything else falls through to [LiteLLM](https://docs.litellm.ai/docs/providers).

> **⚠️ Privacy.** Coco's observer is multimodal: it sends **screenshots of your screen** to whichever model you select, so your provider choice determines where those pixels go. The following approaches offer stronger privacy guarantees than standard cloud APIs:
> - Self-hosted VLMs, e.g., via [vLLM](https://github.com/vllm-project/vllm), [LM Studio](https://lmstudio.ai/)
> - Trusted Execution Environment (TEE) providers — open-weight models hosted on attested secure hardware, e.g. [Tinfoil](https://tinfoil.sh/)
> - [Unlinkable inference](https://openanonymity.ai/blog/unlinkable-inference/) — relays requests to any model provider while adding confidentiality, e.g. [Open Anonymity](https://chat.openanonymity.ai/)


| Prefix       | Backend                                                            | Example handle                                                                 | Requires                                                                        | Where your data goes                       |
| ------------ | ------------------------------------------------------------------ | ------------------------------------------------------------------------------ | ------------------------------------------------------------------------------- | ------------------------------------------ |
| `pi/` | **Pi-connected provider** | `pi/<provider>/<model>` | Running desktop app and connected Pi provider | The selected provider |
| `hosted_vllm/` | **OpenAI-compatible endpoint** — local, self-hosted, or managed (including vLLM, NV Inference, and Inkling), via LiteLLM | `hosted_vllm/Qwen/Qwen3.5-35B-A3B` | `HOSTED_VLLM_API_BASE` (the endpoint's `/v1` URL); optional `HOSTED_VLLM_API_KEY` | Depends on the endpoint you choose |
| `lm_studio/` | **LM Studio** — local server (default `localhost:1234`)            | `lm_studio/nvidia/nemotron-3-nano-omni`                                        | LM Studio running; optional `LM_STUDIO_HOST`                                    | Stays on your machine                      |
| `tinfoil/`   | **Tinfoil** — confidential inference in attested hardware enclaves | `tinfoil/gemma4-31b`                                                         | `TINFOIL_API_KEY`                                                               | A verified enclave the provider can't read |
| `oa/`        | **Open Anonymity Project** — unlinkable relay                      | `oa/openai/gpt-5.2-chat`                                                       | `OA_TICKET_FILE` (+ optional `OA_DESTINATION`, `OA_BASE_URL`)                   | Relayed so queries aren't linkable to you  |
| *(none)*     | **LiteLLM** → Anthropic / Google / OpenAI / …                      | `anthropic/claude-sonnet-4-6`, `gemini/gemini-3-pro-preview`, `openai/gpt-5.2` | `ANTHROPIC_API_KEY` / `GEMINI_API_KEY` (or `GOOGLE_API_KEY`) / `OPENAI_API_KEY` / ... | The provider's cloud                       |
