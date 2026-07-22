# Privacy

Coco continuously observes your screen to offer proactive help, so we hold it to a strict standard: **everything runs on your machine, and we collect nothing.** The only data that ever leaves your computer is what goes to the VLM/LLM provider *you* configure — and you can keep even that on your trusted hardware.

This document details, for each component, what data flows in and out, exactly what is sent to the model provider, and every file Coco writes to disk.


## Components: inputs and outputs

Coco involves three local processes that talk to each other over `localhost`:

### Desktop app (Electron)

The avatar and chat UI.

| | |
|---|---|
| **Input** | Observation events streamed from the sensing service (SSE); guidance returned by the tutor service; your chat messages, feedback clicks, and settings. |
| **Output** | Forwards observation text and your chat messages to the tutor service; writes settings, memory, and activity history to the local user-data folder (see [footprint](#on-disk-footprint)). |
| **Network** | Loopback only. Clicking "Open ChatGPT / Claude / …" opens the tool with nothing attached — the generated prompt is only copied to your clipboard. The clipboard is written only when you click copy, and read only when you paste into Coco's chat. |

### Sensing service (`lib/sensing`)

The observer. Implements the Computer Use Behavior Observation Protocol.

| | |
|---|---|
| **Input** | Screen frames (~5 fps, downscaled JPEGs with the cursor highlighted); mouse click/scroll events and key presses (used locally to segment activity into meaningful moments).|
| **Output** | Calls the **observer VLM** when a trigger fires (periodic snapshot, idle/struggle detection, or your chat message) — see [What is sent to the VLM](#what-is-sent-to-the-vlm). Emits the resulting observation text to the desktop app over a local event stream. |
| **Storage** | Screenshots are deleted the moment the observer has read them. Per-session action log in a local SQLite database (deleted with the session folder). |

### Tutor service (`lib/proactive_tutor`)

The helper. Diagnoses each observation and decides whether to offer a hint, nudge, or delegation prompt.

| | |
|---|---|
| **Input** | Observation text from the sensing service (relayed by the desktop app), your chat messages, relevant propositions retrieved from local episodic memory, and your context settings (scenario, AI tools, memory). |
| **Output** | Calls the **tutor LLM** with a *text-only* prompt — observation, conversation history, relevant retrieved propositions, and memory. Images are included **only** when you explicitly attach a screenshot (hotkey capture or paste into chat). Returns guidance text to the desktop app. Optional visualizations are rendered by locally executed, safety-checked code. |

## What is sent to the VLM

This is the only place data leaves your machine. When the observer triggers, one API request goes to the model configured in your `.env`, containing:

- **The screenshot(s)** — the pixels of your screen at that moment (plus any capture you flagged with the hotkey). This is the sensitive payload: whatever is visible on screen is in the image.
- **Observation context** — the observer's own previous outputs, your Coco memory/problem statement, and conversation history when a chat session is active.

What is deliberately **not** in the request: your keystroke log, click coordinates, window titles, app names, filenames, or anything read from your filesystem. Raw input events are used only locally to decide *when* to observe.

**We are not collecting any of this.** There is no Coco backend; the request goes directly from your machine to your provider's endpoint, authenticated with your own API key. That also means **your provider choice determines where your screen pixels go** — choose one whose data policies you trust, and prefer providers with no-training / zero-retention terms. Better yet, use one of the privacy-preserving setups:

1. **Self-hosted VLMs** — run an open-weight model on hardware you control via [vLLM](https://github.com/vllm-project/vllm), [LM Studio](https://lmstudio.ai/), etc. Your screenshots never leave your machine (or your own infrastructure).
2. **Trusted Execution Environment (TEE) providers** — open-weight models served from attested secure enclaves, e.g. [Tinfoil](https://tinfoil.sh/), so even the host cannot inspect your data.
3. **[Unlinkable inference](https://openanonymity.ai/blog/unlinkable-inference/)** — relay requests to any model provider while stripping the link between you and your requests, e.g. [Open Anonymity](https://chat.openanonymity.ai/).

All three are selected purely by the model-name prefix in `.env` — see [lib/external_api/README.md](lib/external_api/README.md). We are also working toward an on-device-native Coco that removes remote inference entirely.

## On-disk footprint

Everything Coco stores lives in the app's user-data folder — delete it and every trace of Coco is gone:

- **macOS**: `~/Library/Application Support/coco`
- **Windows**: `%APPDATA%\coco`
- **Linux**: `$XDG_CONFIG_HOME/coco` or `~/.config/coco`

| File | Format | Contents | Retention |
|---|---|---|---|
| `coco-profile.json` | JSON | Onboarding settings: scenario, your AI-tool list, custom observer prompt | Until you change or delete it |
| `coco-memory.txt` | Plain text | Coco's long-term memory about you — free text you can view and edit in-app | Until you edit or clear it |
| `activity-history.jsonl` | JSON Lines: observation summaries plus proactive-support engagement and revealed support content | Timeline shown in the activity view, including whether you opened an offered support and the content needed to revisit it | **Auto-pruned to 30 days** |
| `memory/memory.db` | SQLite with FTS5 | Semantic observer outputs, GUM-style propositions inferred from them, and links to supporting observations. Queried locally to add relevant past context to tutor prompts. | Until you delete the database |
| `custom_prompts/observer.txt` | Plain text | Your custom observer prompt, if you set one | Until you change it |
| `coco-records/session_<ts>/` | Folder per session | See below | Until you delete the folder |

Each session folder under `coco-records/` contains:

| File | Format | Contents | Retention |
|---|---|---|---|
| `actions.db` | SQLite, one table `observations` `(id, observer_name, content, content_type, created_at, updated_at)` | Raw action strings the segmenter uses — key presses, clicks, scrolls. **Local only, never sent to any model.** | Lives with the session folder |
| `screenshots/` | JPEG | Rolling capture buffer | **Deleted as soon as the observer reads them** — nothing accumulates |
| `hotkey_captures/` | JPEG | Screenshots you explicitly flagged with `Cmd+Shift+Space` | Until you remove them in-app or delete the folder |
| `observations.jsonl` | JSON Lines | Observer inputs (text prompt) and outputs per call | Lives with the session folder |
| `tutor_calls.jsonl` | JSON Lines | Tutor prompts and returned guidance | Lives with the session folder |
| `feedback.jsonl` | JSON Lines | Your 👍/👎 reactions to suggestions | Lives with the session folder |
| `observer_screenshots/` | JPEG | **Only if you opt in** with `COLLECT_TRAINING_SCREENSHOTS=1`: copies of the exact images sent to the VLM, kept for your own training use. Off by default. | Until you delete them |

Service logs are written next to the desktop app (`desktop/logs/*.log`) for debugging; they can contain observation and guidance text, so treat them like the records above. Your API keys stay in the plaintext `.env` you created and are used only to authenticate with your chosen provider.
