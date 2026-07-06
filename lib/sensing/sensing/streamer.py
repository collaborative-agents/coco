import asyncio
import os
from typing import cast

import cv2
import numpy as np
import pandas as pd
from py_utils.logging import init_logger
from sensing.segment_processor import AiTutoringProcessor, SegmentProcessor
from sensing.utils import (
    compose_key_input,
    get_key_input,
    is_keyboard_action,
    is_scroll_action,
)
from sqlalchemy import create_engine, text

logger = init_logger(__name__)


def hotkey_in_action(action: str) -> bool:
    """Check if the action contains a hotkey."""
    return any(
        hotkey in action for hotkey in [".cmd", ".enter", ".tab", ".up", ".down"]
    )


def trigger_close_buffer(
    action: str, buffer_actions: list[str], enable_hotkey: bool = False
) -> bool:
    """Time to close the buffer:
    - Current buffer is non-empty
    - Next new key/scroll action is different from the last action in the buffer.
    """
    if len(buffer_actions) == 0:
        return False
    if is_keyboard_action(buffer_actions[-1]) and (not is_keyboard_action(action)):
        return True
    if is_scroll_action(buffer_actions[-1]) and (not is_scroll_action(action)):
        return True
    if enable_hotkey and is_keyboard_action(action) and hotkey_in_action(action):
        return True
    return False


def trigger_add_buffer(action: str, buffer_actions: list[str]) -> bool:
    """Should add the new action to the buffer.
    - Is keyboard or scroll action
    - (i) buffer is empty; (ii) last action in buffer is the same type as the new action.
    """
    if not (is_keyboard_action(action) or is_scroll_action(action)):
        return False
    if len(buffer_actions) == 0:
        return True
    if is_keyboard_action(action) and is_keyboard_action(buffer_actions[-1]):
        return True
    if is_scroll_action(action) and is_scroll_action(buffer_actions[-1]):
        return True
    return False


def merge_actions(
    actions: list[str], enable_hotkey: bool = False
) -> tuple[list[dict[str, str]], list[str]]:
    """Merge adjacent keyboard and scrolling actions into a single action.

    Returns:
        Tuple of (original_actions, merged_actions) where:
        - original_actions: List of dicts with "before" and "after" keys
        - merged_actions: List of merged action strings
    """
    original_actions, merged_actions = [], []
    buffer_actions = []

    def _merge_buffer_actions():
        if buffer_actions and is_keyboard_action(buffer_actions[0]):  # keypress buffer
            assert all(is_keyboard_action(action) for action in buffer_actions)
            original_actions.append(
                {"before": buffer_actions[0], "after": buffer_actions[-1]}
            )

            buffer_values = [get_key_input(action) for action in buffer_actions]
            keyboard_input = compose_key_input(buffer_values)
            merged_actions.append(f"key_press('{keyboard_input}')")
        elif buffer_actions and is_scroll_action(buffer_actions[0]):  # scroll buffer
            assert all(is_scroll_action(action) for action in buffer_actions)
            for ba in buffer_actions:
                if len(merged_actions) == 0 or ba != merged_actions[-1]:
                    original_actions.append({"before": ba, "after": ba})
                    merged_actions.append(ba)
        buffer_actions.clear()

    for action in actions:
        close_buffer_flag = trigger_close_buffer(
            action, buffer_actions, enable_hotkey=enable_hotkey
        )
        if close_buffer_flag:
            _merge_buffer_actions()

        add_buffer_flag = trigger_add_buffer(action, buffer_actions)
        if add_buffer_flag:
            buffer_actions.append(action)
        else:
            merged_actions.append(action)
            original_actions.append({"before": action, "after": action})

    _merge_buffer_actions()

    return original_actions, merged_actions


def find_screenshot(
    screenshot_paths: list[str], action: str, suffix: str
) -> tuple[str | None, list[str]]:
    """Find the screenshot path for the given action and suffix.
    Return the screenshot path (or None if not found) and the remaining screenshot paths."""
    for i, sp in enumerate(screenshot_paths):
        if action in sp and sp.endswith(suffix):
            return screenshot_paths[i], screenshot_paths[:i] + screenshot_paths[i + 1 :]
    return None, screenshot_paths


