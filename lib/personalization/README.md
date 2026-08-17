# personalization

Local personalization utilities for Coco.

This package reads Coco's local records, derives short-window feedback signals,
labels candidate assistance moments, manages layered personalization memory, and
exports supervised fine-tuning examples. It intentionally does not train model
weights.

## Desktop runtime

The Electron app runs `personalization.runtime` as a disposable low-priority
subprocess. Feedback triggers an incremental signal checkpoint immediately;
missed-opportunity signals refresh after each bounded observation interval.
When the system has spare compute, one label disagreement is revised per job.
After a longer idle interval—or while the user has explicitly put Coco to
sleep—the worker runs/resumes Coco-PE against a frozen data-period snapshot.
Each Coco-PE period is capped at 64 labeled moments and checkpoints after every
four-moment batch.

Interactive tutor inference terminates the worker process immediately. Signal,
revision, and Coco-PE checkpoints make the next invocation resume-safe. LoRA is
not yet a runtime backend; it can use the same frozen-period and successful-run
retention boundary when implemented.

Observer screenshots are retained temporarily for the current data period.
After Coco-PE successfully completes and writes its memory draft,
`COLLECT_TRAINING_SCREENSHOTS=0` deletes only the screenshot files referenced by
that completed data period. With `COLLECT_TRAINING_SCREENSHOTS=1`, those files
are kept.

On the next local day, the desktop asks the user to review the newest completed
draft from the previous day. The review groups compact insights under titles
such as **When to proactively support** and lets the user expand the selected
detailed bullets that support each insight. Examples are review evidence and are
not added to the live prompt. Approval atomically replaces Coco's learned-memory
section while preserving user-written memory, then applies it to the running
tutor. The observer reads that memory on its next observation. Choosing **Not
now** defers the draft until the next day.

For a development-only UI preview, point
`COCO_DAILY_MEMORY_DRAFT_FIXTURE` at a Coco-PE `memory_state.json`. The desktop
converts its inferred insights into an eligible prior-day draft. Packaged builds
ignore this fixture variable. Set `COCO_DESKTOP_USER_DATA_DIR` to an isolated
app data directory and `COCO_DAILY_MEMORY_PREVIEW_ONLY=1` to inspect the review
UI without starting sensing or tutor services.

Labeling and LLM revision are separate stages. First export the unchanged
feedback-derived labels:

```bash
coco-personalization label \
    --records-root ./records --out ./out/labeled_moments.jsonl
```

Use `--last-days 4` to export only moments from the last four rolling 24-hour
periods while still retaining the complete record context during labeling.

Optionally use the same on-device model to scan a large chronological timeline
for silent moments where later behavior confirms repetitive work, stuckness, or
an anticipatable need, and where interruption would have been clearly high value:

```bash
coco-personalization label \
    --records-root ./records \
    --out ./out/labeled_moments.jsonl \
    --retrospective-model nv_inference/model
```

The scanner is text-only and conservative. It processes every compact Observer
output in contiguous chronological chunks of up to 300 observations. Each
first call for each chunk discovers reusable workflow opportunities and cites later evidence,
such as collaborating on notes during sustained paper reading or delegating
repeated experiment launch/monitoring cycles. A second per-chunk call verifies
and curates the evidence without selecting a trigger. Only after discovery and
verification finish for every chunk does trigger grounding begin. Each trigger
call receives all verified opportunity summaries, evidence IDs and timestamps
from the full period, plus one target observation chunk; full evidence
observations are not repeated. It selects earlier eligible no-intervention
triggers in that chunk. Evidence is behavioral proof rather than a label target,
so an evidence observation may have `original_need_support=yes` or `no` and need
not be a no-intervention moment. Both verification stages must return an
explicit accepted or rejected decision, with a rationale, for every supplied
opportunity; an omitted decision invalidates that stage instead of being
treated as a silent rejection. A resulting label therefore separates its
earlier correction target from later workflow evidence. The trigger does not
need to be one of the evidence observations; at least two cited evidence
observations must follow it. Evidence must span five minutes, confidence must
exceed `0.75`, and the opportunity must remain useful if
an immediate local symptom disappeared, and identify assistance whose benefit
clearly exceeded the interruption cost. One-off SSH errors, command fixes, and
typos do not qualify. Manually invoking an AI tool later may confirm a missed
earlier opportunity when the need was already inferable; it does not qualify by
itself, and no suggestion should interrupt equivalent assistance already in
progress. Observer rationales cannot veto their own retrospective correction.
Direct user feedback and durable explicit preferences remain veto signals.
For each accepted trigger, grounding also rewrites the rationale explaining why
`need_support=yes` at that earlier moment. The rationale must be grounded in the
trigger context; later evidence may clarify the need but cannot be described as
already visible. This rationale becomes the labeled training target while the
original Observer intent and output remain unchanged as input.

Use `--retrospective-max-observations N` to set the maximum observations per
workflow-discovery chunk; it does not downsample the full timeline. Trigger
grounding uses independent, smaller chunks of 50 observations by default. Set
`--retrospective-trigger-max-observations N` to change that limit. Chunks may
be smaller when required by the input-character budget. Use
`--retrospective-max-opportunities N` to bound discovery output. With
`--retrospective-trace-out PATH`, one trace row per discovery chunk contains
all exact model requests, raw and parsed responses, structural review reasons,
and its associated `trigger_runs`. Empty, unparseable, or
schema-incomplete model responses are retried up to three total attempts; every
attempt is retained in the trace. Pass `--no-progress` to hide call progress.
Render that trace as an interactive report with:

```bash
python3 exp/personalization/visualize_retrospective.py \
    ./out/retrospective.jsonl ./out/retrospective.html
```

A user prompt to Coco within 60 seconds after a recorded no-support decision
contributes the positive `user_prompt_after` label signal.

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

Self-evolution preserves chronological source order by default. Pass `--shuffle`
to randomize examples each epoch. To reduce generator calls, originally correct
examples are deterministically downsampled to `--correct-sample-rate 0.5`;
original disagreements, unparseable predictions, and correct examples adjacent
to a disagreement in the same session are always retained. Set the rate to `1`
to keep every example.

The learner writes an atomic `resume_state.json` after every completed batch.
After an interruption, rerun the same command with `--resume` to restore the
evolved memory, running confusion counts, epoch, and next batch. The selected
dataset and all learning-affecting configuration must match; concurrency may be
changed when resuming so an overloaded endpoint can be retried more
conservatively. Checkpoints from older runs that contain only
`memory_state.json` and `progress.jsonl` are also supported on a best-effort
basis.

The self-evolving loop consumes the `LabeledMoment` records produced from
`signals/` by `label_records`. Its roles call `lib/external_api` directly, so
they use the same model prefixes and environment variables as the rest of Coco.
