"""
Server-side Python visualization executor.

Executes LLM-generated visualization code in an isolated subprocess and saves
the output as a self-contained HTML file that can be served to the frontend for
embedding in an <iframe>.

Supported output capture:
  - matplotlib / pyplot  →  plt.show() is patched  →  PNG embedded in HTML
  - plotly               →  fig.show() is patched   →  interactive HTML via write_html()

The output HTML includes a small postMessage script so the parent page can
auto-resize the iframe to fit the content height.

All code is statically analysed by ``check_code_safety`` before execution.
Unsafe patterns (file deletion, shell commands, dangerous imports, etc.) cause
an ``UnsafeCodeError`` to be raised and the code is never run.
"""

import ast
import logging
import os
import subprocess
import sys
import textwrap
import uuid
from dataclasses import asdict, dataclass
from pathlib import Path
from typing import Literal

logger = logging.getLogger(__name__)


# ---------------------------------------------------------------------------
# Structured result for execute_visualization
# ---------------------------------------------------------------------------


@dataclass
class VizResult:
    """Structured outcome of a visualization execution attempt.

    ``exec_id`` is non-None only when a usable HTML output was produced.
    ``reason`` explains what happened; ``stderr`` carries the process stderr
    (truncated) on runtime failures so downstream agents can attempt a fix.
    """

    exec_id: str | None = None
    reason: Literal["ok", "safety", "timeout", "runtime", "no_output"] = "ok"
    stderr: str | None = None
    exit_code: int | None = None

    def to_dict(self) -> dict:
        return asdict(self)


# ---------------------------------------------------------------------------
# Static safety checker
# ---------------------------------------------------------------------------


class UnsafeCodeError(ValueError):
    """Raised when submitted code contains disallowed operations."""


# Top-level module names whose import is forbidden.
_FORBIDDEN_IMPORTS: frozenset[str] = frozenset(
    {
        "subprocess",
        "socket",
        "socketserver",
        "SocketServer",
        "shutil",
        "ctypes",
        "fcntl",
        "pty",
        "tty",
        "termios",
        "importlib",
        "pickle",
        "shelve",
        "multiprocessing",
        "concurrent",
        "signal",
        "mmap",
        "resource",
        "pexpect",
        "paramiko",
        "fabric",
        "ftplib",
        "telnetlib",
        "xmlrpc",
        "http",  # http.server etc.
        "urllib",  # urllib.request can fetch URLs server-side
        "httpx",
        "requests",
        "aiohttp",
        "tornado",
    }
)

# Built-in names whose direct call is forbidden.
_FORBIDDEN_BUILTINS: frozenset[str] = frozenset(
    {
        "eval",
        "exec",
        "compile",
        "__import__",
        "breakpoint",
    }
)

# os module attributes that must not be called.
_FORBIDDEN_OS_ATTRS: frozenset[str] = frozenset(
    {
        # File / directory removal
        "remove",
        "unlink",
        "rmdir",
        "removedirs",
        "renames",
        # Shell / process execution
        "system",
        "popen",
        "popen2",
        "popen3",
        "popen4",
        "execv",
        "execve",
        "execvp",
        "execvpe",
        "spawnl",
        "spawnle",
        "spawnlp",
        "spawnlpe",
        "spawnv",
        "spawnve",
        "spawnvp",
        "spawnvpe",
        "fork",
        "forkpty",
        "kill",
        "killpg",
        "abort",
        "startfile",
    }
)

# sys module attributes that must not be called.
_FORBIDDEN_SYS_ATTRS: frozenset[str] = frozenset(
    {
        "exit",
    }
)

# Method names that are forbidden regardless of the object they appear on.
# This catches pathlib Path objects and shutil calls imported with aliases.
_FORBIDDEN_METHOD_NAMES: frozenset[str] = frozenset(
    {
        "unlink",
        "rmdir",
        "rmtree",
        "remove",
        "removedirs",
        "renames",
        "system",
        "popen",
    }
)

# File-open modes that permit writing.
_WRITE_MODES: frozenset[str] = frozenset(
    {
        "w",
        "a",
        "x",
        "wb",
        "ab",
        "xb",
        "wt",
        "at",
        "xt",
        "w+",
        "a+",
        "x+",
        "r+",
        "rb+",
        "r+b",
    }
)


