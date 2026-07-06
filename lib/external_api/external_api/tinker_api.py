import asyncio
import os
from functools import cache

import tinker
from tinker import types
from tinker_cookbook import renderers
from tinker_cookbook.model_info import get_recommended_renderer_name
from tinker_cookbook.tokenizer_utils import Tokenizer, get_tokenizer


@cache
def load_tokenizer(model_name: str) -> Tokenizer:
    """Load a tokenizer, working around upstream Kimi-K2.6 bug.

    tinker_cookbook 0.4.1 has a fallback that constructs Kimi-K2.6's custom
    ``TikTokenTokenizerFast`` from a local cache path, but it only runs if
    ``AutoTokenizer.from_pretrained`` first returns a generic
    ``TokenizersBackend``. With our pinned transformers<5, the custom class
    is returned directly and crashes in __init__ before the fallback can
    fire (``Missing tokenizer files under: moonshotai/Kimi-K2.6`` — the
    custom ``from_pretrained`` writes the bare HF id into ``model_root``).
    HF transformers PR #45908 fixes this on the v5.x line, but we're capped
    at <5 by sentence-transformers==3.4.1 [[feedback-sentence-transformers-pin]].

    Recovery: the cookbook's failed call still downloads the necessary files
    into the HF cache as a side effect. We catch the failure, locate the
    freshly-cached snapshot directory, and instantiate the custom class
    ourselves with a real path. No revision is hard-coded — we ride on
    whichever revision the cookbook chose to download.
    """
    if model_name != "moonshotai/Kimi-K2.6":
        return get_tokenizer(model_name)

    try:
        return get_tokenizer(model_name)
    except ValueError as e:
        if "Missing tokenizer files under:" not in str(e):
            raise

    required = ("tokenizer.json", "tiktoken.model")
    snapshot_dir = _find_cached_snapshot_with(model_name, required)
    if snapshot_dir is None:
        raise RuntimeError(
            f"Could not locate cached tokenizer files {required} for "
            f"{model_name} after the tinker_cookbook download attempt."
        )

    from transformers.dynamic_module_utils import get_class_from_dynamic_module

    # The snapshot dir name is the commit hash — what get_class_from_dynamic_module
    # needs to fetch the matching .py module for the same revision.
    revision = os.path.basename(snapshot_dir)
    cls = get_class_from_dynamic_module(
        "tokenization_kimi_fast.TikTokenTokenizerFast",
        model_name,
        revision=revision,
    )
    return cls.from_pretrained(snapshot_dir)


def _find_cached_snapshot_with(
    model_name: str, required_files: tuple[str, ...]
) -> str | None:
    """Return the most recent HF-cache snapshot dir for `model_name` holding all `required_files`."""
    from huggingface_hub.constants import HF_HUB_CACHE

    snapshots_root = os.path.join(
        HF_HUB_CACHE, "models--" + model_name.replace("/", "--"), "snapshots"
    )
    if not os.path.isdir(snapshots_root):
        return None
    candidates = [
        os.path.join(snapshots_root, snap) for snap in os.listdir(snapshots_root)
    ]
    candidates = [
        d
        for d in candidates
        if all(os.path.exists(os.path.join(d, f)) for f in required_files)
    ]
    if not candidates:
        return None
    candidates.sort(key=os.path.getmtime, reverse=True)
    return candidates[0]


def get_text_from_output(message: renderers.Message) -> str:
    """Extract the plain assistant text from a Tinker completion.

    For non-thinking models, ``message["content"]`` is a plain string. For
    thinking models (Qwen3, DeepSeek-V3, Kimi-K2, ...) it's a list of parts
    like ``[{"type": "thinking", ...}, {"type": "text", "text": "..."}]``.
    This helper returns just the concatenated text, dropping any thinking
    blocks, so callers don't have to branch on the shape.
    """
    content = message["content"]
    if isinstance(content, str):
        return content
    return "".join(part["text"] for part in content if part["type"] == "text")


