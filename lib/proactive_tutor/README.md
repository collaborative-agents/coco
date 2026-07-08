## `proactive_tutor`

A FastAPI server that turns a screen **observation** (produced upstream by the [`sensing`](../sensing/README.md) observer) into the assistant message the user sees.

### How it works

```
observation (from sensing) → build context prompt → Tutor LLM → guidance
                                                                    ↓
                                                       optional visualization
```

`TutorSystem` receives the observation as a pre-computed string and assembles an XML context prompt (`<memory>`/`<problem_statement>`, `<conversation_history>`, `<ai_tools_context>`, `<observation>`, …), then makes a single **Tutor** LLM call to produce the guidance.


### Usage

```bash
uv run python -m proactive_tutor.tutor_server \
    --model_name=<provider/model> \
    --port=8081
```

### Training data

When `$COCO_RECORDS_DIR` is set (the launcher points sensing and tutor at the same directory), every tutor LLM call is appended to `tutor_calls.jsonl`.
