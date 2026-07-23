from __future__ import annotations

import os
import sys
from pathlib import Path


def default_memory_db_path() -> Path:
    """Return the shared local database used by sensing and MCP readers."""
    configured = os.environ.get("COCO_MEMORY_DB_PATH")
    if configured:
        return Path(configured).expanduser()
    if os.name == "nt":
        user_data = Path(os.environ.get("APPDATA", Path.home())) / "coco"
    elif sys.platform == "darwin":
        user_data = Path.home() / "Library" / "Application Support" / "coco"
    else:
        user_data = (
            Path(os.environ.get("XDG_CONFIG_HOME", Path.home() / ".config")) / "coco"
        )
    return user_data / "memory" / "memory.db"
