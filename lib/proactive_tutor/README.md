## `proactive_tutor`
FastAPI server exposing TutorSystem over HTTP.

Run:
    uv run python -m proactive_tutor.tutor_server

Endpoints:
    GET  /health
    POST /events/user_prompt   {observation, text_prompt} -> {guidance}
    POST /events/pause         {observation, text_prompt} -> {guidance}
    GET  /context              -> {conversation_history, problem_statement}
    POST /context/problem_statement  {problem_statement} -> {status}
