"""Lightweight worker status shared by the bridge and indexer."""

import json
import time
from pathlib import Path


def write_status(index_dir: Path, state: str, stats: dict, error: str | None = None):
    path = index_dir / "worker-status.json"
    staging = path.with_suffix(".tmp")
    staging.write_text(
        json.dumps(
            {
                "state": state,
                "updated_at": time.time(),
                "stats": dict(stats),
                "error": error,
            }
        )
    )
    staging.chmod(0o600)
    staging.replace(path)
