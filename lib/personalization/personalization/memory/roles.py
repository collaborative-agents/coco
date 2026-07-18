"""The four self-evolving roles.

Generator — predict need_support on a labeled moment under the CURRENT memory,
            using the observer prompt shape with user_profile withheld.
Reflector — compare the prediction to the ground-truth label and distill durable,
            reusable lessons about the user (text-only).
Curator   — turn a batch of reflections into incremental delta ops on the memory.
Inference — compress detailed evolved rules into unified user insights.
"""

from __future__ import annotations

import base64
import json
from pathlib import Path

from external_api.llm import chat_completion

from personalization.memory.prompts import (
    CURATOR_SYSTEM,
    CURATOR_TEMPLATE,
    GENERATOR_SYSTEM,
    INFERENCE_SYSTEM,
    INFERENCE_TEMPLATE,
    MEMORY_BLOCK,
    REFLECTOR_SYSTEM,
    REFLECTOR_TEMPLATE,
)
from personalization.memory.state import InferredMemory, SectionedMemory
from personalization.memory.utils import norm_need, parse_json_obj, sample_frames
from personalization.schemas import LabeledMoment


def generate(
    model: str,
    moment: LabeledMoment,
    memory_text: str,
    *,
    image_root: str | Path | None = None,
    max_images: int = 8,
    max_tokens: int = 4096,
    temperature: float = 0.0,
) -> dict:
    """Predict with the current memory injected into the observer prompt shape."""
    user_prompt = MEMORY_BLOCK.format(memory=memory_text) + moment.observer_input
    content: list[dict] = [{"type": "text", "text": user_prompt}]
    for p in _moment_image_paths(moment, image_root=image_root, max_images=max_images):
        content.append({"type": "image_url", "image_url": {"url": _image_ref(p)}})
    messages = [
        {"role": "system", "content": GENERATOR_SYSTEM},
        {"role": "user", "content": content},
    ]
    text = _complete_role(
        messages,
        model=model,
        temperature=temperature,
        max_tokens=max_tokens,
        operation="self_evolving_memory.generate",
    )
    parsed = parse_json_obj(text)
    pred = norm_need(parsed.get("need_support")) if parsed else None
    gt_need = norm_need(moment.need_support)
    return {
        "moment": moment,
        "raw": text,
        "parsed": parsed,
        "pred": pred,
        "gt": gt_need,
        "gt_output": _moment_target_output(moment, gt_need=gt_need),
        "correct": pred == gt_need and pred is not None,
    }


def reflect(
    model: str,
    result: dict,
    memory_text: str,
    *,
    max_tokens: int = 20480,
    temperature: float = 0.2,
) -> dict | None:
    """Text-only diagnosis of one prediction vs. the ground-truth label."""
    out = result["gt_output"]
    prediction = (
        json.dumps(result["parsed"], indent=1)
        if result["parsed"]
        else (result["raw"][:800] or "(no output)")
    )
    prompt = REFLECTOR_TEMPLATE.format(
        memory=memory_text,
        gt_observation=out.get("observation", ""),
        gt_intent=out.get("user_intent", ""),
        prediction=prediction,
        gt_need=result["gt"],
        gt_stype=out.get("suggestion_type", ""),
        gt_suggestion=out.get("suggestion", "") or "(none)",
        gt_rationale=out.get("rationale", ""),
        verdict="CORRECT" if result["correct"] else "WRONG",
    )
    messages = [
        {"role": "system", "content": REFLECTOR_SYSTEM},
        {"role": "user", "content": prompt},
    ]
    parsed = parse_json_obj(
        _complete_role(
            messages,
            model=model,
            temperature=temperature,
            max_tokens=max_tokens,
            operation="self_evolving_memory.reflect",
        )
    )
    if not parsed:
        return None
    parsed["verdict"] = "correct" if result["correct"] else "wrong"
    return parsed


