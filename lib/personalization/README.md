# Coco Personalization

Coco Personalization learns when and how to help from user feedback and activity records. Integrated from [NVIDIA Deep Personalization](https://github.com/NVlabs/deep-personalization), it turns assistance outcomes into reviewable preferences that improve Coco's prompts over time.

- **Learn from feedback:** label assistance moments using user reactions and recent behavior, with optional retrospective scans for missed opportunities.
- **Evolve memory:** predict, reflect on mistakes, and curate reusable preferences without updating model weights.
- **Keep users in control:** review, edit, or reject learned preferences before they enter the live prompt. User-written memory has the highest priority.
- **Export training data:** build supervised fine-tuning datasets for use outside this package.

## Desktop integration

The desktop app runs personalization in the background when compute is available and stops the worker when interactive tutor inference needs it. Checkpoints let interrupted work resume. Recent feedback supplies short-lived signals, while longer idle periods let Coco learn a draft of durable preferences.

Open **Personalization** in the sidebar to inspect progress and review completed drafts. Keep, edit, or reject each preference; decisions are saved so you can return later. Provisional memory stays out of the live prompt, and approved learned memory preserves user-written memory.

## Privacy and local deployment

[CTI-engine](https://github.com/mit-han-lab/cti-engine) is optimized for consumer hardware and AI PCs, making it easy to run local models through Docker. Loading the model with one command on RTX 5090, RTX PRO 6000, and DGX Spark on Linux with NVIDIA driver 580 or newer and the NVIDIA Container Toolkit.

**Qwen3.5-9B**

```bash
docker run --rm --gpus all --ipc=host \
    -p 1919:1919 \
    -v cti-engine-cache:/root/.cache \
    ghcr.io/mit-han-lab/cti-engine:0.0.1 \
    python -m ctiengine \
    --model.path Qwen/Qwen3.5-9B \
    --speculative.model-path z-lab/Qwen3.5-9B-DFlash \
    --server.host 0.0.0.0 \
    --server.port 1919
```

**Qwen3.5-35B-A3B**

```bash
docker run --rm --gpus all --ipc=host \
    -p 1919:1919 \
    -v cti-engine-cache:/root/.cache \
    ghcr.io/mit-han-lab/cti-engine:0.0.1 \
    python -m ctiengine \
    --model.path Qwen/Qwen3.5-35B-A3B \
    --speculative.model-path z-lab/Qwen3.5-35B-A3B-DFlash \
    --server.host 0.0.0.0 \
    --server.port 1919
```

Keep the exposed port accessible only on a trusted network. If Coco runs on the same host and remote access is unnecessary, use `-p 127.0.0.1:1919:1919` instead; that binding prevents connections from other machines.

Leave the server running and configure the model as the sensing model in Settings -> Model.

## For developers

### Retain screenshots for training

Set `COLLECT_TRAINING_SCREENSHOTS=1` to retain screenshots for dataset export and training experiments. With `COLLECT_TRAINING_SCREENSHOTS=0`, the desktop pipeline deletes screenshots referenced by a completed data period after successful memory evolution. This setting does not delete other records or exported copies.

### Personalize proactive agent behavior through the command line

Run these commands from the Coco repository root. Use Python 3.12 or newer and replace `./records` with your Coco records directory.

```bash
uv sync
uv run coco-personalization summary --records-root ./records
uv run coco-personalization label \
    --records-root ./records \
    --out ./out/labeled_moments.jsonl
```

Label exports require saved screenshots by default. Use `--no-require-saved-images` for text-only records or `--last-days 4` to restrict labels to the last four days. Uncorrected no-support predictions are included as weak negative examples; use `--no-include-unverified-no-support` to exclude them.

After starting a local model with the instructions above, learn preferences from the exported labels:

```bash
export HOSTED_VLLM_API_BASE=http://127.0.0.1:1919/v1
export HOSTED_VLLM_API_KEY=local

uv run coco-personalization self-evolve \
    --labeled ./out/labeled_moments.jsonl \
    --image-root ./records \
    --out-dir ./out/memory \
    --prediction-model hosted_vllm/Qwen/Qwen3.5-9B \
    --epochs 3 \
    --persona my_user \
    --memory-root ./coco-memory
```

The prediction model also handles reflection and memory curation unless you set `--evolution-model`. The learner writes memory, progress, and a checkpoint to the output directory. Rerun the same command with `--resume` after an interruption. Drafts written to the memory store require approval before use.

For retrospective labeling, add `--retrospective-model hosted_vllm/Qwen/Qwen3.5-9B` to `label`. Use `revise-labels` to revise labels that disagree with the observer, or `build-dataset` to export training examples. Run `uv run coco-personalization <command> --help` for options. Other model providers are described in [external_api](../external_api/README.md).
