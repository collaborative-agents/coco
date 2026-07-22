PROPOSE_SYSTEM = """You maintain a grounded model of a user's work context.
Infer only claims supported by the supplied observations. Preserve named tools, documents, projects, people, and tasks because they improve later retrieval.
Return JSON only."""

PROPOSE_PROMPT = """Analyze these observations about {user_name}:

{observations}

Every observation begins with a stable ``[observation_id=...]`` marker. Return up to {max_propositions} non-overlapping propositions as:
{{"propositions":[{{"proposition":"...","reasoning":"...","confidence":1,"decay":1,"observation_ids":["id"]}}]}}
Each proposition must cite only the observation IDs that directly support it. Confidence is 1-10 evidence strength. Decay is 1 for short-lived context and 10 for durable context. Be conservative and do not treat visible content as proof
of a lasting preference."""

RELATION_SYSTEM = """Classify how a new proposition relates to existing ones.
Return JSON only. IDENTICAL means the same claim, SIMILAR means overlapping claims that should be consolidated, and UNRELATED means neither."""

RELATION_PROMPT = """New proposition:
[new] {new_text}
Reasoning: {new_reasoning}

Existing propositions:
{existing}

Return {{"label":"IDENTICAL|SIMILAR|UNRELATED","target_ids":[1,2]}}.
Only include IDs that directly participate in the stated relationship."""

REVISE_SYSTEM = """Consolidate a cluster of similar user-context propositions.
Produce a clear, non-redundant replacement set grounded only in the supplied observations. Preserve named people, applications, documents, projects, and tools when supported because they improve retrieval. Return JSON only."""

REVISE_PROMPT = """Similar existing propositions:
{propositions}

New inferred claim:
{new_text}
Reasoning: {new_reasoning}

Supporting observations:
{observations}

Rewrite, merge, or split the similar claims into at most {max_propositions} non-overlapping propositions. Every resulting proposition must cite only the observation IDs that directly support it. Return:
{{"propositions":[{{"proposition":"...","reasoning":"...","confidence":1,"decay":1,"observation_ids":["id"]}}]}}
Confidence is 1-10 evidence strength. Decay is 1 for short-lived context and 10 for durable context."""

UPDATE_SYSTEM = """Record an append-only update to an existing user-context proposition.
Summarize only what the new evidence adds or corroborates. Do not rewrite the original proposition and do not repeat background details unless needed to make the update understandable. Return JSON only."""

UPDATE_PROMPT = """Relation: {relation}

Original proposition(s):
{propositions}

New inferred claim:
{new_text}
Reasoning: {new_reasoning}

New supporting observations:
{observations}

Return one concise linked update as:
{{"summary":"what is new or newly corroborated","reasoning":"why the new evidence supports this update","observation_ids":["id"]}}
Use only observation IDs shown under New supporting observations."""
