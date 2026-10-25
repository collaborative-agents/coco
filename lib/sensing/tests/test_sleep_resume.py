from collections import deque
from types import SimpleNamespace
from unittest.mock import AsyncMock, Mock

import pytest
from sensing.segment_processor import AiTutoringProcessor
from sensing.streamer import Streamer


@pytest.mark.asyncio
@pytest.mark.parametrize("preserve", [True, False])
async def test_sensing_session_preserves_tutor_only_when_resuming(preserve):
    client = SimpleNamespace(post=AsyncMock(return_value=Mock()))
    processor = SimpleNamespace(
        snapshot_buffer=SimpleNamespace(obs_history=["old observation"]),
        _observation_history=deque(maxlen=10),
        _http_client=client,
        tutor_url="http://tutor",
    )
    await AiTutoringProcessor.configure_session(
        processor, preserve_tutor_context=preserve
    )
    assert processor.snapshot_buffer.obs_history == []
    if preserve:
        client.post.assert_not_awaited()
    else:
        client.post.assert_awaited_once_with("http://tutor/context/reset")


@pytest.mark.asyncio
async def test_streamer_forwards_resume_policy():
    processor = SimpleNamespace(configure_session=AsyncMock())
    streamer = SimpleNamespace(_segment_processors=[processor])
    await Streamer.configure_session(streamer, preserve_tutor_context=True)
    processor.configure_session.assert_awaited_once_with(preserve_tutor_context=True)
