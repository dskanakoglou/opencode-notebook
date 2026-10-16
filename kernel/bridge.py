"""Keeps one Jupyter kernel alive and runs cells for the plugin.

Started by the plugin as `uv run --with jupyter_client --with ipykernel ... python -I bridge.py <cwd>`.
Talks JSON lines: requests on stdin, replies and outputs on stdout.

  in   {"op": "exec", "id": 3, "code": "..."}   run one cell
       {"op": "interrupt"}                      stop the running cell
       {"op": "shutdown"}                       stop the kernel and exit
  out  {"type": "ready", "python": "..."}
       {"type": "output", "id": 3, "output": {...}}   one nbformat output
       {"type": "done", "id": 3, "status": "ok" | "error", "count": 7}
       {"type": "fatal", "message": "..."}
"""

import json
import os
import shutil
import sys
import tempfile
import threading
from queue import Queue

from jupyter_client.manager import KernelManager

lock = threading.Lock()


def send(message):
    with lock:
        sys.stdout.write(json.dumps(message) + "\n")
        sys.stdout.flush()


def to_output(msg):
    """An iopub message as an nbformat v4 output, or None."""
    kind, content = msg["msg_type"], msg["content"]
    if kind == "stream":
        return {"output_type": "stream", "name": content["name"], "text": content["text"]}
    if kind in ("display_data", "execute_result"):
        out = {"output_type": kind, "data": content["data"], "metadata": content.get("metadata", {})}
        if kind == "execute_result":
            out["execution_count"] = content["execution_count"]
        return out
    if kind == "error":
        return {"output_type": "error", "ename": content["ename"], "evalue": content["evalue"], "traceback": content["traceback"]}
    return None


def worker(kc, jobs):
    while True:
        job = jobs.get()
        if job is None:
            return
        try:
            reply = kc.execute_interactive(
                job["code"],
                timeout=None,
                allow_stdin=False,
                output_hook=lambda msg, id=job["id"]: (o := to_output(msg)) and send({"type": "output", "id": id, "output": o}),
            )
            content = reply["content"]
            send({"type": "done", "id": job["id"], "status": content["status"], "count": content.get("execution_count")})
        except Exception as error:  # the kernel died or the channel broke
            send({"type": "done", "id": job["id"], "status": "error", "count": None, "message": str(error)})


def main():
    cwd = sys.argv[1] if len(sys.argv) > 1 else os.getcwd()
    km = KernelManager(kernel_name="python3")
    sockets = None
    if os.name != "nt":
        # Unix sockets in a private folder, not unencrypted TCP that other users could reach
        sockets = tempfile.mkdtemp(prefix="opencode-notebook-")
        km.transport = "ipc"
        km.ip = os.path.join(sockets, "kernel")
    try:
        km.start_kernel(cwd=cwd)
        kc = km.client()
        kc.start_channels()
        kc.wait_for_ready(timeout=60)
    except Exception as error:
        send({"type": "fatal", "message": f"could not start the kernel: {error}"})
        return
    jobs = Queue()
    thread = threading.Thread(target=worker, args=(kc, jobs), daemon=True)
    thread.start()
    send({"type": "ready", "python": sys.version.split()[0]})
    try:
        for line in sys.stdin:
            request = json.loads(line)
            if request["op"] == "exec":
                jobs.put(request)
            elif request["op"] == "interrupt":
                km.interrupt_kernel()
            elif request["op"] == "shutdown":
                break
    finally:
        jobs.put(None)
        thread.join()  # let a running cell finish; send an interrupt first to stop it
        kc.stop_channels()
        km.shutdown_kernel(now=True)
        if sockets:
            shutil.rmtree(sockets, ignore_errors=True)


if __name__ == "__main__":
    main()
