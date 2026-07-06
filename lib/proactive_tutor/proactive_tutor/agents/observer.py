from external_api.llm import prompt_to_text


class ObserverAgent:
    def __init__(self, model: str, prompt: str):
        self.model = model
        self.prompt = prompt

    def observe(self, text_prompt: str, image_paths=None) -> str:
        return prompt_to_text(
            self.model, self.prompt, text_prompt, image_paths=image_paths
        )
