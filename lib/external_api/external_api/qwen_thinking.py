"""Separate a Qwen response's leading thinking block across stream boundaries."""


class QwenThinkingParser:
    def __init__(self, enabled: bool):
        self.enabled = enabled
        self.state = "start"
        self.pending = ""

    def feed(self, text: str, *, final: bool = False) -> list[dict[str, str]]:
        self.pending += text
        if self.state == "start":
            probe = self.pending.lstrip()
            if not final and (not probe or "<think>".startswith(probe)):
                return []
            if probe.startswith("<think>"):
                self.pending = probe[len("<think>") :]
                self.state = "thinking"
            else:
                # Qwen templates can put the opening tag in the prompt itself.
                self.state = "thinking" if self.enabled else "answer"
        if self.state == "answer":
            text, self.pending = self.pending, ""
            return [{"content": text}] if text else []
        marker = "</think>"
        before, found, after = self.pending.partition(marker)
        if found:
            self.pending = ""
            self.state = "answer"
            return ([{"reasoning_content": before}] if before else []) + (
                [{"content": after}] if after else []
            )
        held = 0
        if not final:
            for size in range(1, len(marker)):
                if self.pending.endswith(marker[:size]):
                    held = size
        split = len(self.pending) - held
        text, self.pending = self.pending[:split], self.pending[split:]
        return [{"reasoning_content": text}] if text else []
