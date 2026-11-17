<p align="center" style="text-align: center;">
  <img src="assets/github-logo.svg" alt="Coco" width="360">
</p>

<h3 align="center" style="text-align: center;">
Proactive agent that grows with you
</h3>
<p align="center" style="text-align: center;">
| <a href="https://nvlabs.github.io/deep-personalization/"><b>Blog</b></a> | <a href="https://arxiv.org/abs/2611.13457"><b>Paper</b></a> | <a href="https://github.com/mit-han-lab/cti-engine"><b>On-device Engine</b></a> | <a href="https://huggingface.co/collaborative-agents"><b>Data</b></a> |
</p>

---

Coco is a desktop agent that observes your computer-use context and offers help when you need it. It spots repetitive work, brings together context across apps, and suggests useful next steps without waiting for a prompt.

Coco uses a **dual-agent architecture**:

- **Always-on Observer Agent** follows your activity across apps, builds context, and identifies when help would be useful.
- **Execution Agent**, built on [pi](https://github.com/earendil-works/pi), turns that context into action, with **computer-use and browser-use support**.

**Deploy local models with one command** using [CTI-engine](https://github.com/mit-han-lab/cti-engine) on **RTX 5090, RTX PRO 6000, and DGX Spark**, running Linux with **NVIDIA driver 580 or newer** and the **NVIDIA Container Toolkit**. See the [personalization and local deployment guide](lib/personalization/README.md) for commands and configuration.

### You can Use Coco to

- **Get help in the moment:** receive proactive suggestions when you're stuck, summarize what you're working on, and automate repetitive tasks.
- **Build a local personal agent:** turn local compute into an AI agent that can grows with you
- **Study proactive assistance:** export training data and derive workflow from daily usage (more documentation to come)

## Quickstart

Download and install the latest [release version](https://github.com/collaborative-agents/coco/releases/latest) to use Coco directly. We support **macOS (Apple Silicon)**, **macOS (Intel)**, and **Windows**.

To run from source, install [uv](https://docs.astral.sh/uv/) and [Node.js](https://nodejs.org/), then run:

```bash
# 1. Clone
git clone https://github.com/collaborative-agents/coco.git
cd coco

# 2. Install packages for the Python services
uv sync

# 3. Launch the desktop app
cd desktop
npm install
npm start
```

Choose your model provider in onboarding or Settings. Coco supports local and hosted models.

## Three ways to “Ask Coco”

Besides receiving proactive support, you can ask Coco for help at any time:

1. **Click the avatar or toolbar button** to open Coco and type your question.
2. **Press Command + Shift + Space** to open Coco and attach a screenshot as visual context.
3. **Say “Hey Coco”** for the lowest-friction, voice-first entry point. Voice activation must first be enabled in Settings.

You can ask for help through text, voice, or visual context and get assistance instantly.

## Documentation

- [Desktop app and development](desktop/README.md)
- [Personalization and local deployment](lib/personalization/README.md)

## Privacy

Coco runs locally and has no telemetry or analytics. Settings and activity history stay on your machine. Screen understanding sends screenshots to your selected model provider; use a local model to keep that processing on your hardware. See [PRIVACY.md](PRIVACY.md) for details.


## Acknowledgments

Thanks to Long Lin for the avatar design. Coco is built upon [GUM](https://github.com/GeneralUserModels/gum) and [pi](https://github.com/earendil-works/pi).


## License

[Apache License 2.0](LICENSE).

## Citation

If you use Coco in your research, please cite:

```bibtex
@article{shao2026deep,
  title={Deep Personalization: Continuous Context Observation for Local Proactive Agents},
  author={Shao, Yijia and Bian, Song and Guo, Junxian and Jiang, Jindong and Dong, Zhen and Mao, Huizi and Yang, Diyi and Han, Song},
  journal={arXiv preprint arXiv:2611.13457},
  year={2026}
}

@software{coco2026,
  title        = {Coco: Proactive Co-Assistant Through Continuous Context Observation},
  author       = {Shao, Yijia and Wang, Yihan, Wang, Haowen, and Yang, Diyi},
  year         = {2026},
  url          = {https://github.com/collaborative-agents/coco},
  note         = {Proactive co-assistant that senses computer-use context and offers timely help, running fully on-device.}
}
```
