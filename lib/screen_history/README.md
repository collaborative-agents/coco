# Screen history

Although Coco can operate without retaining screenshots, screen history can preserve details that summaries may miss: What exactly did the earlier email thread say? Where were the files you recently reviewed? Which hotels did you bookmark while planning your trip? Retrieving those details can help Coco draft replies, organize projects, and pick up where you left off.

Coco integrates [StreamEmbed](https://github.com/StarTrail-org/StreamEmbed), introduced in [*Real-time Indexing from Pixels for Screenshot Retrieval*](https://arxiv.org/abs/2611.18516), to **make screen history searchable**. A separate worker samples sensing's existing frames every five seconds and stores screenshots and embeddings locally.

History is enabled by default. Coco's **Settings → Memory** controls indexing independently of observer sleep. Direct service launches can set `COCO_SCREEN_HISTORY_ENABLED=0` to disable it or `COCO_SCREEN_HISTORY_DIR` to choose the storage location. Existing indexes continue to use the same location and format.
