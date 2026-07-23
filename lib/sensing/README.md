## `sensing`

A library for capturing and streaming user interactions (keyboard, mouse, scroll) with associated screenshots, and turning them into proactive-assistant observations.


### Architecture

```
Observer (Screen) → GUM → Database → Streamer → FastAPI Server
                      ↓
                 Screenshots
```

**GUM** (`gum.py`): Database manager and observer coordinator:
- Initializes SQLite database with async support
- Manages observer (e.g., Screen) lifecycle
- Processes `Update` objects from observers
- Stores observations in database with timestamps

> **Acknowledgment.** The screen-capture and observation-storage core is derived from the **GUM (General User Models)** project ([github.com/GeneralUserModels/gum](https://github.com/GeneralUserModels/gum)).


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

#### **Streamer**: Processes and serves captured observations
- Periodic polling: Checks database at configurable intervals and process observations when they exceed `min_actions_threshold`
- Action merging:
  - Combines consecutive keyboard presses into single text strings and deduplicate consecutive scroll events
  - Further splits the action stream into *segments** — runs of actions that share roughly the same on-screen state — so near-identical consecutive frames collapse into one observation instead of many. The segmentation is based on per-row mean squared error (MSE).
- Screenshot association: Links before/after screenshots to merged actions
- Time tracking: Measures time ranges and gaps between actions
- Cleanup: Deletes processed observations from DB and screenshots from disk. Set `COLLECT_TRAINING_SCREENSHOTS=1` to copy screenshots into observer_screenshots/ before deletion instead — useful for training the observer but disk-heavy.
- API-ready: Provides time-range queries for action retrieval


#### **Sensing Server**: FastAPI-based HTTP server
- **Endpoints**:
  - `GET /health`: Server status and total stored actions
  - `POST /actions/query`: Query actions by time range (returns actions, states, time_info)
  - `POST /observe/user_prompt`: Capture screenshot and generate observation for a user prompt
  - `POST /session`: Configure streamer for a new session.
  - Also exposes streaming (`GET /events/pause/stream`, `GET /observations/stream`), feedback (`POST /feedback`), hotkey-capture (Ctrl/Command + Shift + Space), and session-end endpoints.

Semantic observer outputs are also persisted to the shared local memory database.
The everyday-support tutor can retrieve relevant long-term context and bounded
observation evidence through the local `memory_mcp` server.


### Data Flow

1. **Capture**: `Screen` observer captures interactions and saves screenshots
2. **Store**: `GUM` writes observations to SQLite database
3. **Process**: `Streamer` periodically:
   - Loads new observations
   - Merges consecutive keyboard/scroll actions
   - Associates screenshots (before/after pairs)
   - Segments the stream by MSE state-diff (collapses near-duplicate frames)
   - Encodes images to base64
   - Stores in memory with timestamps
   - Deletes processed data from DB and disk
4. **Serve**: FastAPI server exposes time-range queries over HTTP

### Proactive suggestions

The proactive assistant is built from three independent modules, each answering one question:

| Module | Question it answers | Where |
|---|---|---|
| **Observer** (multimodal VLM) | *What is the user doing?* | `segment_processor.py` (`_handle_observation` → `_observe`) |
| **Judge** (text-only LLM) | *Should we interrupt right now, unprompted?* | `progress_detector.py` (`ProgressDetector`) |
| **Tutor** | *What should we say?* | `lib/proactive_tutor` |

By default (`--enable_judge=False`), the judge does not run and the experience is pull-based: the observer streams observations to the UI, and the user decides when to ask for help. Pass `--enable_judge=True` to turn on the judge as a proactive push layer that fires invites or in-chat nudges when it decides to intervene.

#### Observation cadence (`observer_interval_seconds`)

The observer fires from three sources:

- **Time-driven tick.** An always-on loop observes the current screen every `observer_interval_seconds` whenever the user has been active within the last ~2 intervals. It is **decoupled from action volume**, so it catches low-distinct-action activity like **scrolling a long list** and **short tasks** that the action path misses.
  - Lower `observer_interval_seconds` for snappier suggestions, raise it to cut VLM cost (each observation is one multimodal call).
- **Action-accumulation snapshot.** The streamer adds one snapshot per processing cycle; an observation fires only once the buffer reaches `snapshot_buffer_max_size`.
- **Idle / user prompt.** The `pause` observation fires after the screen idle timeout; a `user_prompt` observation fires when the user sends a message.

After `sensing_idle_timeout_seconds` without system-wide keyboard, mouse, or trackpad activity (5 minutes by default), sensing enters a dormant state: screen capture, database polling, observer ticks, and progress judgments pause. It also pauses immediately when the laptop reports that the display is asleep. The first user
input wakes sensing; the wake-up event itself is discarded so it cannot be paired with a stale pre-sleep screenshot.

### Usage Example

```bash
uv run python -m sensing.sensing_server \
  --observer_model=<provider/model> \
  --observer_interval_seconds=15.0 \
  --sensing_idle_timeout_seconds=300 \
  --min_actions_threshold=2 \
  --port=8080 \
  --tutor_url="http://localhost:8081"
```