def get_states(
    actions: list[dict], screenshot_dir: str, is_windows: bool = False
) -> list[dict[str, str | None]]:
    """Get before/after states (screenshots) associate with each action."""
    if not os.path.isdir(screenshot_dir):
        logger.warning(f"Screenshot directory does not exist: {screenshot_dir}")
        return [{"before": None, "after": None} for _ in actions]

    screenshot_paths = sorted(
        os.listdir(screenshot_dir), key=lambda x: x.split("_")[0]
    )  # sort by timestamp
    screenshot_paths = [os.path.join(screenshot_dir, p) for p in screenshot_paths]

    if not screenshot_paths:
        logger.warning(f"No screenshots found in {screenshot_dir}")
        return [{"before": None, "after": None} for _ in actions]

    states = []
    for action_dict in actions:
        suffix_before = (
            "_first.jpg" if is_keyboard_action(action_dict["before"]) else "_before.jpg"
        )
        before_path, screenshot_paths = find_screenshot(
            screenshot_paths, action_dict["before"], suffix_before
        )

        suffix_after = (
            "_final.jpg" if is_keyboard_action(action_dict["after"]) else "_after.jpg"
        )
        after_path, screenshot_paths = find_screenshot(
            screenshot_paths, action_dict["after"], suffix_after
        )
        state = {"before": before_path, "after": after_path}
        states.append(state)

    return states


def parse_time_from_path(path: str | None) -> float:
    """Parse the time from the path. Returns 0 if path is None or unparseable."""
    if not path:
        return 0.0
    return float(path.split("/")[-1].split("_")[0])


def measure_time_from_states(states: list[dict]) -> list[dict]:
    """Measure the time from the states."""
    time_list = []
    for i, state in enumerate(states):
        try:
            before_time = parse_time_from_path(state["before"])
            after_time = parse_time_from_path(state.get("after", state["before"]))
        except Exception:
            before_time = 0
            after_time = 0
        time_range = after_time - before_time

        if i == 0:
            time_diff = 0
        else:
            try:
                last_time = parse_time_from_path(
                    states[i - 1].get("after", states[i - 1]["before"])
                )
                time_diff = before_time - last_time
            except Exception:
                time_diff = 0

        time_list.append(
            {
                "before": before_time,
                "after": after_time,
                "range": time_range,
                "diff": time_diff,
            }
        )
    return time_list


# Segmentation
MAX_DIFF = 100000.0


def calc_diff_scores(action_nodes: list[dict]) -> list[float]:
    def mse(image_before: str | None, image_after: str | None) -> float:
        """Calculate the mean squared error between two images."""
        # print(f"Calculating MSE between {image_before} and {image_after}")
        if not image_before or not image_after:
            return MAX_DIFF
        image1 = cv2.imread(image_before)
        image2 = cv2.imread(image_after)
        if image1 is None or image2 is None or image1.shape != image2.shape:
            return MAX_DIFF
        err = np.sum((image1.astype("float") - image2.astype("float")) ** 2)
        err /= float(image1.shape[0] * image1.shape[1])
        return err

    diff_scores = []
    for i, action_node in enumerate(action_nodes):
        if i == 0:
            continue
        else:
            diff_score = mse(
                image_before=action_nodes[i - 1]["state_str"]["after"],
                image_after=action_node["state_str"]["before"],
            )
        diff_scores.append(diff_score)
    return diff_scores


def get_consistent_ranges(
    scores: list[float],
    threshold: float = 8000.0,
    min_steps: int = 5,
) -> list[tuple[int, int]]:
    """
    Find all ranges (start_index, end_index) where all scores are below threshold.
    """
    ranges = []
    start = None

    for i, score in enumerate(scores):
        if score < threshold:
            if start is None:
                start = i
        else:
            if start is not None:
                ranges.append((start, i - 1))
                start = None

    if start is not None:
        ranges.append((start, len(scores) - 1))

    ranges = [r for r in ranges if (r[1] - r[0] + 1) >= min_steps]
    return ranges


