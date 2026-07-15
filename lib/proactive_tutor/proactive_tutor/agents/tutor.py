from external_api.llm import prompt_to_text, prompt_to_text_with_metrics
from external_api.types import LLMCallMetrics


class TutorAgent:
    def __init__(self, model: str, prompt: str):
        self.model = model
        self.prompt = prompt

    def tutor(self, text_prompt: str, image_paths=None) -> str:
        return prompt_to_text(
            self.model, self.prompt, text_prompt, image_paths=image_paths
        )

    def tutor_with_metrics(
        self, text_prompt: str, image_paths=None
    ) -> tuple[str, LLMCallMetrics]:
        return prompt_to_text_with_metrics(
            self.model,
            self.prompt,
            text_prompt,
            image_paths=image_paths,
            operation="tutor",
        )
