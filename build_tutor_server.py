"""PyInstaller build script for the Tutor Server.

Run via: uv run python build_tutor_server.py
Output:  desktop/service-dist/tutor-server/
"""

import os
import shutil
import subprocess
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parent
DIST_DIR = ROOT / "desktop" / "service-dist" / "tutor-server"
ENTRY = ROOT / "lib" / "proactive_tutor" / "proactive_tutor" / "tutor_server.py"
SEP = os.pathsep

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
    # starlette internals used by fastapi
    "starlette.responses",
    "starlette.routing",
    "starlette.middleware",
    "starlette.middleware.cors",
    # LLM / tokenizers
    "tiktoken",
    "tiktoken_ext",
    "tiktoken_ext.openai_public",
    # workspace packages
    "proactive_tutor",
    "external_api",
    "py_utils",
]

COLLECT_DATA = [
    "proactive_tutor",
    "litellm",
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
        "--name=tutor-server",
        "--onedir",
        "--noconfirm",
        "--clean",
        f"--distpath={DIST_DIR.parent}",
        f"--workpath={ROOT / 'build' / 'pyinstaller-tutor'}",
        f"--specpath={ROOT / 'build'}",
    ]

    for mod in HIDDEN_IMPORTS:
        cmd += ["--hidden-import", mod]

    for pkg in COLLECT_DATA:
        cmd += ["--collect-data", pkg]

    # Add prompt data files
    prompts_everyday = (
        ROOT / "lib" / "proactive_tutor" / "proactive_tutor" / "prompts_everyday"
    )
    prompts_ps = (
        ROOT
        / "lib"
        / "proactive_tutor"
        / "proactive_tutor"
        / "prompts_problem_solving"
    )
    if prompts_everyday.exists():
        cmd += ["--add-data", f"{prompts_everyday}{SEP}proactive_tutor/prompts_everyday"]
    if prompts_ps.exists():
        cmd += [
            "--add-data",
            f"{prompts_ps}{SEP}proactive_tutor/prompts_problem_solving",
        ]

    print(f"Running PyInstaller for tutor-server...")
    print(f"  Entry: {ENTRY}")
    print(f"  Output: {DIST_DIR}")
    result = subprocess.run(cmd, cwd=ROOT)

    if result.returncode != 0:
        print("ERROR: PyInstaller build failed")
        sys.exit(result.returncode)

    print(f"SUCCESS: tutor-server built → {DIST_DIR}")


if __name__ == "__main__":
    main()
