import base64
import enum
import json
import os

from external_api.litellm_api import (
    ImageURL,
    ImageURLContent,
    LiteLLMMessage,
    TextContent,
)
from external_api.llm import chat_completion


def encode_image(img_path: str, return_url: bool = False) -> str:
    """Encode the image to base64."""
    with open(img_path, "rb") as fh:
        img = base64.b64encode(fh.read()).decode()
    if return_url:
        return f"data:image/jpeg;base64,{img}"
    return img


MAX_DIFF = 100000.0


class NodeType(enum.Enum):
    ACTION = "action"
    SEQUENCE = "sequence"


# Action Node


class Time:
    def __init__(
        self,
        before: str,
        after: str,
        range: float | None = None,
        diff: float | None = None,
    ):
        """Initialize the time object associated with an action."""
        self.before = before
        self.after = after
        self.range = range
        self.diff = diff

    @classmethod
    def from_json(cls, path: str | None = None, data: dict[str, str] | None = None):
        if path is not None:
            data = json.load(open(path))
        elif data is None:
            return None
        return cls(**data)  # type: ignore

    def to_json(self, path: str | None = None):
        data = {
            "before": self.before,
            "after": self.after,
            "range": self.range,
            "diff": self.diff,
        }
        if path is not None:
            json.dump(data, open(path, "w"))
        return data

    def get_time(self, reverse: bool = False) -> str:
        if reverse:
            return self.after if (self.after is not None) else self.before
        else:
            return self.before if (self.before is not None) else self.after


class State:
    def __init__(self, before: str, after: str, diff_score: float | None = None):
        """Initialize the state object associated with an action.
        Args:
            before: The screenshot path of the state before the action.
            after: The screenshot path of the state after the action.
            diff_score: The MSE difference score between the before and after states.
        """
        self.before = before
        self.after = after
        self.diff_score = diff_score

    @classmethod
    def from_json(cls, path: str | None = None, data: dict | None = None):
        if path is not None:
            data = json.load(open(path))
        assert data is not None, "Either path or data must be provided."
        return cls(
            before=data["before"],
            after=data["after"],
            diff_score=data.get("diff_score", None),
        )  # type: ignore

    def to_json(self, path: str | None = None):
        data = {
            "before": self.before,
            "after": self.after,
            "diff_score": self.diff_score,
        }
        if path is not None:
            json.dump(data, open(path, "w"))
        return data

    def get_state(self, reverse: bool = False) -> str:
        if reverse:
            return self.after if (self.after is not None) else self.before
        else:
            return self.before if (self.before is not None) else self.after


