import json
import queue
import socket
import ctypes
import sys
import platform
import uuid
import winreg
import subprocess
import threading
import time
import urllib.error
import urllib.request

import os

from agent_log import get_logger
from config import DATA_DIR, load_server_url
from identity import wait_for_approval, get_os_info, get_or_create_identity
from task_status import TaskBoard
import pkg_engine
from wua_engine import (
    NOWIN,
    apply_registry_item,
    is_reboot_pending,
    restore_registry_value,
    scan_updates,
    enforce_updates,
)

AGENT_VER = "1.0.3"  # electron-agent/package.json 의 version 과 맞춰 관리
CHECKIN_INTERVAL = 20
# Windows Update 검색은 무거운 작업(CPU·네트워크)이라 주기적으로 하지 않는다.
# 검색 시점: ① 콘솔이 요청할 때(콘솔 첫 접속 시 자동 1회, [업데이트 다시 검색] 버튼, PC별 [즉시 스캔])
#           ② 관리자가 KB 규칙을 바꿨을 때(숨김/허용 적용 후 결과 확인) ③ 설치 명령 실행 후

REPORT_HISTORY_MAX = 30       # 정기 보고 시 전송하는 설치/제거 이력 건수
FULL_HISTORY_MAX = 100        # 상세 모달 요청 시 전송하는 전체 이력 최대 건수
REG_HISTORY_FILE = os.path.join(DATA_DIR, "registry_history.json")
REG_HISTORY_KEEP = 200

# 트레이 '진행 중인 작업'에 보여줄 Windows 업데이트 작업 이름 (이력 조회는 표시하지 않음)
WU_TASK_TITLE = {
    "scan": "Windows 업데이트 검색",
    "rules": "업데이트 규칙 적용",
    "install_all": "Windows 업데이트 설치",
    "single_kb": "업데이트 개별 작업",
}

log = get_logger()


def get_boot_ts() -> float | None:
    """PC 마지막 부팅 시각(epoch). 서버가 '부팅 후 재연결'과 대기 중 재부팅 명령 생략 여부를 판단하는 데 사용"""
    try:
        if sys.platform == "win32":
            ms = ctypes.windll.kernel32.GetTickCount64
            ms.restype = ctypes.c_ulonglong
            return round(time.time() - ms() / 1000.0, -1)  # 10초 단위로 맞춰 매 보고마다 흔들리지 않게
        with open("/proc/uptime") as f:
            return round(time.time() - float(f.read().split()[0]), -1)
    except Exception:
        return None


