import logging
import sys

from rich.logging import RichHandler


def init_logger(name: str, log_level: int = logging.INFO) -> logging.Logger:
    logging.basicConfig(
        level=log_level,
        format="%(message)s",
        datefmt="[%X]",
        handlers=[RichHandler(rich_tracebacks=True)],
    )
    return logging.getLogger(name)


def make_logger_console_persistent(logger: logging.Logger) -> None:
    """
    Configure logger to always write to the original console streams,
    even when stdout/stderr file descriptors are redirected.

    This works by storing references to the current sys.stdout/sys.stderr
    Python objects and configuring all StreamHandlers to use those objects.
    Since os.dup2() only affects file descriptors (not Python file objects),
    the logger will continue writing to the console.

    Args:
        logger: The logger instance to make console-persistent

    """
    # Store references to the current stdout/stderr at this moment
    original_stdout = sys.stdout
    original_stderr = sys.stderr

    # Configure all StreamHandlers to use the original streams
    for handler in logger.handlers:
        if isinstance(handler, logging.StreamHandler):
            # Preserve which stream it was using (stdout vs stderr)
            if handler.stream in (sys.stdout, sys.stderr):
                handler.stream = (
                    original_stdout if handler.stream == sys.stdout else original_stderr
                )

    # Also check root logger handlers (in case logger inherits them)
    root_logger = logging.getLogger()
    for handler in root_logger.handlers:
        if isinstance(handler, logging.StreamHandler):
            if handler.stream in (sys.stdout, sys.stderr):
                handler.stream = (
                    original_stdout if handler.stream == sys.stdout else original_stderr
                )