class ActionNode:
    def __init__(
        self,
        action: str,
        state: dict | State,
        goal: str | None = None,
        time: dict | Time | None = None,
    ):
        self.node_type = NodeType.ACTION
        self.length = 1
        self.action = action
        self.state = state if isinstance(state, State) else State(**state)
        self.goal = goal
        if time is None:
            self.time = None
        else:
            self.time = time if isinstance(time, Time) else Time(**time)
        self.status = SequenceStatus.SUCCESS
        self.model = os.environ.get("WORKFLOW_INDUCTION_MODEL", "")
        assert self.model != "", (
            "WORKFLOW_INDUCTION_MODEL is not set in environment variables."
        )

    def __str__(self):
        return f"ActionNode(action={self.action}, state={self.state}, goal={self.goal})"

    def get_semantic_repr(self):
        if self.goal is not None:
            return self.goal
        else:
            return self.action

    def get_num_actions(self):
        return 1

    def get_goal(self):
        """Verbalize the `goal` of the `action`."""
        content = self.get_llm_input(add_state=False)
        prompt = (
            "Your task is to summarize the goal in a short sentence, given the action and the state."
            + "Do not include prefix like 'the goal is'. Do not include action-specific details like the coordinates."
        )
        try:
            goal, _ = chat_completion(
                [
                    LiteLLMMessage(role="system", content=[TextContent(text=prompt)]),
                    LiteLLMMessage(
                        role="user",
                        content=content,
                    ),
                ],
                model=self.model,
                reasoning_effort="minimal",
            )
            assert isinstance(goal.content[0], TextContent)
            self.goal = goal.content[0].text
        except Exception as _:
            # print(f"[WARNING] Error getting goal: {e}")
            self.goal = ""

    @classmethod
    def from_json(cls, path: str | None = None, data: dict | None = None):
        if path is not None:
            data = json.load(open(path))
        assert data is not None, "Either path or data must be provided."
        state = State.from_json(data=data["state"])
        time = Time.from_json(data=data.get("time", None))
        return cls(
            action=data["action"], state=state, goal=data.get("goal", None), time=time
        )

    def to_json(self, path: str | None = None):
        """Save the action node to a JSON file.
        Args:
            path: The path to save the action node.
        """
        data = {
            "node_type": self.node_type.value,
            "action": self.action,
            "state": self.state.to_json(),
            "goal": self.goal,
            "time": self.time.to_json() if self.time is not None else None,
        }
        if path is not None:
            json.dump(data, open(path, "w"))
        return data

    def get_llm_input(
        self, add_state: bool = False
    ) -> list[TextContent | ImageURLContent]:
        """Get the content in llm input format."""
        content = []
        text = self.action
        if self.goal is not None:
            text += f" ({self.goal})"
        content.append(TextContent(text=text))

        if add_state:
            image_path = self.state.get_state()
            if (image_path is not None) and (image_path != ""):
                image_url = encode_image(image_path, return_url=True)
                content.append(ImageURLContent(image_url=ImageURL(url=image_url)))
        # print("Action Content: ", content)
        # cont = input("Is the content correct? (y/N)")
        return content


# Sequence Node


class SequenceStatus(enum.Enum):
    SUCCESS = "success"
    FAILURE = "failure"
    UNKNOWN = "unknown"


GET_NODE_GOAL_PROMPT = """
Your task is to summarize the goal in a short sentence, given a sequence of subgoals.

## Example input
[1] Navigating into the Documents folder
[2] Navigating into the Finance folder
[3] Find the `expenses.csv` file.

## Example output
Navigate through the Documents then Finance folders to find the `expenses.csv` file.
"""


