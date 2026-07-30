# personalization

Local personalization utilities for Coco.

This package reads Coco's local records, derives short-window feedback signals,
labels candidate assistance moments, manages layered personalization memory, and
exports supervised fine-tuning examples. It intentionally does not train model
weights.

Labeling and LLM revision are separate stages. First export the unchanged
feedback-derived labels:

```bash
coco-personalization label \
    --records-root ./records --out ./out/labeled_moments.jsonl
```

A user prompt to Coco within 60 seconds after an observation contributes the
positive `user_prompt_after` label signal.

The CLI also includes uncorrected observer no-support predictions as weak
negative examples by default. They are marked with
`observer:no_support_unverified` at confidence `0.25`, never contain a
suggestion, and remain distinguishable from user-corrected labels. Disable them
with `--no-include-unverified-no-support` or adjust their confidence with
`--unverified-no-support-confidence`.

Label and dataset CLI exports require at least one image file to exist on disk
by default. Paths to deleted rolling screenshots do not qualify. Override this
only when needed with `--no-require-saved-images`.

After inspecting those labels, revise labels whose polarity disagrees with the
observer's original support prediction. Omit `--limit` to revise all eligible
labels, or set it to process a bounded sample:

```bash
coco-personalization revise-labels \
    --records-root ./records \
    --labeled ./out/labeled_moments.jsonl \
    --out ./out/revised_sample.jsonl \
    --revision-model openai/gpt-4.1 \
    --limit 20 --concurrency 8
```

Invalid revision responses are retried twice by default. Set
`--revision-retries 0` to disable retries or another non-negative value to tune
the retry count.

## Look-ahead observation critique

After label/intent revision, the look-ahead stage uses later
`need_support=yes` moments as supervision for improving earlier observer notes:

```bash
coco-personalization lookahead-critique \
    --records-root "$HOME/Library/Application Support/coco/coco-records" \
    --labeled ./out/labeled_moments.jsonl \
    --revised ./out/revised_sample.jsonl \
    --out ./out/lookahead_critiques.jsonl \
    --teacher-model openai/gpt-4.1 \
    --limit 20 \
    --max-past-observations 4 \
    --memory-proposition-limit 12 \
    --memory-evidence-limit 10 \
    --max-observation-words 80 \
    --teacher-retries 2 \
    --include-images
```

For each future support need, the revised `target_user_intent` is sent to Coco's
shared `MemoryStore.search`. Supporting observation IDs cited by matching memory
propositions are joined back to the recorded observer moments; observations at
or after the future need are excluded. This reuses Coco's cross-session memory
retrieval and proposition/evidence graph instead of maintaining a separate
experiment-only retriever. Use `--memory-db` to override the normal Coco memory
database.

The teacher receives the future labeled/revised target, matched memory
propositions, bounded action context, retrieved past notes, and (when explicitly
enabled) retained frames. Output JSONL keeps the memory query and proposition
provenance, critique, improved observation, helpfulness score, word-budget
check, raw teacher response, and LLM metrics. The prompt permits hindsight to
identify useful contemporaneous facts but prohibits leaking future events into
the rewritten past note.

Invalid teacher JSON is retried twice by default with a corrective prompt that
repeats the required observation IDs and schema. Configure this with
`--teacher-retries`; `--max-tokens` controls the per-attempt output limit and
defaults to 4096.

The runtime personalization hierarchy is:

1. User-written memory: durable, user-controlled, highest priority.
2. Short-window signals: recent reactions and behavior with TTL/scope.
3. Learned preferences: slower inferred memory, reviewable and versioned.

## Self-evolving prompting (`personalization.memory`)

Instead of fine-tuning, the model can evolve its own natural-language memory of a
user's preferences following the agentic-context-engineering recipe (ACE,
arXiv:2510.04618; ACON, arXiv:2510.00615). The prediction and evolution roles can
use the same served model or different models:

- **Generator** predicts `need_support` on a labeled moment under the current
  memory, using the same observer prompt shape used at runtime.
- **Reflector** compares the prediction to the ground-truth label and distills
  durable, reusable lessons about the user.
- **Curator** turns a batch of reflections into incremental delta ops
  (add / update / delete) on a sectioned bullet memory.
- **Grow & Refine** votes reinforce/penalize bullets; the lowest-utility bullets
  are dropped once the memory exceeds the cap.
- **Inference** compresses the evolved situation-level rules into unified user
  insights that connect intent with assistance preference, with selected source
  bullets retained as concrete examples.

Evolved bullets are promoted into an approvable `MemoryDraft` — they never touch
the live prompt context until a human approves them.

```bash
coco-personalization self-evolve \
    --records-root ./records --out-dir ./out/memory \
    --prediction-model lm_studio/base \
    --evolution-model openai/gpt-4.1 \
    --epochs 10 --target-utility 0.7 --false-positive-cost 2 \
    --persona my_user --memory-root ./coco-memory
```

To evolve only from a reviewed subset, pass its `LabeledMoment` JSONL instead
of raw records. Relative image paths are resolved against `--image-root`:

```bash
coco-personalization self-evolve \
    --labeled ./privacy_safe_sharegpt/labeled_moments.jsonl \
    --image-root ./privacy_safe_sharegpt \
    --out-dir ./out/privacy_safe_memory \
    --prediction-model nv_inference/nvidia/qwen/qwen3.5-35b-a3b \
    --evolution-model nv_inference/nvidia/qwen/qwen3.5-35b-a3b \
    --epochs 3
```

`epochs` is the maximum number of passes. When `--target-utility` is set, the
loop stops early after an epoch reaches `(TP + TN - fp_cost*FP - fn_cost*FN -
max(fp_cost, fn_cost)*invalid) / N`. False positives cost twice as much as false
negatives by default. When a target is configured, each epoch ends with one
additional fixed-memory generator pass used for the stopping decision.

The prediction model runs the generator and utility evaluation. The evolution
model runs reflection, curation, and final memory induction. Omit
`--evolution-model` to use the prediction model for every role.

The self-evolving loop consumes the `LabeledMoment` records produced from
`signals/` by `label_records`. Its roles call `lib/external_api` directly, so
they use the same model prefixes and environment variables as the rest of Coco.
