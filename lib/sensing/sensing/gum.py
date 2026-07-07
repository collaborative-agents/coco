"""Modified from https://github.com/GeneralUserModels/gum/blob/main/gum/gum.py"""
from __future__ import annotations

import asyncio
import logging
import os
import pathlib
from collections.abc import Callable
from contextlib import asynccontextmanager

from sensing.observer import Observer
from sensing.screen import Update
from sqlalchemy import (
    DateTime,
    String,
    Text,
)
from sqlalchemy import (
    text as sql_text,
)
from sqlalchemy.ext.asyncio import (
    AsyncAttrs,
    AsyncEngine,
    async_sessionmaker,
    create_async_engine,
)
from sqlalchemy.orm import (
    DeclarativeBase,
    Mapped,
    mapped_column,
)
from sqlalchemy.sql import func


class Base(AsyncAttrs, DeclarativeBase):
    pass


async def init_db(
    db_path: str,
    db_directory: str | None = None,
):
    """Create the SQLite file and ORM tables (first run only)."""
    if db_directory:
        path = pathlib.Path(db_directory).expanduser()
        path.mkdir(parents=True, exist_ok=True)
        db_path = str(path / db_path)

    engine: AsyncEngine = create_async_engine(
        f"sqlite+aiosqlite:///{db_path}",
        future=True,
        connect_args={
            "timeout": 30,
            "isolation_level": None,
        },
        poolclass=None,
    )

    async with engine.begin() as conn:
        await conn.execute(sql_text("PRAGMA journal_mode=WAL"))
        await conn.execute(sql_text("PRAGMA busy_timeout=30000"))

        await conn.run_sync(Base.metadata.create_all)

    Session = async_sessionmaker(engine, expire_on_commit=False, autoflush=False)
    return engine, Session


class Observation(Base):
    __tablename__ = "observations"

    id: Mapped[int] = mapped_column(primary_key=True)
    observer_name: Mapped[str] = mapped_column(String(100), nullable=False)
    content: Mapped[str] = mapped_column(Text, nullable=False)
    content_type: Mapped[str] = mapped_column(String(50), nullable=False)

    created_at: Mapped[str] = mapped_column(
        DateTime(timezone=True), server_default=func.now(), nullable=False
    )
    updated_at: Mapped[str] = mapped_column(
        DateTime(timezone=True),
        server_default=func.now(),
        onupdate=func.now(),
        nullable=False,
    )

    def __repr__(self) -> str:
        return f"<Observation(id={self.id}, observer={self.observer_name})>"


class GUM:
    def __init__(
        self,
        user_name: str,
        *observers: Observer,
        data_directory: str = "~/Downloads/coco-records",
        db_name: str = "actions.db",
        max_concurrent_updates: int = 4,
        verbosity: int = logging.INFO,
    ):
        # basic paths
        data_directory = os.path.expanduser(data_directory)
        os.makedirs(data_directory, exist_ok=True)

        # runtime
        self.user_name = user_name
        self.observers: list[Observer] = list(observers)

        # logging
        self.logger = logging.getLogger("gum")
        self.logger.setLevel(verbosity)
        if not self.logger.handlers:
            h = logging.StreamHandler()
            h.setFormatter(
                logging.Formatter("%(asctime)s - %(levelname)s - %(message)s")
            )
            self.logger.addHandler(h)

        self.engine = None
        self.Session = None
        self._db_name = db_name
        self._data_directory = data_directory

        self._update_sem = asyncio.Semaphore(max_concurrent_updates)
        self._tasks: set[asyncio.Task] = set()
        self._loop_task: asyncio.Task | None = None
        self.update_handlers: list[Callable[[Observer, Update], None]] = []

    def start_update_loop(self):
        if self._loop_task is None:
            self._loop_task = asyncio.create_task(self._update_loop())

    async def stop_update_loop(self):
        if self._loop_task:
            self._loop_task.cancel()
            try:
                await self._loop_task
            except asyncio.CancelledError:
                pass
            self._loop_task = None

    async def connect_db(self):
        if self.engine is None:
            self.engine, self.Session = await init_db(
                self._db_name, self._data_directory
            )

    async def __aenter__(self):
        await self.connect_db()
        self.start_update_loop()
        return self

    async def __aexit__(self, exc_type, exc, tb):
        await self.stop_update_loop()

        # wait for any in-flight handlers
        if self._tasks:
            await asyncio.gather(*self._tasks, return_exceptions=True)

        # stop observers
        for obs in self.observers:
            await obs.stop()

    async def _update_loop(self):
        """
        Efficiently wait for *any* observer to produce an Update and
        dispatch it through the semaphore-guarded handler.
        """
        while True:
            gets = {
                asyncio.create_task(obs.update_queue.get()): obs
                for obs in self.observers
            }

            done, pending = await asyncio.wait(
                gets.keys(), return_when=asyncio.FIRST_COMPLETED
            )

            # Cancel tasks that didn't complete this round to avoid leaking
            # background tasks that accumulate across iterations.
            for task in pending:
                task.cancel()

            for fut in done:
                upd: Update = fut.result()
                obs = gets[fut]

                t = asyncio.create_task(self._run_with_gate(obs, upd))
                self._tasks.add(t)

    async def _run_with_gate(self, observer: Observer, update: Update):
        """Wrapper that enforces max_concurrent_updates."""
        async with self._update_sem:
            try:
                await self._default_handler(observer, update)
            finally:
                self._tasks.discard(asyncio.current_task())  # type: ignore

    async def _handle_audit(self, obs: Observation) -> bool:
        return False

    async def _default_handler(self, observer: Observer, update: Update) -> None:
        async with self._session() as session:
            observation = Observation(
                observer_name=observer.name,
                content=update.content,
                content_type=update.content_type,
            )

            if await self._handle_audit(observation):
                return

            session.add(observation)
            await session.flush()

    @asynccontextmanager
    async def _session(self):
        async with self.Session() as s:  # type: ignore
            async with s.begin():
                yield s

    def add_observer(self, observer: Observer):
        self.observers.append(observer)

    def remove_observer(self, observer: Observer):
        if observer in self.observers:
            self.observers.remove(observer)

    def register_update_handler(self, fn: Callable[[Observer, Update], None]):
        self.update_handlers.append(fn)
