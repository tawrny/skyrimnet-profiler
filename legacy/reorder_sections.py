"""Reorder the context block of SkyrimNet's dialogue prompt by volatility, for prompt caching.

The dialogue prompt ends with a long user message (setting, state, inventories, quests, memories, nearby
people, task, actions: ~11k tokens). A model server can only reuse an unchanged prefix, and a few small
sections in it change every turn (an NPC's physical activity, the time, who is nearby), the first of them
near the top: so every turn re-read the whole block. Moving those sections to just before "## Task", least
volatile first, leaves the stable bulk as a reusable prefix and keeps the task and actions last.

A moved section keeps its owner: a "## Physical Activity" under "## Vigilance's Current State (THIS IS YOU)"
becomes "## Physical Activity (Vigilance, you)".

reorder(text) returns the reordered text, or the text unchanged when it has no "## Task" section.
"""
import re

# Sections that change turn to turn, least volatile first. Matched on the heading text (without the #s).
SECTIONS_BY_VOLATILITY = [
    "Worn Equipment",
    "Physical Activity",
    "How You Feel",
    "Current Weather",
    "Current Time",
    "Nearby People",
    "Recent Events",
]
ANCHOR = "Task"  # moved sections go just before this heading
OWNER = re.compile(r"^(?P<name>.+?)'s (?:Current State|Character Profile)\b.*?(?P<you>THIS IS YOU\))?\s*$")

HEADING = re.compile(r"(?m)^(#{2,3}) (.+)$")


def _chunks(text):
    """Split into (heading_line or None, level, title, body) chunks at every ## / ### heading."""
    out, last = [], 0
    marks = list(HEADING.finditer(text))
    if not marks:
        return [(None, 0, None, text)]
    if marks[0].start() > 0:
        out.append((None, 0, None, text[: marks[0].start()]))
    for i, m in enumerate(marks):
        end = marks[i + 1].start() if i + 1 < len(marks) else len(text)
        out.append((m.group(0), len(m.group(1)), m.group(2).strip(), text[m.end():end]))
    return out


def reorder(text):
    chunks = _chunks(text)
    titles = [c[2] for c in chunks]
    if ANCHOR not in titles:
        return text
    owner = None
    keep, moved = [], {k: [] for k in SECTIONS_BY_VOLATILITY}
    for head, level, title, body in chunks:
        if title:
            m = OWNER.match(title)
            if m and level == 2:
                owner = m.group("name") + (", you" if m.group("you") else "")
        if title in moved and title != ANCHOR:
            label = f"{'#' * level} {title}" + (f" ({owner})" if owner else "")
            moved[title].append(label + body)
        else:
            keep.append((head or "") + body)
    tail = "".join(s for k in SECTIONS_BY_VOLATILITY for s in moved[k])
    if not tail:
        return text
    out = "".join(keep)
    i = out.find(f"## {ANCHOR}\n")
    if i < 0:
        return text
    if not tail.endswith("\n"):
        tail += "\n"
    return out[:i] + tail + out[i:]


def _volatile(title):
    return title in SECTIONS_BY_VOLATILITY or (title or "").endswith(VOLATILE_SUFFIXES)


VOLATILE_SUFFIXES = ("Potentially Relevant Memories",)  # change with the conversation's topic


def split(text):
    """(stable, rest) for a dialogue context block: stable = the sections that don't change turn to turn, in
    their original order; rest = the volatile sections (least volatile first, owners kept), then the task
    and everything after it unchanged. None when the block has no task heading."""
    chunks = _chunks(text)
    titles = [c[2] for c in chunks]
    if ANCHOR not in titles:
        return None
    at = titles.index(ANCHOR)
    owner, stable, moved = None, [], {}
    for head, level, title, body in chunks[:at]:
        if title:
            m = OWNER.match(title)
            if m and level == 2:
                owner = m.group("name") + (", you" if m.group("you") else "")
        if title and _volatile(title):
            label = f"{'#' * level} {title}" + (f" ({owner})" if owner and title in SECTIONS_BY_VOLATILITY else "")
            moved.setdefault(title if title in SECTIONS_BY_VOLATILITY else "~memories", []).append(label + body)
        else:
            stable.append((head or "") + body)
    order = ["~memories"] + SECTIONS_BY_VOLATILITY  # memories are the least volatile of the moved
    rest = "".join(s for k in order for s in moved.get(k, []))
    rest += "".join((h or "") + b for h, _, _, b in chunks[at:])
    return "".join(stable), rest


def reorder_request(req):
    """Move the stable part of a dialogue request's final context block to the end of its system message, so
    it sits before the conversation history and stays a reusable prefix. Returns True when it changed."""
    msgs = req.get("messages") or []
    if len(msgs) < 2 or msgs[0].get("role") != "system":
        return False
    last, system = msgs[-1], msgs[0]
    if not isinstance(last.get("content"), str):
        return False
    parts = split(last["content"])
    if not parts or not parts[0].strip():
        return False
    stable, rest = parts
    addition = "\n\n" + stable.strip("\n") + "\n"
    if isinstance(system.get("content"), str):
        system["content"] = system["content"].rstrip("\n") + addition
    elif isinstance(system.get("content"), list):  # SkyrimNet's cache-breakpoint layout: a list of text parts
        system["content"].append({"type": "text", "text": addition})
    else:
        return False
    last["content"] = rest
    return True
