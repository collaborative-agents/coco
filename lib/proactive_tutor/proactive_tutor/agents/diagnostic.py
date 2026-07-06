from external_api.llm import prompt_to_text


class DiagnosticAgent:
    def __init__(self, model: str, prompt: str):
        self.model = model
        self.prompt = prompt

    def diagnose(self, text_prompt: str, image_paths=None) -> str:
        return prompt_to_text(
            self.model, self.prompt, text_prompt, image_paths=image_paths
        )
