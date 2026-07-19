"""PyInstaller build script for the Sensing Server.

Run via: uv run python build_sensing_server.py
Output:  desktop/service-dist/sensing-server/
"""

import os
import platform
import shutil
import subprocess
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parent
DIST_DIR = ROOT / "desktop" / "service-dist" / "sensing-server"
ENTRY = ROOT / "lib" / "sensing" / "sensing" / "sensing_server.py"
SEP = os.pathsep  # ":" on macOS/Linux, ";" on Windows

HIDDEN_IMPORTS = [
    # uvicorn internals
    "uvicorn.logging",
    "uvicorn.loops",
    "uvicorn.loops.auto",
    "uvicorn.protocols",
    "uvicorn.protocols.http",
    "uvicorn.protocols.http.auto",
    "uvicorn.protocols.websockets",
    "uvicorn.protocols.websockets.auto",
    "uvicorn.lifespan",
    "uvicorn.lifespan.on",
    # async DB / cache
    "aiosqlite",
    "greenlet",
    "redis",
    "redis.asyncio",
    "redis.asyncio.client",
    # LLM / tokenizers
    "tiktoken",
    "tiktoken_ext",
    "tiktoken_ext.openai_public",
    # starlette internals used by fastapi
    "starlette.responses",
    "starlette.routing",
    "starlette.middleware",
    "starlette.middleware.cors",
    # workspace packages
    "sensing",
    "external_api",
    "py_utils",
    # numeric / cv
    "numpy",
    "pandas",
    "cv2",
    "PIL",
    "shapely",
    "mss",
]

COLLECT_DATA = [
    "sensing",
    "litellm",
]

COLLECT_BINARIES = [
    "cv2",
    "shapely",
]

if platform.system() == "Darwin":
    HIDDEN_IMPORTS += [
        "Quartz",
        "objc",
        "pynput",
        "pynput.keyboard",
        "pynput.mouse",
        "pynput.keyboard._darwin",
        "pynput.mouse._darwin",
    ]
elif platform.system() == "Linux":
    HIDDEN_IMPORTS += [
        "pynput",
        "pynput.keyboard",
        "pynput.mouse",
        "pynput.keyboard._xorg",
        "pynput.mouse._xorg",
    ]


def main() -> None:
    if not ENTRY.exists():
        print(f"ERROR: Entry point not found: {ENTRY}")
        sys.exit(1)

    if DIST_DIR.exists():
        shutil.rmtree(DIST_DIR)

    cmd = [
        sys.executable,
        "-m",
        "PyInstaller",
        str(ENTRY),
        "--name=sensing-server",
        "--onedir",
        "--noconfirm",
        "--clean",
        f"--distpath={DIST_DIR.parent}",
        f"--workpath={ROOT / 'build' / 'pyinstaller-sensing'}",
        f"--specpath={ROOT / 'build'}",
    ]

    for mod in HIDDEN_IMPORTS:
        cmd += ["--hidden-import", mod]

    for pkg in COLLECT_DATA:
        cmd += ["--collect-data", pkg]

    for pkg in COLLECT_BINARIES:
        cmd += ["--collect-binaries", pkg]

    # Add prompt data files
    prompts_everyday = ROOT / "lib" / "sensing" / "sensing" / "prompts_everyday"
    prompts_ps = ROOT / "lib" / "sensing" / "sensing" / "prompts_problem_solving"
    if prompts_everyday.exists():
        cmd += ["--add-data", f"{prompts_everyday}{SEP}sensing/prompts_everyday"]
    if prompts_ps.exists():
        cmd += ["--add-data", f"{prompts_ps}{SEP}sensing/prompts_problem_solving"]

    print(f"Running PyInstaller for sensing-server...")
    print(f"  Entry: {ENTRY}")
    print(f"  Output: {DIST_DIR}")
    result = subprocess.run(cmd, cwd=ROOT)

    if result.returncode != 0:
        print("ERROR: PyInstaller build failed")
        sys.exit(result.returncode)

    print(f"SUCCESS: sensing-server built → {DIST_DIR}")


if __name__ == "__main__":
    main()
