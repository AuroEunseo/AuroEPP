"""에이전트 작업 현황판 → C:\\ProgramData\\AURORA\\tasks.json

트레이 앱이 이 파일을 2초마다 읽어 트레이 메뉴의 '진행 중인 작업'과 설정 창의 작업 현황에 보여준다.
(서비스는 SYSTEM 권한, 트레이는 사용자 세션이라 파일로 상태를 주고받는다)
"""
import json
import os
import threading
import time

from config import DATA_DIR

TASKS_FILE = os.path.join(DATA_DIR, "tasks.json")
KEEP_FINISHED = 15


class TaskBoard:
    def __init__(self):
        self._lock = threading.Lock()
        self._tasks: list[dict] = []
        self._seq = 0
        self._last_write = 0.0
        self._write(force=True)

    def start(self, kind: str, title: str, detail: str = "", ref=None) -> int:
        with self._lock:
            self._seq += 1
            tid = int(time.time() * 1000) * 100 + self._seq % 100
            self._tasks.append({
                "id": tid, "kind": kind, "title": title, "status": "대기", "progress": None,
                "detail": detail, "ref": ref, "started": time.time(), "finished": None, "ok": None,
            })
        self._write(force=True)
        return tid

    def update(self, tid: int, status: str | None = None, progress: int | None = None, detail: str | None = None):
        with self._lock:
            t = self._find(tid)
            if not t:
                return
            if status is not None:
                t["status"] = status
            if progress is not None:
                t["progress"] = progress
            if detail is not None:
                t["detail"] = detail
        self._write(force=status is not None)

    def finish(self, tid: int, ok: bool, detail: str = ""):
        with self._lock:
            t = self._find(tid)
            if not t:
                return
            t.update(status="완료" if ok else "실패", ok=ok, finished=time.time(), detail=detail or t["detail"])
            t["progress"] = 100 if ok else t["progress"]
            active = [x for x in self._tasks if x["finished"] is None]
            done = [x for x in self._tasks if x["finished"] is not None][-KEEP_FINISHED:]
            self._tasks = active + done
        self._write(force=True)

    def _find(self, tid):
        return next((t for t in self._tasks if t["id"] == tid), None)

    def _write(self, force: bool = False):
        now = time.time()
        if not force and now - self._last_write < 0.5:  # 진행률은 0.5초에 한 번만 기록
            return
        self._last_write = now
        with self._lock:
            data = {"updated": now, "tasks": list(self._tasks)}
        try:
            os.makedirs(DATA_DIR, exist_ok=True)
            tmp = TASKS_FILE + ".tmp"
            with open(tmp, "w", encoding="utf-8") as f:
                json.dump(data, f, ensure_ascii=False)
            os.replace(tmp, TASKS_FILE)
        except OSError:
            pass
