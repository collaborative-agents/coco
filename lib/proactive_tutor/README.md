## `proactive_tutor`

A FastAPI server that turns a screen **observation** (produced upstream by the [`sensing`](../sensing/README.md) observer) into the assistant message the user sees.

### How it works

```
observation (from sensing) → build context prompt → Tutor LLM → guidance
                                                                    ↓
                                                       optional visualization
```

`TutorSystem` receives the observation as a pre-computed string and assembles an XML context prompt (`<memory>`/`<problem_statement>`, `<conversation_history>`, `<ai_tools_context>`, `<observation>`, …), then makes a single **Tutor** LLM call to produce the guidance.

### Tool providers

The tutor owns the model loop, while tool discovery and execution live behind a
small provider interface:

```text
TutorSystem (prompts, chat history, memory, sensing, metrics)
└── CompositeToolProvider
    ├── NativeToolProvider
    │   ├── observe_screen
    │   ├── get_user_context
    │   └── get_recent_observations
    ├── AppleCalendarProvider (EventKit)
    └── MCPToolProvider
        └── Google Calendar
```

Every provider supplies schemas, execution, and concise model-facing policy.
`CompositeToolProvider` rejects name collisions, validates the call boundary,
and routes a call to its owner. A new email, Slack, or internal provider can be
added in `proactive_tutor/tools/factory.py` without changing `TutorAgent`.

Calendar tools are enabled for the `everyday_support` scenario.

### Usage

```bash
uv run python -m proactive_tutor.tutor_server \
    --model_name=<provider/model> \
    --port=8081
```

### Training data

When `$COCO_RECORDS_DIR` is set (the launcher points sensing and tutor at the same directory), every tutor LLM call is appended to `tutor_calls.jsonl`.
