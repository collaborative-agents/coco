## `sensing`

A library for capturing and streaming user interactions (keyboard, mouse, scroll) with associated screenshots.

### Architecture

```
Observer (Screen) → GUM → Database → Streamer → FastAPI Server
                      ↓
                 Screenshots
```

### Components

#### **GUM** (`gum.py`)
Database manager and observer coordinator:
- Initializes SQLite database with async support (aiosqlite)
- Manages observer lifecycle
- Processes `Update` objects from observers
- Stores observations in database with timestamps
- Configurable concurrency limits for update processing

**Database Schema**:
```sql
CREATE TABLE observations (
    id INTEGER PRIMARY KEY,
    observer_name TEXT,           -- e.g., "Screen"
    content TEXT,                 -- Action string: "key_press('a')", "click_left(100, 200)", "scroll(...)"
    content_type TEXT,            -- "input_text" or "input_image"
    created_at TIMESTAMP,
    updated_at TIMESTAMP
);
```

#### **Streamer** (`streamer.py`)
Processes and serves captured actions:
- **Periodic polling**: Checks database at configurable intervals (default 30s)
- **Action merging**:
  - Combines consecutive keyboard presses into single text strings
  - Deduplicates consecutive scroll events
  - Configurable hotkey detection support
- **Screenshot association**: Links before/after screenshots to merged actions
- **Time tracking**: Measures time ranges and gaps between actions
- **In-memory storage**: Keeps processed actions in memory (configurable max, default 1000)
- **Cleanup**: Deletes processed observations from DB and screenshots from disk
- **API-ready**: Provides time-range queries for action retrieval

Action merging logic:
- Consecutive `key_press` events → merged into single string
- Consecutive `scroll` events → deduplicated
- Other actions (clicks) → preserved as-is

#### **Sensing Server** (`sensing_server.py`)
FastAPI-based HTTP server:
- **Endpoints**:
  - `GET /health`: Server status and total stored actions
  - `POST /actions/query`: Query actions by time range (returns actions, states, time_info)
  - `POST /observe/user_prompt`: Capture screenshot and generate observation for a user prompt
  - `POST /session`: Configure streamer with TutorAgentNode UUID and Redis URL
- **Concurrent operation**: Runs GUM, Streamer, and FastAPI server together
- **Default configuration**:
  - Port: 8080
  - Check interval: 20s
  - Min actions threshold: 2
  - Observer interval: 15s (time-driven observation tick; `--observer_interval_seconds`)
  - Observer model: configurable via `--observer-model`


### Data Flow

1. **Capture**: `Screen` observer captures interactions and saves screenshots
2. **Store**: `GUM` writes observations to SQLite database
3. **Process**: `Streamer` periodically:
   - Loads new observations
   - Merges consecutive keyboard/scroll actions
   - Associates screenshots (before/after pairs)
   - Encodes images to base64
   - Stores in memory with timestamps
   - Deletes processed data from DB and disk
4. **Serve**: FastAPI server exposes time-range queries over HTTP

### Proactive suggestions

The proactive assistant is built from three independent modules, each answering
one question:

| Module | Question it answers | Where |
|---|---|---|
| **Observer** (multimodal VLM) | *What is the user doing?* | `segment_processor.py` (`_handle_observation` → `_observe`) |
| **Judge** (text-only LLM) | *Should we interrupt right now, unprompted?* | `progress_detector.py` (`ProgressDetector`) |
| **Tutor** | *What should we say?* | `lib/proactive_tutor` |

The observer turns screenshots into a structured observation (`status`,
`user_intent`, …). The tutor generates the actual assistant message. The judge
only decides *whether/when* to push an **unsolicited** suggestion.

#### Default: observer-only (`--enable_judge=False`)

The **judge does not run**. The experience is pull-based:

1. The observer produces observations continuously (periodic snapshots, idle,
   user prompts) and streams them to the UI.
2. Any "mid-friction" status (`inefficient`, `ai_struggle`, `stuck`, …) surfaces
   an ambient bubble on the floating avatar with a **"Help me with this"** button
   (the `TIER2_STATUSES` set in the Electron renderer).
3. Clicking it **creates a tutor session** (if none is active) seeded with that
   observation, and the **tutor** answers. The user decides *when*; the tutor
   decides *what*. There is no proactive push.

This is the shipping behavior. The observer's status classification is the
"when to suggest" model and can be improved later with training (see below).

#### Baseline: enable the judge (`--enable_judge=True`)

Turns on the **judge** as a proactive *push* layer, kept as a baseline for
comparison. `ProgressDetector` then runs continuously and, on each tick (every
`struggle_detection_seconds`, after a start-grace and post-fire cooldown), asks
the judge LLM `should_intervene`. When it fires:

- **No active session** → the fire becomes an **invite** ("want me to help?").
- **Active session** → the fire becomes an in-chat **nudge** (via the tutor).

#### Observation cadence (`observer_interval_seconds`)

The observer fires from three sources:

- **Time-driven tick (primary).** An always-on loop observes the current screen
  every `observer_interval_seconds` (default `15.0`) whenever the user has been
  active within the last ~2 intervals. It is **decoupled from action volume**, so
  it catches low-distinct-action activity like **scrolling a long list** and
  **short tasks** that the action path misses. A static/idle screen is skipped
  (the `pause` path covers true idle). Scrolling counts as activity even though
  it logs almost no action segments, which is why a time-driven tick catches it.