def get_intervals_per_step(
    diff_scores: list[float], threshold: float = 8000.0, verbose: bool = False
) -> list[tuple[int, int]]:
    """Segment the trajectory at actions with above-threshold state differences."""
    intervals = []
    s = 0
    for i, diff_score in enumerate(diff_scores):
        if diff_score > threshold:
            intervals.append((s, i))
            s = i + 1

    if s < len(diff_scores):
        intervals.append((s, len(diff_scores) - 1))
    return intervals


def get_intervals(
    ranges: list[tuple[int, int]],
    diff_scores: list[float],
    threshold: float = 8000.0,
    min_steps: int = 5,
) -> list[tuple[int, int]]:
    intervals = []

    s, e = ranges[0]
    if s <= min_steps:
        ranges = [(0, e)] + ranges[1:]
    else:
        intervals.append((0, s - 1))

    i, L = 0, len(ranges)
    while i < (L - 1):
        curr_range = ranges[i]
        gap = (ranges[i][1] + 1, ranges[i + 1][0] - 1)
        step_diff = gap[1] - curr_range[1]
        if step_diff >= min_steps:
            intervals.append(curr_range)
            intervals.append(gap)
        else:
            intervals.append((curr_range[0], gap[1]))
        i += 1

    if i != L - 1:
        print(
            "Suggestion: use `--default_segment` to use the default segmentation method. Do you want to run it now? (y/n)"
        )
        segments = get_intervals_per_step(diff_scores, threshold)
        return segments

    N = len(diff_scores)
    if ranges[i][1] < N - 1:
        curr_range = ranges[i]
        gap = (ranges[i][1] + 1, N - 1)
        step_diff = gap[0] - curr_range[1]
        if step_diff >= min_steps:
            intervals.append(curr_range)
            intervals.append(gap)
        else:
            intervals.append((curr_range[0], gap[1]))
    else:
        assert ranges[i][1] == N - 1
        intervals.append(ranges[i])
    return intervals


def trigger_segmentation(
    action_nodes: list[dict],
    threshold: float = 8000.0,
    min_steps: int = 5,
) -> list[list[dict]]:
    """Segment action nodes by MSE-based state differences."""
    diff_scores = calc_diff_scores(action_nodes)
    ranges = get_consistent_ranges(
        diff_scores, threshold=threshold, min_steps=min_steps
    )
    if len(ranges) == 0:
        intervals = get_intervals_per_step(diff_scores, threshold)
    else:
        intervals = get_intervals(
            ranges,
            diff_scores=diff_scores,
            threshold=threshold,
            min_steps=min_steps,
        )
    # logger.info(
    #     f"Found {len(intervals)} segments via mse diff threshold {threshold}: {intervals}"
    # )

    segments = [action_nodes[s : e + 1] for (s, e) in intervals]
    # print(f"[SEGMENTS] {segments}")
    return segments


# ---------------------------------------------------------------------------
# Main
# ---------------------------------------------------------------------------