def curate(
    model: str,
    memory: SectionedMemory,
    reflections: list[dict],
    *,
    max_ops: int = 8,
    max_tokens: int = 20480,
    temperature: float = 0.2,
) -> list[dict]:
    """Batch of reflections -> incremental delta ops on the memory."""
    refl_lines = []
    for i, r in enumerate(reflections, 1):
        refl_lines.append(
            f"Reflection {i} (prediction was {r['verdict']}): {r.get('reflection', '')}\n"
            f"  proposed insights: {json.dumps(r.get('proposed_insights', []))}"
        )
    prompt = CURATOR_TEMPLATE.format(
        memory=memory.render(with_ids=True), reflections="\n".join(refl_lines)
    )
    messages = [
        {
            "role": "system",
            "content": CURATOR_SYSTEM.replace("{max_ops}", str(max_ops)),
        },
        {"role": "user", "content": prompt},
    ]
    parsed = parse_json_obj(
        _complete_role(
            messages,
            model=model,
            temperature=temperature,
            max_tokens=max_tokens,
            operation="self_evolving_memory.curate",
        )
    )
    ops = parsed.get("ops") if parsed else None
    return ops if isinstance(ops, list) else []


def infer_memory(
    model: str,
    memory: SectionedMemory,
    *,
    max_tokens: int = 20480,
    temperature: float = 0.2,
) -> InferredMemory | None:
    """Infer a compact user model from the detailed evolved memory."""
    prompt = INFERENCE_TEMPLATE.format(memory=memory.render_evolved(with_ids=True))
    messages = [
        {
            "role": "system",
            "content": INFERENCE_SYSTEM,
        },
        {"role": "user", "content": prompt},
    ]
    parsed = parse_json_obj(
        _complete_role(
            messages,
            model=model,
            temperature=temperature,
            max_tokens=max_tokens,
            operation="self_evolving_memory.infer",
        )
    )
    if not parsed:
        return None
    return InferredMemory.from_dict(
        parsed,
        valid_bullet_ids=set(memory.bullets),
    )


def _complete_role(
    messages: list[dict],
    *,
    model: str,
    temperature: float,
    max_tokens: int,
    operation: str,
) -> str:
    response, _metrics = chat_completion(
        messages,
        model=model,
        temperature=temperature,
        max_tokens=max_tokens,
        operation=operation,
    )
    content = response.content
    if isinstance(content, str):
        return content
    first = content[0] if content else None
    if isinstance(first, str):
        return first
    return getattr(first, "text", "") if first is not None else ""


def _moment_target_output(
    moment: LabeledMoment,
    *,
    gt_need: str | None = None,
) -> dict:
    need = gt_need or norm_need(moment.need_support) or "no"
    if need == "no":
        return {
            "observation": moment.target_observation or "",
            "user_intent": moment.target_user_intent or "",
            "need_support": "no",
            "rationale": moment.label_rationale,
            "suggestion_type": "none",
            "suggestion": "",
        }
    return {
        "observation": moment.target_observation or "",
        "user_intent": moment.target_user_intent or "",
        "need_support": "yes",
        "rationale": moment.label_rationale,
        "suggestion_type": moment.target_suggestion_type,
        "suggestion": moment.target_suggestion,
    }


def _moment_image_paths(
    moment: LabeledMoment,
    *,
    image_root: str | Path | None,
    max_images: int,
) -> list[Path]:
    root = Path(image_root).expanduser() if image_root is not None else None
    frames = sample_frames(list(moment.image_paths), max_images)
    return [root / frame if root is not None else Path(frame) for frame in frames]


def _image_ref(path: str | Path) -> str:
    """Encode a local image as a data URL for the shared ``external_api`` path."""
    p = Path(path).expanduser()
    b64 = base64.b64encode(p.read_bytes()).decode()
    suffix = p.suffix.lstrip(".").lower()
    mime = "image/jpeg" if suffix in ("jpg", "jpeg") else f"image/{suffix or 'png'}"
    return f"data:{mime};base64,{b64}"
