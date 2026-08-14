from personalization.llm_io import parse_json_object
from personalization.memory.evaluate import evaluate_memory_accuracy
from personalization.memory.evolve import (
    EvolveConfig,
    SelfEvolvingLearner,
    UtilityStats,
)
from personalization.memory.roles import curate, generate, infer_memory, reflect
from personalization.memory.selection import (
    EvolutionSelection,
    select_evolution_moments,
)
from personalization.memory.state import (
    InferredInsight,
    InferredMemory,
    MemoryBullet,
    MemoryOp,
    SectionedMemory,
    ops_from_json,
)
from personalization.observer_output import normalize_need_support

# Compatibility aliases for callers of the original memory facade.
norm_need = normalize_need_support
parse_json_obj = parse_json_object

__all__ = [
    "EvolveConfig",
    "EvolutionSelection",
    "InferredInsight",
    "InferredMemory",
    "MemoryBullet",
    "MemoryOp",
    "SectionedMemory",
    "SelfEvolvingLearner",
    "UtilityStats",
    "curate",
    "evaluate_memory_accuracy",
    "generate",
    "infer_memory",
    "norm_need",
    "ops_from_json",
    "parse_json_obj",
    "reflect",
    "select_evolution_moments",
]
