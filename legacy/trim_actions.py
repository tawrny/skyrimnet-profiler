"""Shorten SkyrimNet's action list before it reaches the model.

The action list is ~40% of a dialogue prompt. Two things make it big: each category's description runs to
a paragraph of edge cases after its first sentence, and every actor parameter repeats the full list of
nearby actors ("Valid Choices: 'Tawrny', 'Mikael', ..."), several times per prompt.

trim(text) rewrites the "**Available Actions:**" block of a prompt:
  - the actor names are listed once, above the actions; each parameter points to that list;
  - each description keeps its first sentence (at most MAX_DESC characters);
  - TriggerDialogueLine is left whole (its codes and rules matter).
Text without an action block is returned unchanged.

Run directly for a dry run over the relay's log: python trim_actions.py [calls-local.jsonl]
"""
import json
import re
import sys

MAX_DESC = 220
KEEP_WHOLE = {"TriggerDialogueLine"}
CHOICES = re.compile(r"Valid Choices: ((?:'[^']*'(?:, )?)+)\. Choose one of these actor names EXACTLY\.")
SEP = " — "  # SkyrimNet's " — " between an action's parameters and its description


def _first_sentence(desc):
    desc = desc.strip()
    m = re.search(r"(?<=[.!?])\s", desc)
    first = desc[: m.start()] if m else desc
    if len(first) > MAX_DESC:
        first = first[:MAX_DESC].rsplit(" ", 1)[0] + "…"
    return first


def trim(text):
    start = text.find("**Available Actions:**")
    if start < 0:
        return text
    end = text.find("**Guidelines:**", start)
    end = end if end > 0 else len(text)
    block = text[start:end]

    names = []
    for m in CHOICES.finditer(block):
        for n in re.findall(r"'([^']*)'", m.group(1)):
            if n not in names:
                names.append(n)
    block = CHOICES.sub("Must be a name from the Nearby actors line above, exactly.", block)

    # An action's entry starts at "- `Name`" and runs until the next entry; some descriptions span many lines.
    entries, cur = [], None
    for line in block.split("\n"):
        if re.match(r"- `[^`]+`", line):
            if cur is not None:
                entries.append(cur)
            cur = [line]
        elif cur is not None and line.strip():
            cur.append(line)
        else:
            if cur is not None:
                entries.append(cur)
                cur = None
            entries.append(line)
    if cur is not None:
        entries.append(cur)
    out = []
    for e in entries:
        if isinstance(e, str):
            out.append(e)
            continue
        whole = " ".join(s.strip() for s in e)
        name = re.match(r"- `([^`]+)`", whole).group(1)
        if name in KEEP_WHOLE or SEP not in e[0]:
            out.extend(e)
            continue
        head, _, desc = whole.partition(SEP) if whole.count(SEP) == 1 else whole.rpartition(SEP)
        if '"}' in head or not head.endswith("}"):
            head, _, desc = whole.partition(SEP)
        out.append(head + SEP + _first_sentence(desc))
    block = "\n".join(out)
    if names:
        block = block.replace("**Available Actions:**",
                              "**Available Actions:**\nNearby actors: " + ", ".join(names) + ".", 1)
    return text[:start] + block + text[end:]


def trim_request(req):
    """Apply trim() to every message of an OpenAI-style request in place; return chars saved."""
    saved = 0
    for m in req.get("messages", []):
        c = m.get("content")
        if isinstance(c, str):
            new = trim(c)
            saved += len(c) - len(new)
            m["content"] = new
        elif isinstance(c, list):
            for part in c:
                if isinstance(part, dict) and isinstance(part.get("text"), str):
                    new = trim(part["text"])
                    saved += len(part["text"]) - len(new)
                    part["text"] = new
    return saved


if __name__ == "__main__":
    path = sys.argv[1] if len(sys.argv) > 1 else "calls-local.jsonl"
    totals, example = [], None
    for line in open(path, encoding="utf-8"):
        try:
            rec = json.loads(line, strict=False)
        except ValueError:
            continue
        req = rec.get("request", {})
        whole = "".join(m["content"] if isinstance(m.get("content"), str) else "" for m in req.get("messages", []))
        if "**Available Actions:**" not in whole:
            continue
        before = len(whole)
        saved = trim_request(json.loads(json.dumps(req)))
        totals.append((before, saved))
        if example is None and "Economy" in whole:
            s = whole.find("**Available Actions:**")
            example = (whole[s:whole.find("**Guidelines:**", s)], trim(whole)[s:])
    n = len(totals)
    avg_before = sum(b for b, _ in totals) / n / 4
    avg_saved = sum(s for _, s in totals) / n / 4
    print(f"{n} prompts with an action list: avg ~{avg_before:.0f} tok, trim saves ~{avg_saved:.0f} tok "
          f"({100 * avg_saved / avg_before:.0f}%)")
    if example:
        before, after = example
        print(f"\n--- example action list: {len(before) // 4} tok before, "
              f"{len(after[:after.find('**Guidelines:**')]) // 4} tok after ---")
        print(after[:after.find("**Guidelines:**")][:2600])
