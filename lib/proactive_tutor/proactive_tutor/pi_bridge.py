"""Local SDK bridge: pi owns execution; Coco owns models, context and tools."""

import asyncio
import hmac
import json
import os
import time
import uuid
from collections.abc import Callable
from datetime import datetime

from external_api.llm import chat_completion
from fastapi import APIRouter, Depends, Header, HTTPException
from fastapi.responses import StreamingResponse
from proactive_tutor.audio_input import validate_wav_base64
from proactive_tutor.tutor_system import TutorSystem
from pydantic import BaseModel, Field


class CompletionRequest(BaseModel):
    messages: list[dict]
    tools: list[dict] | None = None
    # The configured Coco model is authoritative, never a renderer-supplied ID.
    model: str = "coco"
    stream: bool = True


class ToolRequest(BaseModel):
    name: str
    arguments: dict = Field(default_factory=dict)


class TurnRequest(BaseModel):
    user_text: str
    text: str
    metrics: dict | None = None


class SessionRequest(BaseModel):
    model: str
    scenario: str = "everyday_support"
    problem: str = ""
    user_name: str = ""
    ai_tools: list[str] = Field(default_factory=list)
    memory: str = ""
    messages: list[dict[str, str]] = Field(default_factory=list)


class TranscriptionRequest(BaseModel):
    audio_data: str = Field(min_length=1, max_length=16_000_000)