def _install_uninstall_only(hist: list[dict], limit: int) -> list[dict]:
    """Windows Update 이력 중 설치(op=1)/제거(op=2)만 최신순으로 limit 건"""
    rows = [h for h in hist if h.get("op") in (1, 2)]
    rows.sort(key=lambda h: h.get("date") or "", reverse=True)
    return rows[:limit]


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
        # SSE 푸시 수신 시 체크인 대기를 즉시 깨우기 위한 이벤트
        self.wake_event = threading.Event()
        self.approved = False
        self.service_started_at = time.time()
        self.first_checkin = True
        # 서버 전송 대기 중인 레지스트리 변경 기록 (전송 성공 시에만 비움)
        self.pending_reg_changes: list[dict] = self._load_unsent_reg_changes()
        # 프로그램 배포: 설치 작업 전용 큐(Windows 업데이트 작업과 별도로 한 번에 하나씩 실행)
        self.tasks = TaskBoard()
        self.pkg_queue: queue.Queue = queue.Queue()
        self.ident: dict | None = None
        self.software_dirty = True  # 설치 프로그램 목록을 다음 체크인 때 보고할지
        self.pending_progress: list[dict] = []  # 전송 실패한 배포 결과 (다음 체크인 전에 재전송)

    # ------------------------------------------------------------------
    # 레지스트리 변경 이력 (로컬 보관 + 서버 보고)
    # ------------------------------------------------------------------
    def _load_unsent_reg_changes(self) -> list[dict]:
        try:
            with open(REG_HISTORY_FILE, "r", encoding="utf-8") as f:
                return [c for c in json.load(f) if not c.get("sent")]
        except (OSError, ValueError):
            return []

    def _record_reg_changes(self, changes: list[dict]):
        if not changes:
            return
        with self.lock:
            self.pending_reg_changes.extend(changes)
        try:
            os.makedirs(DATA_DIR, exist_ok=True)
            try:
                with open(REG_HISTORY_FILE, "r", encoding="utf-8") as f:
                    hist = json.load(f)
            except (OSError, ValueError):
                hist = []
            hist.extend(changes)
            with open(REG_HISTORY_FILE, "w", encoding="utf-8") as f:
                json.dump(hist[-REG_HISTORY_KEEP:], f, ensure_ascii=False, indent=1)
        except OSError:
            pass

    def _mark_reg_changes_sent(self, cids: set[str]):
        if not cids:
            return
        try:
            with open(REG_HISTORY_FILE, "r", encoding="utf-8") as f:
                hist = json.load(f)
            for c in hist:
                if c.get("cid") in cids:
                    c["sent"] = True
            with open(REG_HISTORY_FILE, "w", encoding="utf-8") as f:
                json.dump(hist[-REG_HISTORY_KEEP:], f, ensure_ascii=False, indent=1)
        except (OSError, ValueError):
            pass

    def _bg_worker(self):
        while not self.stop_event.is_set():
            try:
                task = self.job_queue.get(timeout=1)
            except queue.Empty:
                continue

            self.busy.set()
            kind = task["kind"]
            extra_rules = task.get("rules", [])
            title = WU_TASK_TITLE.get(kind)
            tid = self.tasks.start("update", title) if title else None
            if tid:
                self.tasks.update(tid, status="진행 중")
            ok, detail = True, ""
            try:
                msgs = []
                # Merge global rules + one-time command rules
                merged_map = {r["kb"]: r["action"] for r in self.global_rules}
                for r in extra_rules:
                    merged_map[r["kb"]] = r["action"]
                merged_rules = [{"kb": k, "action": v} for k, v in merged_map.items()]

                # 규칙 적용(숨김/해제/설치)은 '규칙 변경'·'설치 명령'일 때만. 단순 검색(scan)·이력 요청은 검색만 수행
                if kind in ("rules", "install_all", "single_kb") and (merged_rules or kind == "install_all"):
                    msgs = enforce_updates(merged_rules, install_all=(kind == "install_all"))

                scan_data = scan_updates()
                all_hist = scan_data.get("hist", [])
                done_kbs = [
                    h["kb"]
                    for h in all_hist
                    if h.get("op") == 1 and h.get("rc") in (2, 3) and h.get("kb")
                ]
                hotfix_str = ",".join(dict.fromkeys(done_kbs))

                report = {
                    "updates": scan_data.get("pend", []),
                    "history": _install_uninstall_only(all_hist, REPORT_HISTORY_MAX),
                    "hotfix": hotfix_str,
                }
                if kind == "history_full":
                    report["history_full"] = _install_uninstall_only(all_hist, FULL_HISTORY_MAX)

                with self.lock:
                    # 아직 전송되지 않은 전체 이력 요청 결과는 덮어쓰지 않고 유지
                    if self.pending_report and "history_full" in self.pending_report and "history_full" not in report:
                        report["history_full"] = self.pending_report["history_full"]
                    self.pending_report = report
                    for m in msgs:
                        self.cmd_results.append({"type": "update", "ok": True, "out": m})
                detail = f"대기 중인 업데이트 {len(report['updates'])}건"
                if kind == "scan":
                    self.software_dirty = True  # 검색 요청 시 설치 프로그램 목록도 함께 갱신
            except Exception as e:
                ok, detail = False, str(e)[:200]
                with self.lock:
                    self.cmd_results.append({"type": kind, "ok": False, "out": str(e)[:250]})
            finally:
                if tid:
                    self.tasks.finish(tid, ok, detail)
                self.busy.clear()
                # 스캔/설치 결과를 다음 주기까지 기다리지 않고 즉시 보고
                self.wake_event.set()

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
        # 단순 검색은 이미 작업 중이거나 대기 중이면 생략 (작업 끝에 어차피 검색 결과를 보고함)
        if kind != "scan" or (not self.busy.is_set() and self.job_queue.empty()):
            self.job_queue.put({"kind": kind, "rules": rules or []})

    # ------------------------------------------------------------------
    # 실시간 푸시(SSE) 연동
    # ------------------------------------------------------------------
    def sync_once(self):
        """SSE 푸시 수신 시 호출: 메인 루프의 대기를 깨워 즉시 체크인하도록 요청.

        체크인 자체는 항상 메인 루프 스레드에서만 수행되므로 applied_hash 등
        상태값을 두 스레드가 동시에 건드리는 경쟁 조건이 생기지 않는다.
        """
        self.wake_event.set()

    def _wait(self, timeout: float):
        """timeout 동안 대기하되 서비스 중지 또는 즉시 동기화 요청 시 바로 깨어남"""
        deadline = time.time() + timeout
        while not self.stop_event.is_set():
            remaining = deadline - time.time()
            if remaining <= 0:
                break
            if self.wake_event.wait(min(1.0, remaining)):
                break
        self.wake_event.clear()

    # ------------------------------------------------------------------
    # 프로그램 배포 (서명 검증 → 다운로드 → 해시 확인 → 무인 설치/삭제)
    # ------------------------------------------------------------------
    def _report_progress(self, did: int, status: str, progress: int = 0, message: str = "", exit_code=None):
        item = {"deployment_id": did, "status": status, "progress": progress, "message": message[:500],
                "exit_code": exit_code}
        if not self._post_progress(item) and status in ("success", "failed"):
            with self.lock:
                self.pending_progress.append(item)  # 최종 결과는 반드시 전달되도록 보관 후 재전송

    def _post_progress(self, item: dict) -> bool:
        ident = self.ident
        if not ident:
            return False
        try:
            req = urllib.request.Request(
                f"{self.server_url}/api/agent/progress",
                data=json.dumps(item, ensure_ascii=False).encode("utf-8"),
                headers={"Content-Type": "application/json", "X-Machine-ID": ident["machine_id"],
                         "X-Agent-Token": ident["agent_token"]},
            )
            with urllib.request.urlopen(req, timeout=10) as resp:
                resp.read()
            return True
        except Exception:
            return False

    def _flush_progress(self):
        with self.lock:
            items, self.pending_progress = self.pending_progress, []
        for it in items:
            if not self._post_progress(it):
                with self.lock:
                    self.pending_progress.append(it)

    def _pkg_worker(self):
        while not self.stop_event.is_set():
            try:
                body = self.pkg_queue.get(timeout=1)
            except queue.Empty:
                continue
            self._run_pkg_job(body)

    def _run_pkg_job(self, body: dict):
        did = body["deployment_id"]
        action = body["action"]
        verb = "설치" if action == "install" else "삭제"
        title = f"{body['name']} {body.get('version', '')} {verb}".replace("  ", " ")
        tid = self.tasks.start("package", title, ref=did)
        log.info("프로그램 %s 시작: %s (배포 #%s)", verb, title, did)
        try:
            if action == "install":
                self.tasks.update(tid, status="다운로드 중", progress=0)
                self._report_progress(did, "downloading", 0, "다운로드 시작")

                def on_dl(pct, text):
                    self.tasks.update(tid, progress=pct, detail=text)
                    if pct % 10 == 0 or pct == 100:
                        self._post_progress({"deployment_id": did, "status": "downloading", "progress": pct,
                                             "message": text, "exit_code": None})

                path = pkg_engine.download(self.server_url, self.ident, body, on_dl)
                self.tasks.update(tid, status="설치 중", progress=None, detail="무인 설치 실행 중")
                self._report_progress(did, "installing", 100, "무인 설치 실행 중")
                code, note = pkg_engine.install(path, body)
            else:
                self.tasks.update(tid, status="삭제 중", detail="무인 삭제 실행 중")
                self._report_progress(did, "uninstalling", 0, "무인 삭제 실행 중")
                code, note = pkg_engine.uninstall(body)

            # 설치 여부 확인: '프로그램 추가/제거' 목록에서 다시 찾아본다
            found = pkg_engine.find_installed(body.get("detect_name") or body["name"])
            if action == "install":
                check = f"설치 확인됨 ({found['name']} {found['version']})" if found else \
                    "설치 프로그램은 정상 종료했지만 '프로그램 추가/제거' 목록에서 찾지 못함 (확인용 이름 점검 필요)"
            else:
                check = "삭제 확인됨" if not found else f"삭제 후에도 목록에 남아 있음 ({found['name']})"
            msg = " · ".join(x for x in (note, check) if x)
            self._report_progress(did, "success", 100, msg, code)
            self.tasks.finish(tid, True, msg)
            log.info("프로그램 %s 완료: %s (종료 코드 %s) %s", verb, title, code, msg)
        except pkg_engine.PackageError as e:
            self._report_progress(did, "failed", 0, str(e), e.exit_code)
            self.tasks.finish(tid, False, str(e))
            log.warning("프로그램 %s 실패: %s — %s", verb, title, e)
        except Exception as e:
            self._report_progress(did, "failed", 0, f"에이전트 오류: {e}")
            self.tasks.finish(tid, False, str(e)[:200])
            log.exception("프로그램 작업 오류")
        finally:
            self.software_dirty = True
            self.wake_event.set()

    def _accept_pkg_command(self, ctype: str, cpayload: dict):
        """서명을 검증한 명령만 설치 큐에 넣는다. 검증 실패 시 실행하지 않고 실패로 보고"""
        did = cpayload.get("deployment_id")
        try:
            body = pkg_engine.verify_command(cpayload, (self.ident or {}).get("machine_id", ""))
            if f"pkg_{body['action']}" != ctype or body["deployment_id"] != did:
                raise pkg_engine.PackageError("명령 종류와 서명된 내용이 일치하지 않음")
        except pkg_engine.PackageError as e:
            log.warning("프로그램 배포 명령 거부: %s", e)
            if did:
                self._report_progress(did, "failed", 0, str(e))
            with self.lock:
                self.cmd_results.append({"type": ctype, "ok": False, "out": str(e)[:250]})
            return
        self.pkg_queue.put(body)

    def _restore_unsent(self, report_payload, results_payload):
        """체크인 실패 시 보고 내용/명령 결과를 다음 체크인에서 다시 보내도록 되돌림"""
        with self.lock:
            if report_payload and not self.pending_report:
                self.pending_report = report_payload
            if results_payload:
                self.cmd_results[:0] = results_payload[-50:]

    def _run_command(self, cmd: dict):
        ctype = cmd.get("type")
        cpayload = cmd.get("payload") or {}
        log.info("명령 수신: %s %s", ctype, cpayload.get("kb", "") if isinstance(cpayload, dict) else "")
        kb = cpayload.get("kb", "")

        if ctype == "scan":
            self._enqueue_job("scan")
        elif ctype == "install_all":
            self._enqueue_job("install_all")
        elif ctype == "install_kb" and kb:
            self._enqueue_job("single_kb", [{"kb": kb, "action": "install"}])
        elif ctype == "hide_kb" and kb:
            self._enqueue_job("single_kb", [{"kb": kb, "action": "block"}])
        elif ctype == "unhide_kb" and kb:
            self._enqueue_job("single_kb", [{"kb": kb, "action": "allow"}])
        elif ctype in ("pkg_install", "pkg_uninstall"):
            self._accept_pkg_command(ctype, cpayload)
        elif ctype == "report_history":
            self._enqueue_job("history_full")
        elif ctype == "reg_rollback":
            err, change = restore_registry_value(
                cpayload.get("path", ""),
                cpayload.get("name", ""),
                bool(cpayload.get("restore_exists")),
                cpayload.get("restore_type"),
                cpayload.get("restore_value"),
            )
            if change:
                self._record_reg_changes([change])
            target = f"{cpayload.get('path', '')}\\{cpayload.get('name', '')}"
            with self.lock:
                self.cmd_results.append({
                    "type": "reg_rollback",
                    "ok": not err,
                    "ref": cpayload.get("ref"),
                    "out": err or f"{target} 변경 전 값으로 복원 완료",
                })
        elif ctype in ("reboot", "shutdown"):
            flag, verb, label = (
                ("/r", "Rebooting", "Reboot") if ctype == "reboot" else ("/s", "Shutting down", "Shutdown")
            )
            try:
                subprocess.run(
                    ["shutdown", flag, "/t", "30", "/c", f"AURORA: {verb} in 30 seconds by admin request."],
                    creationflags=NOWIN,
                    check=True,
                )
                result = {"type": ctype, "ok": True, "out": f"{label} scheduled in 30s"}
            except Exception as e:
                result = {"type": ctype, "ok": False, "out": str(e)[:250]}
            with self.lock:
                self.cmd_results.append(result)
        else:
            with self.lock:
                self.cmd_results.append({"type": str(ctype), "ok": False, "out": "Unsupported command"})

    def run(self):
        threading.Thread(target=self._bg_worker, daemon=True).start()
        threading.Thread(target=self._pkg_worker, daemon=True).start()
        hw_specs = self.get_hardware_specs()
        log.info("에이전트 시작 (버전 %s, 서버 %s, 부팅 시각 %s)", AGENT_VER, load_server_url(),
                 time.strftime("%Y-%m-%d %H:%M:%S", time.localtime(get_boot_ts() or 0)))

        while not self.stop_event.is_set():
            # Step 1: Wait for admin approval in console
            self.approved = False
            ident = wait_for_approval(load_server_url, AGENT_VER, self.stop_event, wait_fn=self._wait)
            self.approved = True
            self.ident = ident
            log.info("승인 확인 → 체크인 시작")
            fail_count = 0

            applied_hash = ""
            seen_rules_hash = None  # 첫 체크인 응답 값으로 초기화만 하고 검색하지 않음
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

                    reg_payload = list(self.pending_reg_changes)

                self._flush_progress()
                software_payload = None
                if self.software_dirty:
                    try:
                        software_payload = pkg_engine.public_software(pkg_engine.collect_software())
                    except Exception as e:
                        log.warning("설치 프로그램 목록 수집 실패: %s", e)

                if report_payload:
                    hotfix = report_payload["hotfix"]

                # 서버 주소는 매 체크인마다 agent_config.json(단일 설정 지점)에서 다시 읽는다
                self.server_url = load_server_url()
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
                    "boot_ts": get_boot_ts(),
                    "service_started_at": self.service_started_at,
                    "first_checkin": self.first_checkin,
                }
                if report_payload:
                    body["updates"] = report_payload["updates"]
                    body["history"] = report_payload["history"]
                    if "history_full" in report_payload:
                        body["history_full"] = report_payload["history_full"]
                if reg_payload:
                    body["reg_changes"] = reg_payload
                if software_payload is not None:
                    body["software"] = software_payload

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
                    if self.first_checkin or fail_count:
                        log.info("체크인 성공%s (대기 명령 %d건 수신)",
                                 f" (실패 {fail_count}회 후 복구)" if fail_count else " (서비스 시작 후 첫 연결)",
                                 len(res.get("commands", [])))
                    self.first_checkin = False
                    fail_count = 0

                    self.global_rules = res.get("rules", [])
                    if software_payload is not None:
                        self.software_dirty = False
                    # 서버 서명 공개키 고정 (명령 처리 전에 먼저)
                    pkg_engine.pin_pubkey(res.get("signing_pubkey", ""))

                    # 전송 성공한 레지스트리 변경 기록은 대기 목록에서 제거
                    if reg_payload:
                        sent = {c["cid"] for c in reg_payload}
                        with self.lock:
                            self.pending_reg_changes = [
                                c for c in self.pending_reg_changes if c["cid"] not in sent
                            ]
                        self._mark_reg_changes_sent(sent)

                    # Process server commands
                    for cmd in res.get("commands", []):
                        self._run_command(cmd)
                    # 즉시 실행된 명령(롤백·재부팅 등)의 결과를 다음 주기까지 기다리지 않고 바로 보고
                    if res.get("commands"):
                        self.wake_event.set()

                    # Sync update list on rule change or periodic interval
                    # KB 규칙이 바뀐 경우에만 규칙 적용 + 검색 (서비스 시작 직후 첫 응답은 기준값만 기록)
                    if seen_rules_hash is None:
                        seen_rules_hash = res.get("rules_hash")
                    elif res.get("rules_hash") != seen_rules_hash:
                        seen_rules_hash = res.get("rules_hash")
                        self._enqueue_job("rules")

                    # Apply registry policy
                    pol = res.get("policy", {})
                    if pol.get("hash") and pol["hash"] != applied_hash:
                        errs, changes = [], []
                        for item in pol.get("items", []):
                            err, change = apply_registry_item(item, pol["hash"])
                            if err:
                                errs.append(err)
                            if change:
                                changes.append(change)
                        self._record_reg_changes(changes)
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
                    self._restore_unsent(report_payload, results_payload)
                    # 토큰을 새로 만드는 것은 서버가 '토큰 불일치(401)'를 알린 경우뿐.
                    # 404(서버 기록 없음)·403(승인 대기/거부)은 기존 토큰으로 재등록 → 토큰을 잃고 재승인이 필요해지는 일을 방지
                    if e.code == 401:
                        log.warning("체크인 401: 토큰 불일치(폐기됨) → 새 토큰으로 재등록")
                        get_or_create_identity(force_new_token=True)
                        break
                    if e.code in (403, 404):
                        log.warning("체크인 %s: %s → 기존 토큰으로 재등록 대기", e.code,
                                    "승인 대기/거부 상태" if e.code == 403 else "서버에 PC 기록 없음")
                        break
                    fail_count += 1
                    log.warning("체크인 실패: HTTP %s (%d회째)", e.code, fail_count)
                except Exception as e:
                    self._restore_unsent(report_payload, results_payload)
                    fail_count += 1
                    if fail_count in (1, 3) or fail_count % 30 == 0:
                        log.warning("체크인 실패: %s (%d회째)", e, fail_count)

                # 연결 실패 시에는 짧게(3→6→12초) 재시도해 부팅·네트워크 복구 직후 빠르게 재연결
                self._wait(min(3 * (2 ** (fail_count - 1)), CHECKIN_INTERVAL) if fail_count else CHECKIN_INTERVAL)
