import importlib
import inspect
import os
import sys
from typing import Any


class SerializedSymbol(str):
    module: str
    name: str

    def __new__(cls, module: str, name: str):
        value = f"{module}:{name}"
        obj = super().__new__(cls, value)
        obj.module = module
        obj.name = name
        return obj

    @classmethod
    def from_string(cls, value: str):
        module, name = value.split(":")
        return cls(module, name)

    def __reduce__(self):
        return self.__class__, (self.module, self.name)


def get_symbol_path(cls: Any) -> SerializedSymbol:
    """Get the full module path and class name"""
    module = cls.__module__
    class_name = cls.__name__

    # If it's in __main__, resolve to actual module path.
    if module != "__main__":
        return SerializedSymbol(module, class_name)

    # Get the file where the function is defined
    file_path = os.path.abspath(inspect.getfile(cls))

    # Return the shortest candidate match
    relative_candidates = []
    for path_entry in sys.path:
        actual_path = os.path.abspath(path_entry) if path_entry else os.getcwd()

        if file_path.startswith(actual_path):
            rel_path = os.path.relpath(file_path, actual_path)
            module_name = os.path.splitext(rel_path)[0].replace(os.path.sep, ".")
            # Skip single-component module names as they're usually not proper importable modules
            if "." in module_name:
                relative_candidates.append(module_name)

    # Filter out candidates that do not correspond to an actual importable module
    for candidate in sorted(relative_candidates, key=lambda x: x.count(".")):
        try:
            mod = importlib.import_module(candidate)
            # Check if the imported module's file matches the original file
            if os.path.samefile(getattr(mod, "__file__", ""), file_path):
                return SerializedSymbol(candidate, class_name)
        except Exception:
            continue
    raise ValueError(
        f"Could not find valid importable module name for function {cls} in {file_path}."
    )


def get_symbol_from_path(path: str) -> Any:
    """Reconstruct a class from its serialized path."""
    sp = SerializedSymbol.from_string(path)
    module_path, cls_or_fn_name = sp.module, sp.name

    module = importlib.import_module(module_path)
    return getattr(module, cls_or_fn_name)
