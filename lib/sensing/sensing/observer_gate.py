"""Pause observer operations without stopping screen capture or indexing."""

import asyncio
from collections.abc import Callable, Coroutine
from typing import Any, TypeVar

T = TypeVar("T")


class ObserverPaused(RuntimeError):
    pass


class ObserverGate:
    def __init__(self, enabled: bool = True):
        self.enabled = enabled
        self._tasks: set[asyncio.Task] = set()

    async def set_enabled(self, enabled: bool) -> None:
        self.enabled = enabled
        if not enabled:
            tasks = list(self._tasks)
            for task in tasks:
                task.cancel()
            await asyncio.gather(*tasks, return_exceptions=True)

    async def run(self, operation: Callable[[], Coroutine[Any, Any, T]]) -> T:
        if not self.enabled:
            raise ObserverPaused("Coco's observer is sleeping")
        task = asyncio.create_task(operation())
        self._tasks.add(task)
        try:
            return await task
        except asyncio.CancelledError:
            if not self.enabled:
                raise ObserverPaused("Coco's observer is sleeping") from None
            raise
        finally:
            self._tasks.discard(task)
