"""Profile SkyrimNet's LLM calls: what each call is for, how big it is, how long it took, what it cost.

Reads SkyrimNet's request/response logs (logs/openrouter_input*.log, openrouter_output*.log), matches
them by request id, classifies each call, and prices it at the effective per-model rate from
OpenRouter's activity API (usage / tokens over the last 30 days, so caching is already folded in).

Usage:
  python profile_calls.py [--logs DIR] [--keyfile PATH] [--out calls.json]

Token counts are estimated from text length (CHARS_PER_TOKEN); images (vision calls) are counted at
IMAGE_TOKENS each. Both are estimates; the report says so.
"""
import argparse
import collections
import glob
import json
import os
import re
import urllib.request
from datetime import datetime

DEFAULT_LOGS = r"C:\Modlists\LoreRim\overwrite\SKSE\Plugins\SkyrimNet\logs"
DEFAULT_KEYFILE = os.path.expanduser(r"~\Documents\.openrouter.txt")
CHARS_PER_TOKEN = 3.6
IMAGE_TOKENS = 1000

HEADER = re.compile(r"^\[([\d\- :.]+)\] \[([^\]]*)\] (\w+) (request|response|complete response) \[([^\]]+)\]:\s*$")

# Human names for SkyrimNet's job tags (the second [..] in each log header).
TAG_NAMES = {
    "decisions": "Decisions (mood, speaker, recall)",
    "meta": "Meta helpers",
    "memory": "Memory writing",
    "vision": "Vision (OmniSight place descriptions)",
    "intel_story_dm": "IntelEngine story director",
    "action_evaluation": "Action evaluation",
    "gamemaster_evaluation": "Gamemaster",
    "agencyengine_impulse": "AgencyEngine impulses",
    "agencyengine_resolve": "AgencyEngine resolution",
    "sever_background": "SeverActions background",
    "combat": "Combat chatter",
    "CharacterProfileGeneration": "Character profile generation",
    "DiaryGeneration": "Diary entries",
    "UniversalTranslator": "Translator",
    "label_assist": "Label assist",
}


def read_blocks(paths):
    """Yield (time, tag, kind, req_id, body_text) for every header+body block in the given logs."""
    for path in paths:
        cur = None
        with open(path, encoding="utf-8", errors="replace") as f:
            for line in f:
                line = line.rstrip("\n")
                m = HEADER.match(line)
                if m:
                    if cur:
                        yield cur
                    cur = [m.group(1), m.group(2), m.group(3) + " " + m.group(4), m.group(5), []]
                elif cur is not None:
                    cur[4].append(line)
        if cur:
            yield cur


def text_of(content):
    if isinstance(content, str):
        return content, 0
    texts, images = [], 0
    for part in content or []:
        if part.get("type") == "image_url":
            images += 1
        else:
            texts.append(part.get("text", ""))
    return "".join(texts), images


def classify(tag, req):
    """Category for one request: the job tag, with default (untagged) calls split by their task."""
    if tag:
        return TAG_NAMES.get(tag, tag)
    if "messages" not in req:
        return "Other"
    whole = "".join(text_of(m["content"])[0] for m in req["messages"])
    m = re.search(r"Respond as (.+?) in conversation\. You are speaking to (.+?)\.", whole)
    if m:
        player = player_name(whole)
        return "NPC dialogue to player" if m.group(2) == player else "NPC-to-NPC dialogue"
    if re.search(r"^You are \S.*?, a bard", whole, re.M):
        return "Bard songs"
    if re.match(r"\s*You are ", whole) and "## Task" not in whole:
        return "Player inner thoughts"
    if "Your recent memories" in whole:
        return "Memory-driven prompts"
    return "Other dialogue-model calls"


_player_cache = {}


def player_name(text):
    # SkyrimNet's dialogue prompts name the player in the "You are speaking to" line; the player is the
    # name most often spoken to across all calls, computed once in main() and stored here.
    return _player_cache.get("name")