def create_pi_router(get_tutor: Callable[[], TutorSystem | None]) -> APIRouter:
    def authorize(authorization: str = Header(default="")) -> None:
        token = os.environ.get("COCO_PI_BRIDGE_TOKEN", "")
        if not token or not hmac.compare_digest(authorization, f"Bearer {token}"):
            raise HTTPException(401, "Invalid agent bridge credential")

    router = APIRouter(prefix="/agent", dependencies=[Depends(authorize)])

    sessions: dict[str, TutorSystem] = {}
    active_session: str | None = None

    def system(x_coco_session: str | None = Header(default=None)) -> TutorSystem:
        if x_coco_session:
            if x_coco_session not in sessions:
                raise HTTPException(404, "Agent conversation not initialized")
            return sessions[x_coco_session]
        tutor = get_tutor()
        if tutor is None:
            raise HTTPException(503, "TutorSystem not initialized")
        return tutor

    @router.get("/context")
    async def context(tutor: TutorSystem = Depends(system)):
        return {
            "model": tutor.tutor_agent.model,
            "instructions": tutor.tutor_agent.prompt,
            "profile": "\n\n".join(
                [
                    tutor._user_name_context_block(),
                    tutor._ai_tools_context_block(),
                    tutor._curriculum_context_block(),
                    f"Current task: {tutor.problem_statement}",
                    f"User memory: {tutor.memory}",
                ]
            ),
            "history": tutor.conversation_history,
            "tools": tutor.tutor_agent._tool_definitions(),
        }

    @router.post("/active/{session_id}")
    async def activate_session(session_id: str):
        nonlocal active_session
        active_session = session_id
        return {"success": True}

    @router.post("/sessions/{session_id}")
    async def prepare_session(session_id: str, req: SessionRequest):
        # Execution never borrows the foreground tutor's mutable conversation or model.
        tutor = TutorSystem(req.model, req.scenario)
        tutor.problem_statement = req.problem
        tutor.user_name = req.user_name
        tutor.memory = req.memory
        tutor.set_ai_tools(req.ai_tools)
        tutor.restore_conversation(req.messages)
        sessions[session_id] = tutor
        return await context(tutor)

    @router.delete("/sessions/{session_id}")
    async def release_session(session_id: str):
        sessions.pop(session_id, None)
        return {"success": True}

    @router.post("/tools/execute")
    async def execute(req: ToolRequest, tutor: TutorSystem = Depends(system)):
        agent = tutor.tutor_agent
        return await asyncio.to_thread(agent._execute_tool_call, req.model_dump())

    @router.post("/transcribe")
    async def transcribe(
        req: TranscriptionRequest, tutor: TutorSystem = Depends(system)
    ):
        validate_wav_base64(req.audio_data)
        text, _ = await asyncio.to_thread(
            tutor.tutor_agent.transcribe_audio_with_metrics, req.audio_data, "wav"
        )
        if not text.strip() or text.strip().upper() == "<NO_SPEECH>":
            raise HTTPException(422, "No clear speech was detected. Please try again.")
        return {"text": text.strip()}

    @router.post("/turn")
    async def record_turn(
        req: TurnRequest,
        tutor: TutorSystem = Depends(system),
        x_coco_session: str | None = Header(default=None),
    ):
        tutor._chat_messages.extend(
            [
                {"role": "user", "content": req.user_text},
                {"role": "assistant", "content": req.text},
            ]
        )
        ts = datetime.now().strftime("%Y-%m-%d %H:%M:%S")
        tutor.conversation_history.extend(
            [
                f"[{ts}] [User]: {req.user_text}",
                f"[{ts}] [Tutor]: {req.text}",
            ]
        )
        # Keep coaching aware of foreground replies, without importing a
        # background conversation into the currently selected task.
        if x_coco_session and x_coco_session == active_session:
            foreground = get_tutor()
            if foreground is not None and foreground is not tutor:
                foreground._chat_messages.extend(tutor._chat_messages[-2:])
                foreground.conversation_history.extend(tutor.conversation_history[-2:])
        if req.metrics is not None:
            tutor._log_tutor_call(
                "pi_agent",
                req.user_text,
                req.text,
                None,
                llm_metrics=req.metrics,
                session_id=x_coco_session,
            )
        return {"history_length": len(tutor.conversation_history)}

    @router.post("/v1/chat/completions")
    async def completion(req: CompletionRequest, tutor: TutorSystem = Depends(system)):
        model = tutor.tutor_agent.model
        if not req.stream:
            raise HTTPException(400, "The agent bridge requires streaming")

        async def stream():
            loop = asyncio.get_running_loop()
            queue: asyncio.Queue[str] = asyncio.Queue()
            chunks: list[str] = []
            completion_id = f"chatcmpl-{uuid.uuid4().hex}"

            def publish(text: str):
                if text:
                    loop.call_soon_threadsafe(queue.put_nowait, text)

            def event(delta: dict, finish_reason=None, usage=None):
                payload = {
                    "id": completion_id,
                    "object": "chat.completion.chunk",
                    "created": int(time.time()),
                    "model": model,
                    "choices": [
                        {"index": 0, "delta": delta, "finish_reason": finish_reason}
                    ],
                }
                if usage is not None:
                    payload["usage"] = usage
                return f"data: {json.dumps(payload)}\n\n"

            worker = asyncio.create_task(
                asyncio.to_thread(
                    chat_completion,
                    req.messages,
                    model=model,
                    temperature=None,
                    max_tokens=8192,
                    tools=req.tools or None,
                    tool_choice="auto" if req.tools else None,
                    operation="pi_agent",
                    on_chunk=publish,
                )
            )
            try:
                yield event({"role": "assistant"})
                while not worker.done() or not queue.empty():
                    try:
                        text = await asyncio.wait_for(queue.get(), timeout=1)
                    except TimeoutError:
                        yield ": keep-alive\n\n"
                        continue
                    chunks.append(text)
                    yield event({"content": text})
                response, metrics = await worker
                # Some providers only return text when they also request tools.
                full_text = "".join(
                    getattr(part, "text", "") for part in response.content
                )
                if not chunks and full_text:
                    yield event({"content": full_text})
                if response.tool_calls:
                    yield event(
                        {
                            "tool_calls": [
                                {"index": i, **call.model_dump()}
                                for i, call in enumerate(response.tool_calls)
                            ]
                        }
                    )
                yield event(
                    {},
                    "tool_calls" if response.tool_calls else "stop",
                    {
                        "prompt_tokens": metrics.get("prompt_tokens", 0),
                        "completion_tokens": metrics.get("completion_tokens", 0),
                        "total_tokens": metrics.get("total_tokens", 0),
                    },
                )
                yield "data: [DONE]\n\n"
            except asyncio.CancelledError:
                worker.cancel()
                raise
            except Exception as exc:
                yield f"data: {json.dumps({'error': {'message': str(exc), 'type': 'server_error'}})}\n\n"
                yield "data: [DONE]\n\n"
            finally:
                if not worker.done():
                    worker.cancel()

        return StreamingResponse(stream(), media_type="text/event-stream")

    return router
