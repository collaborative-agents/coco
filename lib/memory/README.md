# `memory`

Local, cross-session memory for Coco. Semantic outputs from the sensing observer are stored as raw observations.

A background [GUM](https://github.com/generalusermodels/gum)-style pipeline turns batches of observations into propositions and relates them to existing propositions. Identical evidence does not rewrite the original proposition: it creates an append-only update summarizing what is new or corroborated, linked to both the stable proposition and its specific supporting observations. Similar propositions follow GUM's revision path: the related cluster is rewritten into a capped, non-redundant replacement set with proposition-specific evidence links.

The SQLite database uses WAL mode and FTS5 so sensing can write while the tutor queries it. Set `COCO_MEMORY_DB_PATH` to select the database location and `MEMORY_MODEL` to select the model used for proposition maintenance.

Retrieval searches proposition text, linked update summaries, and supporting observations. Missing evidence citations fall back to at most five lexical matches rather than linking the whole batch.

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