class Streamer:
    """Periodically checks the database for new actions, segments them, and
    dispatches to all registered ``SegmentProcessor`` instances.

    Processing concerns (workflow induction, AI tutoring, …) live entirely
    inside the processors.  ``Streamer`` is responsible only for:

    * Reading raw actions from the SQLite database.
    * Merging consecutive keyboard/scroll actions.
    * Computing per-action screenshots (states) and timestamps.
    * Running ``trigger_segmentation`` to split the action stream.
    * Dispatching the result to every registered processor with a uniform
      argument set.
    * Exposing thin delegation methods (``generate_observation``,
      ``configure_session``, ``set_problem_statement``) so the HTTP server
      does not need to know which processor handles each concern.
    """

    def __init__(
        self,
        db_path: str,
        screenshot_dir: str,
        check_interval: float = 5.0,
        min_actions_threshold: int = 5,
        segment_threshold: float = 8000.0,
        enable_hotkey: bool = False,
        max_stored_actions: int = 1000,
        periodic_delete: bool = False,
        segment_processors: list[SegmentProcessor] | None = None,
    ) -> None:
        """
        Initialize the Streamer.

        Args:
            db_path: Path to the SQLite database file.
            screenshot_dir: Directory containing screenshots.
            check_interval: How often to check the database (in seconds).
            min_actions_threshold: Minimum number of actions required to process.
            segment_threshold: Threshold for triggering MSE-based segmentation.
            enable_hotkey: Whether to enable hotkey detection in action merging.
            max_stored_actions: Maximum number of actions to store in memory.
            periodic_delete: Whether to delete observations and screenshots periodically.
            segment_processors: Ordered list of processors to call after each
                segmentation cycle.  Pass ``[]`` or omit to disable all
                processing (useful for testing).
        """
        self.db_path = os.path.expanduser(db_path)
        self.screenshot_dir = os.path.expanduser(screenshot_dir)
        self.check_interval = check_interval
        self.min_actions_threshold = min_actions_threshold
        self.segment_threshold = segment_threshold
        self.enable_hotkey = enable_hotkey
        self.max_stored_actions = max_stored_actions
        self.periodic_delete = periodic_delete
        self._segment_processors: list[SegmentProcessor] = segment_processors or []

        print(f"[INIT] db_path: {self.db_path}, screenshot_dir: {self.screenshot_dir}")

        # Ensure database directory exists
        db_dir = os.path.dirname(self.db_path)
        if db_dir:
            os.makedirs(db_dir, exist_ok=True)

        # Track processed observation IDs to avoid reprocessing
        self._last_processed_id: int = 0
        self._last_processed_id_tmp: int = 0

        # In-memory storage for processed actions
        # Each entry: {"timestamp": float, "action": str, "state_str": dict, "time_info": dict}
        self._stored_actions: list[dict] = []
        self._lock = asyncio.Lock()

        # Running flag and task handle
        self._running = False
        self._task: asyncio.Task | None = None

    # ------------------------------------------------------------------
    # Lifecycle
    # ------------------------------------------------------------------

    async def start(self) -> None:
        """Start the streamer background task."""
        if self._task is None:
            self._running = True
            self._task = asyncio.create_task(self._worker())

    async def stop(self) -> None:
        """Stop the background task and close all processor resources."""
        self._running = False
        if self._task and not self._task.done():
            self._task.cancel()
            try:
                await self._task
            except asyncio.CancelledError:
                pass
            self._task = None
        for processor in self._segment_processors:
            await processor.close()

    # ------------------------------------------------------------------
    # Delegation helpers (thin pass-through to the appropriate processor)
    # ------------------------------------------------------------------

    async def generate_observation(
        self,
        type: str,
        user_text: str | None = None,
        image_path: str | None = None,
        timestamp: str | None = None,
        hotkey_image_paths: list[str] | None = None,
    ) -> str:
        """Delegate to the first processor that supports ``generate_observation``.

        Called by the sensing server's ``/observe/user_prompt`` endpoint.
        ``hotkey_image_paths`` are forwarded verbatim to the processor and are
        never deleted — they persist in the session's HotKeyBuffer.
        """
        for proc in self._segment_processors:
            if hasattr(proc, "generate_observation"):
                ai_proc = cast(AiTutoringProcessor, proc)
                return await ai_proc.generate_observation(
                    type, user_text, image_path, timestamp, hotkey_image_paths
                )
        raise RuntimeError(
            "No segment processor supports generate_observation. "
            "Add an AiTutoringProcessor to segment_processors."
        )

    async def configure_session(self) -> None:
        """Delegate session-reset to every processor that supports it.

        Called by the sensing server's ``/session`` endpoint when a new tutor
        session begins. Pause-detected events now flow through local SSE
        broadcasts (subscribed to by the tutor-worker), so this no longer takes
        a Redis target.
        """
        for proc in self._segment_processors:
            if hasattr(proc, "configure_session"):
                await cast(AiTutoringProcessor, proc).configure_session()

    async def set_problem_statement(self, problem_statement: str) -> None:
        """Delegate to the first processor that supports ``set_problem_statement``."""
        for proc in self._segment_processors:
            if hasattr(proc, "set_problem_statement"):
                await cast(AiTutoringProcessor, proc).set_problem_statement(
                    problem_statement
                )
                return
        raise RuntimeError(
            "No segment processor supports set_problem_statement. "
            "Add an AiTutoringProcessor to segment_processors."
        )

    # ------------------------------------------------------------------
    # Entry points for forced processing (pause / user-prompt)
    # ------------------------------------------------------------------

    async def _process_actions_pause(self, image_path: str, timestamp: str) -> None:
        await self._process_actions(
            force=True, type="pause", image_path=image_path, timestamp=timestamp
        )

    async def _process_actions_user_prompt(
        self, user_text: str, image_path: str, timestamp: str
    ) -> None:
        await self._process_actions(
            force=True,
            type="user_prompt",
            user_text=user_text,
            image_path=image_path,
            timestamp=timestamp,
        )

    # ------------------------------------------------------------------
    # Background worker
    # ------------------------------------------------------------------

    async def _worker(self) -> None:
        logger.info(f"Streamer started, checking every {self.check_interval}s")
        while self._running:
            try:
                await self._process_actions()
            except Exception as e:
                logger.error(f"Error processing actions: {e}", exc_info=True)
            await asyncio.sleep(self.check_interval)

    # ------------------------------------------------------------------
    # Core pipeline
    # ------------------------------------------------------------------

    async def _process_actions(
        self,
        force: bool = False,
        type: str | None = None,
        user_text: str | None = None,
        image_path: str | None = None,
        timestamp: str | None = None,
    ) -> None:
        """Load, merge, segment actions, then dispatch to all processors.

        The *effective type* passed to processors is:
        * ``"pause"`` or ``"user_prompt"`` when ``force=True`` and ``type`` is set.
        * ``"snapshot"`` in all other cases (periodic background cycle).
        """
        logger.info("Checking for new actions in database...")

        # 1. Load new actions from database
        actions, observation_ids = await asyncio.to_thread(
            self._load_new_actions_from_db
        )

        if not force and len(actions) < self.min_actions_threshold:
            logger.info(
                f"Only {len(actions)} new actions found, "
                f"threshold is {self.min_actions_threshold}. Skipping."
            )
            return

        logger.info(f"Processing {len(actions)} actions")

        # 2. Merge adjacent keyboard / scroll actions
        original_actions, merged_actions = merge_actions(
            actions, enable_hotkey=self.enable_hotkey
        )
        logger.info(f"Merged to {len(merged_actions)} actions")

        # 3. Resolve screenshots and timestamps
        states = await asyncio.to_thread(
            get_states, original_actions, self.screenshot_dir
        )
        time_list = measure_time_from_states(states)
        assert (
            len(original_actions)
            == len(merged_actions)
            == len(states)
            == len(time_list)
        )

        # screenshot_paths: list[str] = []

        # 4. Store in memory with eviction
        async with self._lock:
            for i, action in enumerate(merged_actions):
                self._stored_actions.append(
                    {
                        "timestamp": time_list[i]["before"]
                        if i < len(time_list)
                        else 0,
                        "action": action,
                        "state_str": states[i],
                        "time_info": time_list[i] if i < len(time_list) else {},
                    }
                )
            if len(self._stored_actions) > self.max_stored_actions:
                self._stored_actions = self._stored_actions[-self.max_stored_actions :]

        logger.info(
            f"Stored {len(merged_actions)} actions. "
            f"Total stored: {len(self._stored_actions)}"
        )

        # 5. Segment — this is the LAST consumer of screenshot files
        #    (calc_diff_scores → cv2.imread).  After this call returns,
        #    the files are no longer needed.
        segments = trigger_segmentation(
            list(self._stored_actions),
            threshold=self.segment_threshold,
            min_steps=self.min_actions_threshold,
        )
        logger.info(f"Triggered segmentation. Found {len(segments)} segments")

        # 6. Determine effective event type for this cycle
        effective_type = (
            type if (force and type in ("pause", "user_prompt")) else "snapshot"
        )

        # 6b. Identify the one screenshot that the snapshot processor will
        #     pass into the observer pipeline.  That file must survive until
        #     the observer reads it (cleaned later by
        #     _cleanup_consumed_screenshots in segment_processor).
        snapshot_keeper: str | None = None
        if segments and effective_type == "snapshot":
            last_seg = segments[-1]
            if last_seg:
                snapshot_keeper = last_seg[-1].get("state_str", {}).get("after")

        # 6c. Delete ALL event screenshots from stored actions — segmentation
        #     already read them.  Future segmentation cycles will get
        #     cv2.imread → None → MAX_DIFF for these old transitions, which
        #     is fine (only recent actions need accurate diff scores).
        stale_paths: list[str] = []
        for sa in self._stored_actions:
            ss = sa.get("state_str") or {}
            for key in ("before", "after"):
                p = ss.get(key)
                if p and p != snapshot_keeper:
                    stale_paths.append(p)
                    ss[key] = None  # prevent future imread attempts

        if stale_paths:
            await asyncio.to_thread(self._delete_screenshots, stale_paths)
            logger.debug(f"Cleaned up {len(stale_paths)} event screenshots")

        # 7. Dispatch to all processors with a uniform argument set
        for processor in self._segment_processors:
            asyncio.create_task(
                processor.process(
                    segments=segments,
                    type=effective_type,
                    user_text=user_text,
                    image_path=image_path,
                    timestamp=timestamp,
                )
            )

        # 8. Commit ID cursor and cleanup
        self._last_processed_id = self._last_processed_id_tmp
        if self.periodic_delete:
            await asyncio.to_thread(self._delete_observations, observation_ids)

    # ------------------------------------------------------------------
    # Database helpers
    # ------------------------------------------------------------------

    def _load_new_actions_from_db(self) -> tuple[list[str], list[int]]:
        if not os.path.exists(self.db_path):
            logger.info(f"Database file does not exist yet: {self.db_path}")
            return [], []

        try:
            engine = create_engine(f"sqlite:///{self.db_path}")

            with engine.connect() as connection:
                table_check = text(
                    "SELECT name FROM sqlite_master WHERE type='table' AND name='observations'"
                )
                result = connection.execute(table_check)
                if not result.fetchone():
                    logger.info("observations table does not exist yet")
                    return [], []

                if self.periodic_delete:
                    query = text("SELECT id, content FROM observations ORDER BY id")
                    df = pd.read_sql_query(query, connection)
                    logger.info(f"Total {len(df)} actions from database")
                else:
                    query = text(
                        "SELECT id, content FROM observations "
                        "WHERE id > :last_id AND content_type = 'input_text' "
                        "ORDER BY id"
                    )
                    df = pd.read_sql_query(
                        query, connection, params={"last_id": self._last_processed_id}
                    )
                    logger.info(f"Loaded {len(df)} actions from database")

            if not df.empty:
                actions = df["content"].to_list()
                observation_ids = df["id"].to_list()
                if not self.periodic_delete:
                    self._last_processed_id_tmp = observation_ids[-1]
                    logger.info(
                        f"If success, will update Last processed ID: "
                        f"{self._last_processed_id} -> {self._last_processed_id_tmp}"
                    )
                return actions, observation_ids
        except Exception as e:
            logger.warning(f"Error loading actions from database: {e}")
            return [], []

        return [], []

    def _delete_observations(self, observation_ids: list[int]) -> None:
        if not observation_ids:
            return

        engine = create_engine(f"sqlite:///{self.db_path}")
        with engine.connect() as connection:
            placeholders = ",".join([f":id{i}" for i in range(len(observation_ids))])
            params = {f"id{i}": obs_id for i, obs_id in enumerate(observation_ids)}
            query = text(f"DELETE FROM observations WHERE id IN ({placeholders})")
            connection.execute(query, params)
            connection.commit()

        self._last_processed_id = 0

    def _delete_screenshots(self, screenshot_paths: list[str]) -> None:
        for path in screenshot_paths:
            if path and os.path.exists(path):
                try:
                    os.remove(path)
                except Exception as e:
                    logger.warning(f"Failed to delete screenshot {path}: {e}")

    # ------------------------------------------------------------------
    # Query helpers
    # ------------------------------------------------------------------

    async def get_actions_by_timerange(
        self, start_time: float, end_time: float
    ) -> tuple[list[str], list[dict], list[dict]]:
        async with self._lock:
            filtered_entries = [
                entry
                for entry in self._stored_actions
                if start_time <= entry["timestamp"] <= end_time
            ]

        actions = [entry["action"] for entry in filtered_entries]
        states = [entry["state_str"] for entry in filtered_entries]
        time_list = [entry.get("time_info", {}) for entry in filtered_entries]
        return actions, states, time_list

    async def get_total_stored_actions(self) -> int:
        async with self._lock:
            return len(self._stored_actions)
