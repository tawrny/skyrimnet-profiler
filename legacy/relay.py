"""Logging relay between SkyrimNet and a local OpenAI-compatible server.

SkyrimNet only logs prompts and replies for its OpenRouter provider. This relay listens where SkyrimNet
sends local requests, forwards them unchanged to the real server, streams the reply back as it arrives,
and appends {time, path, request, reply, status, seconds} to a JSONL log for profile_calls.py.

Usage: python relay.py [--listen 8089] [--upstream http://127.0.0.1:8090] [--log calls-local.jsonl]
Standard library only. Stop with Ctrl+C.
"""
import argparse
import http.client
import json
import threading
import time
import urllib.parse
from datetime import datetime
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer

LOCK = threading.Lock()

# SkyrimNet jobs answered without thinking: small, structured answers where the 64-token thinking budget cost
# ~2 s a call for no gain. Matched on the opening of the first message. Tested 2026-11-24 on 8 captured calls
# each: shape 8/8 for all; mood 7/8 and action choice 8/8 the same as with thinking. NOT listed on purpose: the
# speaker/target pickers ("Determine which NPC...", "## Task"), which reversed direction or picked someone else
# without thinking; dialogue (plans in its reply without thinking); memory writing.
NO_THINK_PREFIXES = (
    "You are an AI mood analyzer",
    "You select the single most appropriate action",
    "You are a memory search query generator",
    "You are an ambient banter director",
    "# NPC Social Life",
)
HOP_BY_HOP = {"connection", "keep-alive", "transfer-encoding", "te", "trailer", "upgrade", "proxy-authorization",
              "proxy-authenticate", "content-length", "host"}


def reply_text(body, streamed):
    """The assistant text (and reasoning) from a JSON or SSE reply body."""
    content, reasoning = [], []
    try:
        if streamed:
            for line in body.decode("utf-8", "replace").splitlines():
                line = line.strip()
                if not line.startswith("data:") or line[5:].strip() == "[DONE]":
                    continue
                chunk = json.loads(line[5:].strip())
                for ch in chunk.get("choices") or []:
                    d = ch.get("delta") or {}
                    content.append(d.get("content") or "")
                    reasoning.append(d.get("reasoning_content") or "")
        else:
            data = json.loads(body)
            for ch in data.get("choices") or []:
                m = ch.get("message") or {}
                content.append(m.get("content") or "")
                reasoning.append(m.get("reasoning_content") or "")
    except (ValueError, AttributeError):
        return body[:2000].decode("utf-8", "replace"), ""
    return "".join(content), "".join(reasoning)


class Relay(BaseHTTPRequestHandler):
    protocol_version = "HTTP/1.1"

    def log_message(self, fmt, *args):  # keep the console quiet
        pass

    def _forward(self, method):
        up = self.server.upstream
        length = int(self.headers.get("Content-Length") or 0)
        body = self.rfile.read(length) if length else b""
        asked_max = None
        if self.path.endswith("/chat/completions") and body:
            body, asked_max = self._limit(body)
        t0 = time.perf_counter()
        conn = http.client.HTTPConnection(up.hostname, up.port, timeout=600)
        headers = {k: v for k, v in self.headers.items() if k.lower() not in HOP_BY_HOP}
        conn.request(method, self.path, body=body, headers=headers)
        resp = conn.getresponse()

        self.send_response(resp.status)
        for k, v in resp.getheaders():
            if k.lower() not in HOP_BY_HOP:
                self.send_header(k, v)
        self.send_header("Transfer-Encoding", "chunked")
        self.end_headers()
        captured = bytearray()
        client_gone = False
        while True:
            chunk = resp.read1(65536)
            if not chunk:
                break
            captured += chunk
            if not client_gone:
                try:
                    self.wfile.write(b"%x\r\n%s\r\n" % (len(chunk), chunk))
                    self.wfile.flush()
                except (ConnectionAbortedError, ConnectionResetError, BrokenPipeError):
                    client_gone = True  # SkyrimNet timed out and hung up; keep reading so the log is complete
        if not client_gone:
            try:
                self.wfile.write(b"0\r\n\r\n")
                self.wfile.flush()
            except (ConnectionAbortedError, ConnectionResetError, BrokenPipeError):
                client_gone = True
        conn.close()

        if self.path.endswith("/chat/completions"):
            try:
                req = json.loads(body)
            except ValueError:
                req = {"raw": body[:2000].decode("utf-8", "replace")}
            streamed = "text/event-stream" in (resp.getheader("Content-Type") or "")
            content, reasoning = reply_text(bytes(captured), streamed)
            rec = {"time": datetime.now().strftime("%Y-%m-%d %H:%M:%S.%f")[:-3], "status": resp.status,
                   "client_gave_up": client_gone, "asked_max_tokens": asked_max,
                   "seconds": round(time.perf_counter() - t0, 2), "request": req,
                   "reply": content, "reasoning": reasoning}
            with LOCK, open(self.server.log_path, "a", encoding="utf-8") as f:
                f.write(json.dumps(rec, ensure_ascii=False) + "\n")

    def _limit(self, body):
        """Cap max_tokens and add stop sequences. Nemotron Bolt sometimes ends its turn on a token llama-server
        does not treat as end-of-generation ('</s>', '<|tool_response>'), then generates unseen until max_tokens
        (one call ran to SkyrimNet's 4096). Returns the new body and the max_tokens SkyrimNet asked for."""
        try:
            req = json.loads(body)
        except ValueError:
            return body, None
        asked = req.get("max_tokens")
        if self.server.max_tokens:
            req["max_tokens"] = min(asked or self.server.max_tokens, self.server.max_tokens)
        stop = req.get("stop") or []
        stop = [stop] if isinstance(stop, str) else list(stop)
        req["stop"] = stop + [s for s in self.server.extra_stop if s not in stop]
        msgs = req.get("messages") or []
        if msgs:
            c = msgs[0].get("content")
            first = (c if isinstance(c, str) else "".join(p.get("text", "") for p in c or [] if isinstance(p, dict))).lstrip()
            if first.startswith(NO_THINK_PREFIXES):
                req.setdefault("chat_template_kwargs", {})["enable_thinking"] = False
        return json.dumps(req).encode(), asked

    def do_POST(self):
        self._forward("POST")

    def do_GET(self):
        self._forward("GET")


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--listen", type=int, default=8089)
    ap.add_argument("--upstream", default="http://127.0.0.1:8090")
    ap.add_argument("--log", default="calls-local.jsonl")
    ap.add_argument("--max-tokens", type=int, default=1024, help="cap on any request's max_tokens (0 = no cap)")
    ap.add_argument("--stop", action="append", default=None, help="extra stop sequence (repeatable)")
    a = ap.parse_args()
    server = ThreadingHTTPServer(("127.0.0.1", a.listen), Relay)
    server.upstream = urllib.parse.urlparse(a.upstream)
    server.log_path = a.log
    server.max_tokens = a.max_tokens
    server.extra_stop = a.stop if a.stop is not None else ["</s>", "<|tool_response>"]
    print(f"relay 127.0.0.1:{a.listen} -> {a.upstream}, logging to {a.log}", flush=True)
    server.serve_forever()


if __name__ == "__main__":
    main()
