"""Modified from https://github.com/GeneralUserModels/gum/blob/main/gum/observers/observer.py"""

from __future__ import annotations

import asyncio
from abc import ABC, abstractmethod


class Observer(ABC):
    def __init__(self, name: str | None = None) -> None:
        self.update_queue = asyncio.Queue()
        self._name = name or self.__class__.__name__

        # running flag + background task handle
        self._running = True
        self._task: asyncio.Task | None = asyncio.create_task(self._worker_wrapper())

    # ─────────────────────────────── abstract worker
    @abstractmethod
    async def _worker(self) -> None:  # subclasses override
        pass

    # wrapper plugs running flag + exception handling
    async def _worker_wrapper(self) -> None:
        try:
            await self._worker()
        except asyncio.CancelledError:
            print(f"[Observer {self._name}] cancelled")
            pass
        except Exception as e:
            print(f"[Observer {self._name}] crashed with exception: {e}")
            raise
        finally:
            print(f"[Observer {self._name}] stopped")
            self._running = False

    # ─────────────────────────────── public API
    @property
    def name(self) -> str:
        return self._name

    async def get_update(self):
        """Return an Update if immediately available, else None (non-blocking)."""
        try:
            return self.update_queue.get_nowait()
        except asyncio.QueueEmpty:
            return None

    async def stop(self) -> None:
        """Cancel the worker task and drain the queue."""
        if self._task and not self._task.done():
            self._task.cancel()
            try:
                await self._task
            except asyncio.CancelledError:
                pass
        # unblock any awaiters
        while not self.update_queue.empty():
            self.update_queue.get_nowait()