class _SafetyChecker(ast.NodeVisitor):
    """
    AST visitor that raises ``UnsafeCodeError`` on any disallowed pattern.

    Checked patterns
    ----------------
    * Import of forbidden modules (subprocess, socket, shutil, ctypes, …)
    * ``from os import remove`` / ``from sys import exit`` style re-exports
    * Direct calls to dangerous builtins: eval, exec, compile, __import__
    * Calls through known dangerous attributes:
        - os.remove / os.system / os.kill / os.fork / … (full list above)
        - sys.exit
        - shutil.rmtree / shutil.remove
        - Any ``.unlink()`` / ``.rmdir()`` / ``.rmtree()`` / ``.remove()`` /
          ``.system()`` / ``.popen()`` on any object
    * ``open()`` called with a write / append / create mode
    * Names re-exported from ``os`` via ``from os import X`` then called as ``X()``
    """

    def __init__(self) -> None:
        # Track names bound by `from os import X [as Y]` where X is dangerous.
        self._dangerous_os_names: set[str] = set()
        # Track names bound by `from sys import X [as Y]` where X is dangerous.
        self._dangerous_sys_names: set[str] = set()

    # ── Imports ──────────────────────────────────────────────────────────────

    def visit_Import(self, node: ast.Import) -> None:
        for alias in node.names:
            top = alias.name.split(".")[0]
            if top in _FORBIDDEN_IMPORTS:
                raise UnsafeCodeError(
                    f"Importing '{alias.name}' is not allowed in visualization code."
                )
        self.generic_visit(node)

    def visit_ImportFrom(self, node: ast.ImportFrom) -> None:
        if node.module is None:
            self.generic_visit(node)
            return

        top = node.module.split(".")[0]

        if top in _FORBIDDEN_IMPORTS:
            raise UnsafeCodeError(
                f"Importing from '{node.module}' is not allowed in visualization code."
            )

        # Track dangerous names re-exported from os / sys.
        for alias in node.names:
            bound_name = alias.asname or alias.name
            if top == "os" and alias.name in _FORBIDDEN_OS_ATTRS:
                self._dangerous_os_names.add(bound_name)
            if top == "sys" and alias.name in _FORBIDDEN_SYS_ATTRS:
                self._dangerous_sys_names.add(bound_name)

        self.generic_visit(node)

    # ── Calls ────────────────────────────────────────────────────────────────

    def visit_Call(self, node: ast.Call) -> None:
        func = node.func

        if isinstance(func, ast.Name):
            self._check_bare_call(func.id, node)

        elif isinstance(func, ast.Attribute):
            self._check_attr_call(func, node)

        self.generic_visit(node)

    def _check_bare_call(self, name: str, node: ast.Call) -> None:
        if name in _FORBIDDEN_BUILTINS:
            raise UnsafeCodeError(
                f"Calling '{name}()' is not allowed in visualization code."
            )
        if name in self._dangerous_os_names:
            raise UnsafeCodeError(
                f"Calling '{name}()' (re-exported from os) is not allowed."
            )
        if name in self._dangerous_sys_names:
            raise UnsafeCodeError(
                f"Calling '{name}()' (re-exported from sys) is not allowed."
            )
        if name == "open":
            self._check_open_mode(node)

    def _check_attr_call(self, func: ast.Attribute, node: ast.Call) -> None:
        attr = func.attr

        # Dangerous method names on ANY object (.unlink(), .rmtree(), …).
        if attr in _FORBIDDEN_METHOD_NAMES:
            raise UnsafeCodeError(
                f"Calling '.{attr}()' is not allowed in visualization code."
            )

        # Specific module.attr patterns via known variable names.
        if isinstance(func.value, ast.Name):
            obj = func.value.id

            if obj == "os" and attr in _FORBIDDEN_OS_ATTRS:
                raise UnsafeCodeError(
                    f"Calling 'os.{attr}()' is not allowed in visualization code."
                )
            if obj == "os" and attr == "path":
                # os.path itself is fine; the dangerous ops are caught above.
                pass
            if obj == "sys" and attr in _FORBIDDEN_SYS_ATTRS:
                raise UnsafeCodeError(
                    f"Calling 'sys.{attr}()' is not allowed in visualization code."
                )
            if obj == "shutil" and attr in ("rmtree", "remove", "rmdir", "copytree"):
                raise UnsafeCodeError(
                    f"Calling 'shutil.{attr}()' is not allowed in visualization code."
                )

    def _check_open_mode(self, node: ast.Call) -> None:
        """Reject open() calls whose mode constant indicates writing."""
        mode_str: str | None = None

        # open(path, mode)  — positional
        if len(node.args) >= 2:
            arg = node.args[1]
            if isinstance(arg, ast.Constant) and isinstance(arg.value, str):
                mode_str = arg.value

        # open(path, mode="w")  — keyword
        for kw in node.keywords:
            if kw.arg == "mode" and isinstance(kw.value, ast.Constant):
                if isinstance(kw.value.value, str):
                    mode_str = kw.value.value

        if mode_str and mode_str in _WRITE_MODES:
            raise UnsafeCodeError(
                f"Opening files in write/append/create mode ('{mode_str}') "
                "is not allowed in visualization code."
            )