class TinkerSampler:
    """A simple wrapper around Tinker ServiceClient to do sampling."""

    def __init__(
        self,
        service_account: tinker.ServiceClient,
        model_name: str,
        model_path: str
        | None = None,  # tinker://..., obtained from Tinker training job
        temperature: float = 0.9,
        max_tokens=1024,
        top_p=1,
        top_k=-1,  # -1 means no limit
        tokenizer: Tokenizer | None = None,
    ):
        self.service_client = service_account
        # Building the tokenizer can be slow (especially Kimi-K2.6, which has
        # to recover from a tinker_cookbook crash); callers constructing many
        # TinkerSamplers for the same model_name should build it once with
        # `load_tokenizer(model_name)` and pass it in.
        if tokenizer is None:
            tokenizer = load_tokenizer(model_name)
        renderer_name = get_recommended_renderer_name(model_name)
        self.renderer = renderers.get_renderer(name=renderer_name, tokenizer=tokenizer)
        self.sampling_params = types.SamplingParams(
            max_tokens=max_tokens,
            temperature=temperature,
            top_p=top_p,
            top_k=top_k,
            stop=self.renderer.get_stop_sequences(),
        )
        self.sampling_client = self.service_client.create_sampling_client(
            model_path=model_path,
            base_model=model_name,
        )

    async def generate(self, messages: list[renderers.Message]) -> renderers.Message:
        model_input: types.ModelInput = self.renderer.build_generation_prompt(messages)
        response = await self.sampling_client.sample_async(
            prompt=model_input,
            num_samples=1,
            sampling_params=self.sampling_params,
        )
        tokens: list[int] = response.sequences[0].tokens
        output, _ = self.renderer.parse_response(tokens)

        return output


def get_tinker_completion_sync(
    messages: list[renderers.Message],
    service_account: tinker.ServiceClient | None = None,
    model_name: str | None = None,
    model_path: str | None = None,
    temperature: float = 0.9,
    max_tokens=1024,
    top_p=1,
    top_k=-1,  # -1 means no limit
    sampler: TinkerSampler | None = None,
    tokenizer: Tokenizer | None = None,
) -> renderers.Message:
    """Get completion from Tinker Service.

    If `sampler` is provided it is reused, avoiding the cost of constructing
    a new SamplingClient per call. When `sampler` is provided, the
    service_account / model_name / model_path / temperature / max_tokens /
    top_p / top_k / tokenizer arguments are ignored (those were baked in at
    sampler construction time).

    `tokenizer` is forwarded to TinkerSampler when one is constructed; pass
    a pre-built tokenizer to amortize the tokenizer-loading cost when the
    same model is used across many sampler instances.
    """
    if sampler is None:
        assert service_account is not None, (
            "Either sampler or service_account must be provided"
        )
        assert model_name is not None, "Either sampler or model_name must be provided"
        sampler = TinkerSampler(
            service_account=service_account,
            model_name=model_name,
            model_path=model_path,
            temperature=temperature,
            max_tokens=max_tokens,
            top_p=top_p,
            top_k=top_k,
            tokenizer=tokenizer,
        )

    coro = sampler.generate(messages)

    try:
        # No running event loop
        loop = asyncio.get_running_loop()
    except RuntimeError:
        loop = None

    if loop and loop.is_running():
        # If there is a running event loop (e.g., FastAPI), create a new temporary loop in a separate thread
        return asyncio.run_coroutine_threadsafe(coro, loop).result()
    else:
        # No running event loop — safe to run directly
        return asyncio.run(coro)


async def get_tinker_completion_async(
    messages: list[renderers.Message],
    service_account: tinker.ServiceClient | None = None,
    model_name: str | None = None,
    model_path: str | None = None,
    temperature: float = 0.9,
    max_tokens=1024,
    top_p=1,
    top_k=-1,  # -1 means no limit
    sampler: TinkerSampler | None = None,
    tokenizer: Tokenizer | None = None,
) -> renderers.Message:
    """Get completion from Tinker Service.

    If `sampler` is provided it is reused, avoiding the cost of constructing
    a new SamplingClient per call. When `sampler` is provided, the
    service_account / model_name / model_path / temperature / max_tokens /
    top_p / top_k / tokenizer arguments are ignored (those were baked in at
    sampler construction time).

    `tokenizer` is forwarded to TinkerSampler when one is constructed; pass
    a pre-built tokenizer to amortize the tokenizer-loading cost when the
    same model is used across many sampler instances.
    """
    if sampler is None:
        assert service_account is not None, (
            "Either sampler or service_account must be provided"
        )
        assert model_name is not None, "Either sampler or model_name must be provided"
        sampler = TinkerSampler(
            service_account=service_account,
            model_name=model_name,
            model_path=model_path,
            temperature=temperature,
            max_tokens=max_tokens,
            top_p=top_p,
            top_k=top_k,
            tokenizer=tokenizer,
        )

    return await sampler.generate(messages)
