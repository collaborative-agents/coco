# `memory`

Local, cross-session memory for Coco. Semantic outputs from the sensing observer are stored as raw observations.

A background [GUM](https://github.com/generalusermodels/gum)-style pipeline turns batches of observations into propositions and relates them to existing propositions. Identical evidence does not rewrite the original proposition: it creates an append-only update summarizing what is new or corroborated, linked to both the stable proposition and its specific supporting observations. Similar propositions follow GUM's revision path: the related cluster is rewritten into a capped, non-redundant replacement set with proposition-specific evidence links.

The SQLite database uses WAL mode and FTS5 so sensing can write while the tutor queries it. Set `COCO_MEMORY_DB_PATH` to select the database location and `MEMORY_MODEL` to select the model used for proposition maintenance.

Retrieval searches proposition text, linked update summaries, and supporting observations. Missing evidence citations fall back to at most five lexical matches rather than linking the whole batch.

## Filesystem primitives

`MemoryFileSystem` provides read-only, filesystem-inspired access over the same
SQLite store:

| Command | Result |
| --- | --- |
| `ls(sort_by="score")` | All propositions sorted by score, updated time, or confidence |
| `stat(proposition)` | Proposition metadata, score, evidence count, proposition time, and observation-time range |
| `cat(proposition)` | Proposition text |
| `read(proposition)` | Proposition text and all linked observations, newest first |
| `head(proposition, k)` | The `k` newest linked observations |
| `tail(proposition, k)` | The `k` oldest linked observations |
| `grep(pattern, items, regex=False)` | Literal or regular-expression text matches |
| `bm25(query, propositions)` | BM25 ranking over proposition text |
| `find(propositions, ...)` | Observation/proposition time, confidence, and durability filters |
| `du(proposition)` | Linked observation count |
| `df()` | Store, linkage, pending, and database-size statistics |

The score used by `ls` and `stat` combines normalized confidence with an
age-decay curve whose half-life is controlled by proposition durability. It is
query-independent; `bm25` supplies query relevance.

`pipe` evaluates ordinary one-argument callables immediately from left to
right:

```python
from memory import MemoryFileSystem, MemoryStore, pipe

memory = MemoryFileSystem(MemoryStore("memory.db"))
results = pipe(
    memory.ls(sort_by="score"),
    lambda items: memory.find(
        items,
        time_start="2026-07-27T00:00:00-07:00",
        time_end="2026-08-02T23:59:59.999999-07:00",
        time_field="observation",
        min_confidence=7,
    ),
    lambda items: memory.grep("oauth", items),
    lambda items: memory.bm25("callback failure", items),
)
```

`find` accepts ISO-8601 dates/datetimes (preferred) and legacy Unix seconds.
Its default `time_field="observation"` selects propositions with at least one
linked observation in the interval—the time when the remembered activity
happened. Use `proposition_created` or `proposition_updated` to filter by the
memory record's own lifecycle instead. A date-only end bound includes the full
UTC calendar day; use an explicit offset for a user's local calendar window.
`stat` reports both proposition creation/update timestamps and the oldest/newest
linked-observation timestamps, with Unix and UTC ISO representations.

## Citation
If you find the cross-session memory helpful, please citing the original [GUM paper](https://arxiv.org/abs/2505.10831):
```
@misc{shaikh2025creatinggeneralusermodels,
    title={Creating General User Models from Computer Use},
    author={Omar Shaikh and Shardul Sapkota and Shan Rizvi and Eric Horvitz and Joon Sung Park and Diyi Yang and Michael S. Bernstein},
    year={2025},
    eprint={2505.10831},
    archivePrefix={arXiv},
    primaryClass={cs.HC},
    url={https://arxiv.org/abs/2505.10831},
}
```