def check_code_safety(code: str) -> None:
    """
    Statically analyse *code* for unsafe operations.

    Raises
    ------
    UnsafeCodeError
        If any disallowed import, call, or file-write pattern is detected.
    SyntaxError
        If *code* is not valid Python (re-raised from ``ast.parse``).
    """
    try:
        tree = ast.parse(code)
    except SyntaxError as exc:
        raise UnsafeCodeError(f"Syntax error in visualization code: {exc}") from exc

    checker = _SafetyChecker()
    checker.visit(tree)


# Root directory where all viz outputs live. Each execution gets its own
# sub-directory named after the exec_id UUID.
VIZ_ROOT = Path(os.environ.get("VIZ_OUTPUT_ROOT", "/tmp/viz_outputs"))

# Maximum wall-clock seconds allowed for user code execution.
EXEC_TIMEOUT = 20  # seconds

# ---------------------------------------------------------------------------
# Auto-resize postMessage script
# ---------------------------------------------------------------------------
# Injected into every output HTML so the parent React component can resize the
# iframe to fit the content without a fixed height.

_RESIZE_SCRIPT = """<script>
(function () {
  // Force scrollable overflow — some viz libraries (Plotly, Bokeh) inject
  // overflow:hidden on html/body which prevents the iframe from scrolling
  // when the content exceeds the parent's max-height cap.
  document.documentElement.style.overflow = "auto";
  if (document.body) document.body.style.overflow = "auto";

  var _lastH = 0;
  function sendHeight() {
    var h = Math.max(
      document.body ? document.body.scrollHeight : 0,
      document.documentElement ? document.documentElement.scrollHeight : 0
    );
    // Only post when height actually changed to avoid msg spam.
    if (h !== _lastH) {
      _lastH = h;
      window.parent.postMessage({ type: "viz-resize", height: h }, "*");
    }
  }

  // Initial measurement after DOM is ready.
  if (document.readyState === "complete") {
    sendHeight();
  } else {
    window.addEventListener("load", sendHeight);
  }

  // Continuous measurement via ResizeObserver — catches async renders
  // (Plotly CDN, image decode, dynamic chart sizing).
  if (typeof ResizeObserver !== "undefined") {
    new ResizeObserver(sendHeight).observe(document.documentElement);
    if (document.body) new ResizeObserver(sendHeight).observe(document.body);
  }

  // Belt-and-suspenders: periodic re-check for the first few seconds after
  // load, covering edge cases where neither load nor ResizeObserver fires
  // (e.g. CDN script injecting content after a network delay).
  var _checks = 0;
  var _timer = setInterval(function () {
    sendHeight();
    if (++_checks >= 10) clearInterval(_timer);
  }, 500);
})();
</script>
"""

# ---------------------------------------------------------------------------
# Preamble injected before user code
# ---------------------------------------------------------------------------
# Patches plt.show() (matplotlib) and Figure.show() (plotly) to write output
# to the file at VIZ_OUTPUT_PATH instead of opening a GUI window.

_PREAMBLE = r"""
import io as _io
import base64 as _b64
import os as _os
import sys as _sys

_VIZ_OUTPUT_PATH = _os.environ.get("VIZ_OUTPUT_PATH", "/tmp/viz_output.html")

# ── matplotlib ──────────────────────────────────────────────────────────────
try:
    import matplotlib as _mpl
    _mpl.use("Agg")  # non-interactive backend, renders to memory
    import matplotlib.pyplot as _plt

    def _mpl_show_patch(*args, **kwargs):
        _buf = _io.BytesIO()
        _plt.savefig(_buf, format="png", bbox_inches="tight", dpi=150)
        _plt.close("all")
        _buf.seek(0)
        _enc = _b64.b64encode(_buf.read()).decode()
        _html = (
            "<!DOCTYPE html><html><head>"
            "<meta charset='utf-8'/>"
            "<style>"
            "  html, body { margin: 0; padding: 8px; background: #fff; }"
            "  img { max-width: 100%; height: auto; display: block; margin: auto; }"
            "</style>"
            "</head><body>"
            f'<img src="data:image/png;base64,{_enc}" />'
            "</body></html>"
        )
        with open(_VIZ_OUTPUT_PATH, "w") as _f:
            _f.write(_html)

    import matplotlib.pyplot as plt
    plt.show = _mpl_show_patch

except ImportError:
    pass

# ── plotly ──────────────────────────────────────────────────────────────────
try:
    import plotly.graph_objects as _go
    import plotly.io as _pio

    def _plotly_show_patch(self, *args, **kwargs):
        _pio.write_html(
            self,
            file=_VIZ_OUTPUT_PATH,
            include_plotlyjs="cdn",
            full_html=True,
        )

    _go.Figure.show = _plotly_show_patch

except ImportError:
    pass

"""