- **Action-accumulation snapshot (secondary).** The streamer adds one snapshot
  per processing cycle; an observation fires only once the buffer reaches
  `snapshot_buffer_max_size` (6) — i.e. roughly every `check_interval × 6` ≈ 120s
  of active work, and ~never during pure scrolling. Since the time-driven tick
  clears the snapshot buffer on each observation, this path rarely fires on its
  own now.
- **Idle / user prompt.** The `pause` observation fires after the screen idle
  timeout; a `user_prompt` observation fires when the user sends a message.

Lower `observer_interval_seconds` for snappier suggestions, raise it to cut VLM
cost (each observation is one multimodal call). Set `0` to disable the ticker
(action-accumulation only).

#### Training data

Each run writes append-only JSONL into a shared directory — `$COCO_RECORDS_DIR`
if set (so the sensing and tutor processes write to one joinable dir; the
desktop app points this at `coco-records/` in its user-data folder), else
`~/Downloads/coco-records/` (`py_utils/training_recorder.py`):

- `observations.jsonl` — every observer call: input prompt, output JSON,
  screenshot paths. *(both modes)*
- `decisions.jsonl` — every judge tick: full judge input/output, timing + config,
  `phase` (`invite`/`nudge`), and the observation ids the judge read. *(judge mode only)*
- `episodes.jsonl` — one row per fired invite/nudge. *(judge mode only)*
- `tutor_calls.jsonl` — every tutor LLM call: full prompt + generated guidance
  (written by the tutor process when `$COCO_RECORDS_DIR` is set).
- `feedback.jsonl` — every explicit user reaction (`shown` / `engage` / `dismiss`
  / `thumbs_up` / `thumbs_down`) on a bubble or chat message; an "ignore" is a
  `shown` row with no matching `engage`/`dismiss`, derived offline.

There are two data modes, both selected by a single flag:

- **Normal usage** (default): observer screenshots are deleted the instant the
  observer has read them, so images never pile up on disk. Only the small text
  JSONL logs above remain.
- **Training-collection mode** (`COLLECT_TRAINING_SCREENSHOTS=1`): screenshots
  are copied into `observer_screenshots/` inside the run dir before deletion, so
  they can be used to train the observer. Privacy-sensitive and disk-heavy —
  enable it deliberately.

### Usage Example

```bash
# Observer-only (default) — judge never runs
uv run python -m sensing.sensing_server

# Observer + judge (baseline for comparison)
uv run python -m sensing.sensing_server --enable_judge=True

# In the Electron app, add "--enable_judge=True" to the sensing-server args in
# desktop/src/main/services/config.json

# Run with default observer model (gemini-2.5-pro)
uv run python -m sensing.sensing_server

# Run with a different observer model
uv run python -m sensing.sensing_server --observer_model=anthropic/claude-sonnet-4-20250514

# Tune observation cadence (default 15s; lower = snappier, higher = cheaper)
uv run python -m sensing.sensing_server --observer_interval_seconds=10
```

### Model providers

The observer model accepts any `provider/model` id, routed by prefix through the
shared LLM dispatcher. See [`external_api`](../external_api/README.md#model-providers)
for the full list of supported backends, their handles, and the **privacy
trade-offs** of each (the observer sends screenshots to whichever model you pick).

### Configuration

Key parameters:
- **Screen**:
  - `screenshots_dir`: Screenshot storage location (default: `~/Downloads/records/screenshots`)
  - `keyboard_timeout`: Keyboard session timeout in seconds (default: 2.0)
  - `skip_when_visible`: Apps to ignore when visible
  - `scroll_debounce_sec`: Minimum time between scroll events (default: 0.5)
  - `scroll_min_distance`: Minimum scroll distance to log (default: 5.0)

- **Streamer**:
  - `check_interval`: Database polling interval (default: 20.0s)
  - `min_actions_threshold`: Minimum actions before processing (default: 2)
  - `max_stored_actions`: Max in-memory actions (default: 1000)
  - `enable_hotkey`: Enable hotkey detection in merging (default: False)

- **Sensing Server**:
  - `observer_model`: LLM model for the observer agent. Accepts any model string supported by [LiteLLM](https://docs.litellm.ai/docs/providers) (e.g., `anthropic/claude-sonnet-4-20250514`, `openai/gpt-4o`).
  - `observer_interval_seconds`: Seconds between always-on, time-driven observations (default: `15.0`). Decouples observation cadence from action accumulation so scrolling / short tasks get timely observations; `0` disables the ticker. See [Observation cadence](#observation-cadence-observer_interval_seconds).
  - `enable_judge`: Whether to run the judge (`ProgressDetector`) as a proactive push layer (default: `False` → observer-only). See [Proactive suggestions](#proactive-suggestions-observer-only-default-vs-judge-baseline).

- **GUM**:
  - `data_directory`: Database directory (default: `~/Downloads/records`)
  - `db_name`: Database filename (default: `actions.db`)
  - `max_concurrent_updates`: Concurrent update limit (default: 4)
