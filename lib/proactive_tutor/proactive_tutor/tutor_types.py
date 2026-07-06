from dataclasses import dataclass


@dataclass
class Snapshot:
    image_path: str
    timestamp: str


class Observation:
    text: str


class Diagnostic:
    text: str


class Tutor:
    text: str