# ---------------------------------------------------------------------------
# Helper: inject resize script
# ---------------------------------------------------------------------------


def _inject_resize_script(html_path: Path) -> None:
    """Inject the postMessage auto-resize script before </body> (or at end)."""
    html = html_path.read_text(encoding="utf-8")
    if "</body>" in html:
        html = html.replace("</body>", _RESIZE_SCRIPT + "\n</body>", 1)
    else:
        html += _RESIZE_SCRIPT
    html_path.write_text(html, encoding="utf-8")


# ---------------------------------------------------------------------------
# Public API
# ---------------------------------------------------------------------------


def execute_visualization(code: str) -> VizResult:
    """Execute visualization code and return a structured :class:`VizResult`.

    The code is first statically analysed by ``check_code_safety``; if any
    disallowed pattern is detected the function returns immediately with
    ``reason="safety"`` without touching the filesystem or spawning a subprocess.

    The HTML output is saved to ``VIZ_ROOT / exec_id / output.html`` and can
    be served to the frontend via the ``/viz/{exec_id}`` endpoint on the tutor
    server (proxied through the coco gateway as ``/api/tutor/viz/{exec_id}``).

    Returns a :class:`VizResult` which always carries ``exec_id`` (for log
    correlation) and, on failure, ``reason``, ``stderr``, and ``exit_code`` so
    downstream agents can attempt an automated fix.
    """
    # ── Safety check (static analysis) ───────────────────────────────────────
    try:
        check_code_safety(code)
    except UnsafeCodeError as exc:
        logger.warning("Unsafe visualization code rejected: %s", exc)
        return VizResult(exec_id=None, reason="safety", stderr=str(exc))

    exec_id = str(uuid.uuid4())
    exec_dir = VIZ_ROOT / exec_id
    exec_dir.mkdir(parents=True, exist_ok=True)

    script_path = exec_dir / "script.py"
    output_path = exec_dir / "output.html"

    # Prepend the preamble so show() calls are automatically captured.
    full_script = textwrap.dedent(_PREAMBLE) + "\n" + textwrap.dedent(code)
    script_path.write_text(full_script, encoding="utf-8")

    env = {**os.environ, "VIZ_OUTPUT_PATH": str(output_path)}

    try:
        result = subprocess.run(
            [sys.executable, str(script_path)],
            env=env,
            timeout=EXEC_TIMEOUT,
            capture_output=True,
            text=True,
        )
        if result.returncode != 0:
            logger.warning(
                "Visualization script exited with code %d. stderr: %s",
                result.returncode,
                result.stderr[:500],
            )
    except subprocess.TimeoutExpired:
        logger.warning(
            "Visualization script timed out after %ds (exec_id=%s)",
            EXEC_TIMEOUT,
            exec_id,
        )
        return VizResult(exec_id=exec_id, reason="timeout")
    except Exception as exc:
        logger.error("Unexpected error running visualization script: %s", exc)
        return VizResult(exec_id=exec_id, reason="runtime", stderr=str(exc))

    # Script ran but exited non-zero (traceback / assertion failure / etc.)
    if result.returncode != 0:
        return VizResult(
            exec_id=exec_id,
            reason="runtime",
            stderr=(result.stderr or "")[:2000],
            exit_code=result.returncode,
        )

    if not output_path.exists() or output_path.stat().st_size == 0:
        logger.warning("Visualization script produced no output (exec_id=%s)", exec_id)
        return VizResult(
            exec_id=exec_id,
            reason="no_output",
            stderr=(result.stderr or "")[:2000],
            exit_code=result.returncode,
        )

    # Inject the auto-resize postMessage script.
    try:
        _inject_resize_script(output_path)
    except Exception as exc:
        logger.warning("Could not inject resize script: %s", exc)

    logger.info("Visualization ready: exec_id=%s", exec_id)
    return VizResult(exec_id=exec_id, reason="ok", exit_code=0)