class SequenceNode:
    def __init__(
        self,
        nodes: list,
        goal: str | None = None,
        status: SequenceStatus | None = None,
        status_reason: str | None = None,
    ):
        self.node_type = NodeType.SEQUENCE
        self.nodes = nodes
        self.length = len(self.nodes)

        self.goal = goal
        self.status_reason = status_reason
        if status is None:
            self.status = SequenceStatus.UNKNOWN
        else:
            for v in SequenceStatus:
                if v.value == status:
                    self.status = v
                    break
            else:
                self.status = SequenceStatus.UNKNOWN
        self.model = os.environ.get("WORKFLOW_INDUCTION_MODEL", "")
        assert self.model != "", (
            "WORKFLOW_INDUCTION_MODEL is not set in environment variables."
        )

    def __str__(self):
        return f"SequenceNode(goal={self.goal}, nnodes={len(self.nodes)}, status={self.status})"

    def get_semantic_repr(self):
        if self.goal is not None:
            return self.goal
        else:
            subgoals = [n.get_semantic_repr() for n in self.nodes]
            return "\n".join([sg for sg in subgoals if sg is not None])

    def get_num_actions(self):
        num_actions = 0
        for n in self.nodes:
            num_actions += n.get_num_actions()
        return num_actions

    def get_goal(
        self,
    ):
        """Summarize the `goal` from the `nodes`."""
        subgoals = [f"[{i}] {n.get_semantic_repr()}" for i, n in enumerate(self.nodes)]
        prompt = GET_NODE_GOAL_PROMPT
        goal, _ = chat_completion(
            [
                LiteLLMMessage(role="system", content=[TextContent(text=prompt)]),
                LiteLLMMessage(
                    role="user",
                    content=[TextContent(text="\n".join(subgoals))],
                ),
            ],
            model=self.model,
            reasoning_effort="minimal",
        )
        assert isinstance(goal.content[0], TextContent)
        self.goal = goal.content[0].text

    def get_status(
        self,
    ):
        """Get the success/failure status of the `nodes` in achieving the `goal`."""
        prompt = GET_NODE_STATUS_PROMPT + "\n\nGoal: " + (self.goal or "")
        # print("Status Prompt: ", prompt)
        content = get_nodes_content_for_status(self.nodes, add_state=True)
        try:
            response, _ = chat_completion(
                [
                    LiteLLMMessage(role="system", content=[TextContent(text=prompt)]),
                    LiteLLMMessage(
                        role="user",
                        content=content,
                    ),
                ],
                model=self.model,
                reasoning_effort="minimal",
            )
            assert isinstance(response.content[0], TextContent)
            response = response.content[0].text.strip().upper()
            self.status_reason = response
            # print("Status Response: ", response)
            # cont = input("Is the response correct? (y/N)")
            self.status = (
                SequenceStatus.SUCCESS if "YES" in response else SequenceStatus.FAILURE
            )
        except Exception as e:
            print(f"[WARNING] Error getting status: {e}")
            self.status = SequenceStatus.UNKNOWN
            self.status_reason = str(e)

    @classmethod
    def from_json(cls, path: str | None = None, data: dict | None = None):
        if path is not None:
            # print(f"Loading sequence node from {type(path)} | {path}...")
            data = json.load(open(path))
        elif data is None:
            raise ValueError("Either path or data must be provided.")

        nodes = []
        for node in data["nodes"]:  # type: ignore
            if node["node_type"] == NodeType.ACTION.value:
                nodes.append(ActionNode.from_json(data=node))
            elif node["node_type"] == NodeType.SEQUENCE.value:
                nodes.append(cls.from_json(data=node))
        return cls(
            nodes=nodes,
            goal=data.get("goal", None),  # type: ignore
            status=data.get("status", None),  # type: ignore
            status_reason=data.get("status_reason", None),  # type: ignore
        )

    def to_json(self, path: str | None = None):
        """Save the sequence node to a JSON file.
        Args:
            path: The path to save the sequence node.
        """
        data = {
            "node_type": self.node_type.value,
            "nodes": [node.to_json() for node in self.nodes],
            "goal": self.goal,
            "status": self.status.value,
            "status_reason": self.status_reason,
        }
        if path is not None:
            json.dump(data, open(path, "w"))
        return data


def get_nodes_content_for_status(
    node_list: list[ActionNode | SequenceNode],
    add_state: bool = True,
) -> list[TextContent | ImageURLContent]:
    """Get the content of the sequence as text for status classification."""
    content = []
    for n in node_list:
        if isinstance(n, ActionNode):
            text = n.action
        else:
            text = n.get_semantic_repr() + f" (status: {n.status.value})"
        content.append(TextContent(text=text))

        if add_state:
            if isinstance(n, ActionNode):
                sn = n
            else:
                sn = get_last_action(n)
            image_path = sn.state.get_state()
            if (image_path is not None) and (image_path != ""):
                image_url = encode_image(image_path, return_url=True)
                content.append(ImageURLContent(image_url=ImageURL(url=image_url)))
    return content


GET_NODE_STATUS_PROMPT = """
Your task is to determine if the computer-use action sequence roughly achieves the goal.
Output "YES" if the goal is achieved, otherwise output "NO".
"""

# Utility functions


def get_new_node(action_node_list: list[ActionNode]) -> ActionNode | SequenceNode:
    """Get a new node from a segment."""
    if len(action_node_list) == 1:
        return action_node_list[0]
    else:
        assert len(action_node_list) > 1, f"Length is {len(action_node_list)}"
        node = SequenceNode(nodes=action_node_list)
        return node


# Annotate Sequence Node


# split into sub-nodes
def parse_chunk(chunk: str) -> dict:
    """Parse chunk info dict from string."""
    s = chunk.index("[")
    e = chunk.index("]", s + 1)
    text = chunk[e + 1 :].strip()
    # print(chunk[s+1:e])
    if "-" not in chunk[s + 1 : e]:
        s, e = chunk[s + 1 : e], chunk[s + 1 : e]
    else:
        s, e = chunk[s + 1 : e].split("-")
    s, e = int(s.strip()), int(e.strip())
    return {"start": s, "end": e, "length": e - s + 1, "goal": text}


