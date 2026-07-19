# personalization

Local personalization utilities for Coco.

This package reads Coco's local records, derives short-window feedback signals,
labels candidate assistance moments, manages layered personalization memory, and
exports supervised fine-tuning examples. It intentionally does not train model
weights.

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
