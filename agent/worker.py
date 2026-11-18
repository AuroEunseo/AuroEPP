import json
import queue
import socket
import ctypes
import platform
import uuid
import winreg
import subprocess
import threading
import time
import urllib.error
import urllib.request

from config import load_server_url
from identity import wait_for_approval, get_os_info, get_or_create_identity
from wua_engine import (
    NOWIN,
    apply_registry_item,
    is_reboot_pending,
    scan_updates,
    enforce_updates,
)

AGENT_VER = "1.0.2"
CHECKIN_INTERVAL = 20
AUTO_SCAN_INTERVAL = 300


class AgentWorker:
    def __init__(self, stop_event: threading.Event):
        self.stop_event = stop_event
        self.server_url = load_server_url()
        self.job_queue: queue.Queue = queue.Queue()
        self.lock = threading.Lock()
        self.busy = threading.Event()
        self.global_rules: list[dict] = []
        self.pending_report: dict | None = None
        self.cmd_results: list[dict] = []

    def _bg_worker(self):
        while not self.stop_event.is_set():
            try:
                task = self.job_queue.get(timeout=1)
            except queue.Empty:
                continue

            self.busy.set()
            kind = task["kind"]
            extra_rules = task.get("rules", [])
            try:
                msgs = []
                # Merge global rules + one-time command rules
                merged_map = {r["kb"]: r["action"] for r in self.global_rules}
                for r in extra_rules:
                    merged_map[r["kb"]] = r["action"]
                merged_rules = [{"kb": k, "action": v} for k, v in merged_map.items()]

                if merged_rules or kind == "install_all":
                    msgs = enforce_updates(merged_rules, install_all=(kind == "install_all"))

                scan_data = scan_updates()
                done_kbs = [
                    h["kb"]
                    for h in scan_data.get("hist", [])
                    if h.get("op") == 1 and h.get("rc") in (2, 3) and h.get("kb")
                ]
                hotfix_str = ",".join(dict.fromkeys(done_kbs))[:100]

                with self.lock:
                    self.pending_report = {
                        "updates": scan_data.get("pend", []),
                        "history": scan_data.get("hist", []),
                        "hotfix": hotfix_str,
                    }
                    for m in msgs:
                        self.cmd_results.append({"type": "update", "ok": True, "out": m})
            except Exception as e:
                with self.lock:
                    self.cmd_results.append({"type": kind, "ok": False, "out": str(e)[:250]})
            finally:
                self.busy.clear()

    def get_hardware_specs(self) -> dict:
        # 1. MAC address (XX:XX:XX:XX:XX:XX)
        mac_num = uuid.getnode()
        mac_addr = ":".join(f"{(mac_num >> ele) & 0xff:02X}" for ele in range(40, -1, -8))

        # 2. CPU model name
        cpu_info = platform.processor() or "Unknown CPU"
        try:
            with winreg.OpenKey(
                winreg.HKEY_LOCAL_MACHINE,
                r"HARDWARE\DESCRIPTION\System\CentralProcessor\0",
            ) as key:
                val, _ = winreg.QueryValueEx(key, "ProcessorNameString")
                if val:
                    cpu_info = str(val).strip()
        except Exception:
            pass

        # 3. Total RAM (GB)
        ram_gb = "-"
        try:
            class MEMORYSTATUSEX(ctypes.Structure):
                _fields_ = [
                    ("dwLength", ctypes.c_ulong),
                    ("dwMemoryLoad", ctypes.c_ulong),
                    ("ullTotalPhys", ctypes.c_ulonglong),
                    ("ullAvailPhys", ctypes.c_ulonglong),
                    ("ullTotalPageFile", ctypes.c_ulonglong),
                    ("ullAvailPageFile", ctypes.c_ulonglong),
                    ("ullTotalVirtual", ctypes.c_ulonglong),
                    ("ullAvailVirtual", ctypes.c_ulonglong),
                    ("sullAvailExtendedVirtual", ctypes.c_ulonglong),
                ]

            stat = MEMORYSTATUSEX()
            stat.dwLength = ctypes.sizeof(MEMORYSTATUSEX)
            ctypes.windll.kernel32.GlobalMemoryStatusEx(ctypes.byref(stat))
            gb = round(stat.ullTotalPhys / (1024 ** 3))
            ram_gb = f"{gb} GB"
        except Exception:
            pass

        return {"mac_addr": mac_addr, "cpu_info": cpu_info, "ram_gb": ram_gb}

    def _enqueue_job(self, kind: str, rules: list[dict] = None):
        if kind != "sync" or (not self.busy.is_set() and self.job_queue.empty()):
            self.job_queue.put({"kind": kind, "rules": rules or []})

    def run(self):
        threading.Thread(target=self._bg_worker, daemon=True).start()
        hw_specs = self.get_hardware_specs()

        while not self.stop_event.is_set():
            # Step 1: Wait for admin approval in console
            ident = wait_for_approval(self.server_url, AGENT_VER, self.stop_event)

            applied_hash = ""
            seen_rules_hash = None
            last_scan_ts = 0.0
            hotfix = ""

            # Step 2: Check-in loop after approval
            while not self.stop_event.is_set():
                report_payload = None
                results_payload = []

                with self.lock:
                    if self.pending_report:
                        report_payload = self.pending_report
                        self.pending_report = None
                    if self.cmd_results:
                        results_payload = list(self.cmd_results)
                        self.cmd_results.clear()

                if report_payload:
                    hotfix = report_payload["hotfix"]

                os_name, os_build = get_os_info()
                body = {
                    "hostname": socket.gethostname(),
                    "os_name": os_name,
                    "os_build": os_build,
                    "mac_addr": hw_specs["mac_addr"],
                    "cpu_info": hw_specs["cpu_info"],
                    "ram_gb": hw_specs["ram_gb"],
                    "applied_hash": applied_hash,
                    "reboot_required": is_reboot_pending(),
                    "hotfix": hotfix,
                    "agent_ver": AGENT_VER,
                    "results": results_payload,
                }
                if report_payload:
                    body["updates"] = report_payload["updates"]
                    body["history"] = report_payload["history"]

                try:
                    req = urllib.request.Request(
                        f"{self.server_url}/api/agents/checkin",
                        data=json.dumps(body, ensure_ascii=False).encode("utf-8"),
                        headers={
                            "Content-Type": "application/json",
                            "X-Machine-ID": ident["machine_id"],
                            "X-Agent-Token": ident["agent_token"],
                        },
                    )
                    with urllib.request.urlopen(req, timeout=15) as resp:
                        res = json.loads(resp.read().decode("utf-8"))

                    self.global_rules = res.get("rules", [])

                    # Process server commands
                    for cmd in res.get("commands", []):
                        ctype = cmd.get("type")
                        cpayload = cmd.get("payload", {})
                        kb = cpayload.get("kb", "")

                        elif ctype == "reboot":
                        subprocess.run(
                            ["shutdown", "/r", "/t", "30", "/c", "AURORA: Rebooting in 30 seconds by admin request."],
                            creationflags=NOWIN,
                        )
                        with self.lock:
                            self.cmd_results.append({"type": "reboot", "ok": True, "out": "Reboot scheduled in 30s"})
                        elif ctype == "shutdown":
                        subprocess.run(
                        ["shutdown", "/s", "/t", "30", "/c", "AURORA: Shutting down in 30 seconds by admin request."],
                        creationflags=NOWIN,
                    )
                    with self.lock:
                        self.cmd_results.append({"type": "shutdown", "ok": True, "out": "Shutdown scheduled in 30s"})
                        if ctype == "scan":
                            self._enqueue_job("sync")
                        elif ctype == "install_all":
                            self._enqueue_job("install_all")
                        elif ctype == "install_kb" and kb:
                            self._enqueue_job("single_kb", [{"kb": kb, "action": "install"}])
                        elif ctype == "hide_kb" and kb:
                            self._enqueue_job("single_kb", [{"kb": kb, "action": "block"}])
                        elif ctype == "unhide_kb" and kb:
                            self._enqueue_job("single_kb", [{"kb": kb, "action": "allow"}])
                        elif ctype == "reboot":
                            subprocess.run(
                                ["shutdown", "/r", "/t", "30", "/c", "AURORA: Rebooting in 30 seconds by admin request."],
                                creationflags=NOWIN,
                            )
                            with self.lock:
                                self.cmd_results.append({"type": "reboot", "ok": True, "out": "Reboot scheduled in 30s"})

                    # Sync update list on rule change or periodic interval
                    if res.get("rules_hash") != seen_rules_hash or (time.time() - last_scan_ts > AUTO_SCAN_INTERVAL):
                        self._enqueue_job("sync")
                        seen_rules_hash = res.get("rules_hash")
                        last_scan_ts = time.time()

                    # Apply registry policy
                    pol = res.get("policy", {})
                    if pol.get("hash") and pol["hash"] != applied_hash:
                        errs = [e for e in map(apply_registry_item, pol.get("items", [])) if e]
                        with self.lock:
                            self.cmd_results.append({
                                "type": "policy",
                                "ok": not errs,
                                "out": f"{pol['hash']} " + ("; ".join(errs) if errs else f"{len(pol['items'])} items applied"),
                            })
                        if not errs:
                            applied_hash = pol["hash"]
                            continue

                except urllib.error.HTTPError as e:
                    if e.code in (401, 403, 404):
                        get_or_create_identity(force_new_token=True)
                        break
                except Exception:
                    pass

                self.stop_event.wait(CHECKIN_INTERVAL)