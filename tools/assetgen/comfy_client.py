"""
Minimal ComfyUI API client for batch asset generation.

Submits a prompt graph, waits for it to finish, and reports the files it wrote.
Deliberately synchronous and one-job-at-a-time: the GPU is the bottleneck, so
queueing ahead buys nothing and makes failures much harder to attribute.
"""

import json
import time
import urllib.error
import urllib.request
import uuid

HOST = "http://127.0.0.1:8188"
CLIENT_ID = str(uuid.uuid4())


def _post(path, payload):
    data = json.dumps(payload).encode("utf-8")
    req = urllib.request.Request(
        HOST + path, data=data, headers={"Content-Type": "application/json"}
    )
    try:
        with urllib.request.urlopen(req, timeout=120) as r:
            return json.loads(r.read())
    except urllib.error.HTTPError as e:
        # A rejected graph returns its reason in the body. Without reading it
        # every mistake looks identical and debugging is guesswork.
        body = e.read().decode("utf-8", "replace")
        raise RuntimeError("HTTP %s from %s: %s" % (e.code, path, body[:1500])) from None


def _get(path, timeout=120):
    with urllib.request.urlopen(HOST + path, timeout=timeout) as r:
        return json.loads(r.read())


def server_alive(timeout=10):
    try:
        urllib.request.urlopen(HOST + "/system_stats", timeout=timeout).read()
        return True
    except Exception:
        return False


def wait_for_server(max_wait=300):
    """ComfyUI is restarted between phases; this blocks until it answers again."""
    deadline = time.time() + max_wait
    while time.time() < deadline:
        if server_alive(5):
            return True
        time.sleep(5)
    return False


def submit(graph):
    return _post("/prompt", {"prompt": graph, "client_id": CLIENT_ID})["prompt_id"]


def run(graph, timeout=900, poll=1.5):
    """
    Runs one graph to completion.

    Returns (files, seconds). `files` is the flat list of output entries
    ComfyUI recorded, whatever node produced them.

    Raises on execution error so a caller can log and move to the next item
    rather than silently writing nothing.
    """
    started = time.time()
    pid = submit(graph)

    while True:
        if time.time() - started > timeout:
            raise TimeoutError("prompt %s exceeded %ss" % (pid, timeout))
        try:
            hist = _get("/history/" + pid, timeout=30)
        except (urllib.error.URLError, TimeoutError, OSError) as e:
            # The server can drop mid-run under memory pressure. Surface it as
            # a normal failure so the batch driver can restart and continue.
            raise RuntimeError("lost the server while waiting: %s" % e)

        entry = hist.get(pid)
        if entry:
            status = entry.get("status", {})
            if status.get("status_str") == "error" or status.get("completed") is False:
                msgs = status.get("messages", [])
                raise RuntimeError("execution error: %s" % json.dumps(msgs)[:600])
            return entry.get("outputs", {}), time.time() - started
        time.sleep(poll)


FILE_KEYS = ("images", "gltf", "3d", "files", "meshes", "result")


def files_of(node_output):
    """Flattens one node's output entry into a list of {filename, subfolder}."""
    out = []
    for key in FILE_KEYS:
        for f in node_output.get(key, []) or []:
            if isinstance(f, dict):
                out.append(f)
            elif isinstance(f, str):
                out.append({"filename": f})
    return out


def all_files(outputs):
    """Every file the whole graph wrote, in no particular order."""
    out = []
    for node_output in outputs.values():
        out.extend(files_of(node_output))
    return out