def parse_annotation(annotation: str, verbose: bool = False) -> list[dict]:
    """Parse the sub-node info (start, end, length, goal) from the LLM response."""
    # if verbose: print("Annotation: ", annotation)
    index = annotation.find("[")
    chunks = [s.strip() for s in annotation[index:].split("\n") if s.strip()]
    chunks = [c for c in chunks if c.startswith("[")]
    parsed_chunks = []
    for c in chunks:
        try:
            cp = parse_chunk(c)
            parsed_chunks.append(cp)
        except Exception as _:
            # print(f"Failed to parse chunk: {c}")
            pass
    return parsed_chunks


# Validate Chunks


def remove_empty_chunks(chunks: list[dict], node_list: list[ActionNode]) -> list[dict]:
    """Remove chunks with no steps."""
    chunk_index = None
    for i, c in enumerate(chunks):
        actions = node_list[c["start"] : c["end"] + 1]
        if len(actions) == 0:
            chunk_index = i
            break
        if len(actions) < c["length"]:
            chunks[i]["end"] = c["start"] + len(actions) - 1
            chunks[i]["length"] = len(actions)
    if chunk_index is not None:
        chunks = chunks[:chunk_index]
        # print(f"Removed chunk {chunk_index} because it has no steps.")
    return chunks


def validate_chunks(chunks: list[dict], node_list: list[ActionNode]) -> list[dict]:
    """Validate the chunks contain the same number of ActionNodes."""
    chunks = remove_empty_chunks(chunks, node_list)
    # print("Non-Empty Chunks: ", chunks)
    total_steps = sum([c["length"] for c in chunks])
    # print(f"Total Chunk Steps: {total_steps} vs Trajectory Length:{len(node_list)}")
    if total_steps < len(node_list):  # add the remaining steps to the last chunk
        if len(chunks) == 0:
            chunks.append(
                {
                    "start": 0,
                    "end": len(node_list) - 1,
                    "length": len(node_list),
                    "goal": None,
                }
            )
        else:
            chunks[-1]["end"] = len(node_list) - 1
            chunks[-1]["length"] = len(node_list) - chunks[-1]["start"]
        total_steps = sum([c["length"] for c in chunks])
        # if total_steps != len(node_list):
        #     print(f"[WARNING] Total Chunk Steps: {chunks} vs Trajectory Length:{len(node_list)}")
    return chunks


# Input Node to LLM


def get_content_for_action_node_sequence(
    node_list: list[ActionNode],
    add_state: bool = True,
) -> list[TextContent | ImageURLContent]:
    """Get the content of the sequence as text for goal summarization."""
    content = []
    for i, n in enumerate(node_list):
        assert isinstance(n, ActionNode), f"Node is not ActionNode: {type(n)} {n}"
        n_content = n.get_llm_input(add_state=((i == len(node_list) - 1) and add_state))
        content.extend(n_content)
    return content  # type: ignore


ANNOTATE_NODE_PROMPT = """
You task is to decompose the computer-use activities into chunks. Each chunk should be driven by a meaningful subtask objective (e.g., "enter document title", "find the expense data in folders"). Describe the subtask objective in a natural language sentence.
You want to ensure you output as few chunks as possible.

For each output chunk, note the start and end index in the input, as follows:
## Example input
[0] click_left(34.1, 329.1)
[1] ... ...

## Example Output
[0-3] open the finance expense validation instruction in Google Docs
[4-5] Navigating into the Documents folder


If multiple consecutive chunks have similar objectives, you should merge them. Make sure the output chunks do not have overlapping steps.
Strictly follow the format of the example output.
The computer screenshots are only about the task content, no personal or sensitive information is included.
Start indexing from 0.
Mention the specific software or tool used in the action.
"""