def load_calls(logdir):
    reqs, resps = {}, {}
    for t, tag, kind, rid, body in read_blocks(sorted(glob.glob(os.path.join(logdir, "openrouter_input*.log")))):
        try:
            req = json.loads("\n".join(body).strip(), strict=False)
        except json.JSONDecodeError:
            continue
        reqs[rid] = (t, tag, kind, req)
    for t, tag, kind, rid, body in read_blocks(sorted(glob.glob(os.path.join(logdir, "openrouter_output*.log")))):
        resps[rid] = (t, "\n".join(body).strip())

    # The player: whoever NPCs are most often "speaking to".
    spoken_to = collections.Counter()
    for _, _, _, req in reqs.values():
        for msg in req.get("messages", []):
            for m in re.finditer(r"You are speaking to (.+?)\.", text_of(msg["content"])[0]):
                spoken_to[m.group(1)] += 1
    _player_cache["name"] = spoken_to.most_common(1)[0][0] if spoken_to else None

    calls = []
    for rid, (t, tag, kind, req) in reqs.items():
        chars, images = 0, 0
        for msg in req.get("messages", []):
            txt, imgs = text_of(msg["content"])
            chars += len(txt)
            images += imgs
        if "messages" not in req:  # decisions route: a typed question, not chat
            chars = len(json.dumps(req))
        resp_t, resp_text = resps.get(rid, (None, ""))
        latency = None
        if resp_t:
            fmt = "%Y-%m-%d %H:%M:%S.%f"
            latency = (datetime.strptime(resp_t, fmt) - datetime.strptime(t, fmt)).total_seconds()
        calls.append({
            "id": rid, "time": t, "tag": tag, "category": classify(tag, req),
            "model": req.get("model") or ("decisions" if tag == "decisions" else "?"),
            "in_tokens": round(chars / CHARS_PER_TOKEN + images * IMAGE_TOKENS),
            "images": images,
            "out_tokens": round(len(resp_text) / CHARS_PER_TOKEN),
            "latency_s": latency, "reply": resp_text[:600],
        })
    return calls


def effective_prices(keyfile):
    """$ per input-token-equivalent per model from OpenRouter's 30-day activity (management key).

    Output tokens are weighted 4x input (typical price ratio for these models), so
    price_in = usage / (prompt + 4 * completion) and price_out = 4 * price_in.
    """
    key = None
    for line in open(keyfile, encoding="utf-8"):
        if line.lower().startswith("management key"):
            key = re.search(r"sk-or-v1-[A-Za-z0-9]+", line).group(0)
    if not key:
        return {}
    req = urllib.request.Request("https://openrouter.ai/api/v1/activity", headers={"Authorization": f"Bearer {key}"})
    rows = json.load(urllib.request.urlopen(req, timeout=30))["data"]
    agg = collections.defaultdict(lambda: [0.0, 0, 0])
    for r in rows:
        a = agg[r["model"]]
        a[0] += r.get("usage") or 0
        a[1] += r.get("prompt_tokens") or 0
        a[2] += r.get("completion_tokens") or 0
    prices = {}
    for model, (usd, p, c) in agg.items():
        weighted = p + 4 * c
        if weighted:
            prices[model] = (usd / weighted, 4 * usd / weighted)
    return prices


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--logs", default=DEFAULT_LOGS)
    ap.add_argument("--keyfile", default=DEFAULT_KEYFILE)
    ap.add_argument("--out", default="calls.json")
    a = ap.parse_args()

    calls = load_calls(a.logs)
    try:
        prices = effective_prices(a.keyfile)
    except Exception as e:  # offline, no key: report without cost
        print(f"(no OpenRouter prices: {e})")
        prices = {}
    for c in calls:
        model = "typesafe/jev-1.13" if c["model"] == "decisions" else c["model"]
        pin, pout = prices.get(model, (0.0, 0.0))
        c["cost"] = c["in_tokens"] * pin + c["out_tokens"] * pout

    by = collections.defaultdict(list)
    for c in calls:
        by[c["category"]].append(c)
    total_cost = sum(c["cost"] for c in calls) or 1
    span = (min(c["time"] for c in calls), max(c["time"] for c in calls)) if calls else ("", "")
    print(f"{len(calls)} calls, {span[0][:16]} to {span[1][:16]}, player = {_player_cache.get('name')}\n")
    print(f"{'category':40} {'calls':>6} {'avg in tok':>10} {'avg out':>8} {'est cost':>9} {'share':>6} {'median s':>8}")
    for cat, cs in sorted(by.items(), key=lambda kv: -sum(c["cost"] for c in kv[1])):
        cost = sum(c["cost"] for c in cs)
        lats = sorted(c["latency_s"] for c in cs if c["latency_s"] is not None)
        med = f"{lats[len(lats) // 2]:.1f}" if lats else "-"
        print(f"{cat[:40]:40} {len(cs):6} {sum(c['in_tokens'] for c in cs) // len(cs):10} "
              f"{sum(c['out_tokens'] for c in cs) // len(cs):8} ${cost:8.3f} {100 * cost / total_cost:5.1f}% {med:>8}")
    print(f"\nestimated total ${sum(c['cost'] for c in calls):.2f}")
    json.dump({"span": span, "player": _player_cache.get("name"), "calls": calls,
               "prices": {k: list(v) for k, v in prices.items()},
               "assumptions": {"chars_per_token": CHARS_PER_TOKEN, "image_tokens": IMAGE_TOKENS}},
              open(a.out, "w", encoding="utf-8"))


if __name__ == "__main__":
    main()
