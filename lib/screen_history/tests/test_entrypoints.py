import os
import subprocess
import sys


def test_frame_bridge_does_not_import_indexing_or_sensing_runtime():
    result = subprocess.run(
        [
            sys.executable,
            "-c",
            "import sys; import screen_history.bridge; "
            "assert 'streamembed' not in sys.modules; "
            "assert 'torch' not in sys.modules; "
            "assert 'sensing.sensing_server' not in sys.modules",
        ],
        env={**os.environ, "LITELLM_LOCAL_MODEL_COST_MAP": "True"},
        capture_output=True,
        text=True,
        timeout=15,
    )
    assert result.returncode == 0, result.stderr


def test_history_worker_has_its_own_entrypoint_without_server_modes():
    result = subprocess.run(
        [sys.executable, "-m", "screen_history.worker", "--help"],
        capture_output=True,
        text=True,
        timeout=15,
    )
    assert result.returncode == 0, result.stderr
    assert "--index-dir" in result.stdout