def annotate_high_level_nodes(
    node: SequenceNode,
    bucket_size: int = 10,
    verbose: bool = False,
):
    """Annotated the highest-level `SequenceNode`."""
    prompt = ANNOTATE_NODE_PROMPT

    # split into buckets
    total_nodes = len(node.nodes)
    num_buckets = (total_nodes + bucket_size - 1) // bucket_size
    if verbose:
        print(f"Total nodes: {total_nodes} | Num buckets: {num_buckets}")

    # split nodes inside each bucket
    new_nodes = []
    for i in range(num_buckets):
        nodes = node.nodes[i * bucket_size : (i + 1) * bucket_size]
        # print(f"Bucket {i} with {len(nodes)} nodes...")
        content = get_content_for_action_node_sequence(nodes, add_state=True)
        # print("Prompt: ", prompt)
        # print("Content: ", content[: -1])
        # cont = input("Proceed with LLM call? (y/N)")
        # print(f"LLM MESSAGE content[:10]: {content[:10] if len(content) > 10 else content} ...")
        response, _ = chat_completion(
            [
                LiteLLMMessage(role="system", content=[TextContent(text=prompt)]),
                LiteLLMMessage(
                    role="user",
                    content=content,
                ),
            ],
            model=node.model,
            reasoning_effort="minimal",
        )
        assert isinstance(response.content[0], TextContent)
        chunks = parse_annotation(response.content[0].text.strip())
        while chunks is None:
            # print("Failed to parse annotation. Please try again.")
            response, _ = chat_completion(
                [
                    LiteLLMMessage(role="system", content=[TextContent(text=prompt)]),
                    LiteLLMMessage(
                        role="user",
                        content=content,
                    ),
                ],
                model=node.model,
                reasoning_effort="minimal",
            )
            assert isinstance(response.content[0], TextContent)
            response = response.content[0].text.strip()
            chunks = parse_annotation(response, nodes)  # type: ignore
        chunks = validate_chunks(chunks, nodes)
        # print("Validated Chunks: ", chunks)

        for c in chunks:
            new_node = get_new_node(nodes[c["start"] : c["end"] + 1])
            new_node.goal = c["goal"]
            if new_node.node_type == NodeType.SEQUENCE:
                assert isinstance(new_node, SequenceNode)
                new_node.get_status()
            # print("New Node | Goal: ", new_node.goal, " |  Status: ", new_node.status)
            new_nodes.append(new_node)
        if verbose:
            print(f"Bucket {i} done: {len(new_nodes)} new nodes..")

    if len(new_nodes) == 1:
        node = new_nodes[0]
        # print("Replace Original Node: Goal: ", node.goal, " |  Status: ", node.status)
    else:
        node.nodes = new_nodes
        # print(f"Expanding to {len(node.nodes)} new child nodes.")

        # update the goal and status
        node.get_goal()
        node.get_status()
        # print("High-Level Node: Goal: ", node.goal, " |  Status: ", node.status)

    return node


# Get First/Last Action


def get_first_action(node: ActionNode | SequenceNode) -> ActionNode:
    if isinstance(node, ActionNode):
        return node
    else:
        return get_first_action(node.nodes[0])


def get_last_action(node: ActionNode | SequenceNode) -> ActionNode:
    if isinstance(node, ActionNode):
        return node
    else:
        return get_last_action(node.nodes[-1])


def merge_nodes(node_list: list[ActionNode | SequenceNode]) -> SequenceNode:
    merged_nodes = []
    for _, node in enumerate(node_list):
        if isinstance(node, ActionNode):
            merged_nodes.append(node)
        elif isinstance(node, SequenceNode):
            merged_nodes.extend(node.nodes)
    return SequenceNode(nodes=merged_nodes)


def viz_node(node, indent_level: int = 0):
    content = (
        f"[{indent_level}]"
        + " " * indent_level
        + "Type: "
        + node.node_type.value
        + " | "
    )
    if isinstance(node, ActionNode) and node.action is not None:
        content += "Action: " + node.action + " | "
    else:
        content += "Action: None | "
    if node.goal is not None:
        content += "Goal: " + node.goal.split("\n")[0]
    else:
        content += "Goal: None"
    content += " | Status: " + node.status.value
    print(content)
    if node.node_type == NodeType.SEQUENCE:
        assert isinstance(node, SequenceNode)
        for child in node.nodes:
            viz_node(child, indent_level + 1)
