"""콘솔 화면 스모크 테스트 실행기 (Windows / Linux 공용)

하는 일
 1) frontend 를 임시 폴더로 빌드 (backend/static 은 건드리지 않음)
 2) backend/app 을 임시 폴더에 복사해 테스트 서버를 127.0.0.1:15570 에 띄움 (실사용 DB와 분리)
 3) 합성 테스트 데이터(가상 PC 5대, KB 규칙, 배포 그룹)를 넣음 — 실제 PC·사용자 정보 아님
 4) smoke.js 로 모든 화면을 돌며 텍스트를 기록하고 baseline.json 과 비교

사용법 (프로젝트 루트에서)
  python tests/ui_smoke/run_smoke.py                    # 기준과 비교 (다르면 종료 코드 1)
  python tests/ui_smoke/run_smoke.py --update-baseline  # 화면을 의도적으로 바꾼 뒤 기준 갱신

준비물: Python 패키지(backend/requirements.txt), Node.js,
        tests/ui_smoke 에서 `npm install` 후 `npx playwright install chromium`
"""
import argparse
import difflib
import json
import os
import shutil
import sqlite3
import subprocess
import sys
import tempfile
import time
import urllib.error
import urllib.request

HERE = os.path.dirname(os.path.abspath(__file__))
ROOT = os.path.abspath(os.path.join(HERE, "..", ".."))
PORT = 15570
BASE = f"http://127.0.0.1:{PORT}"
ADMIN_PW = "SmokeTest!2026"
BASELINE = os.path.join(HERE, "baseline.json")
NPX = "npx.cmd" if os.name == "nt" else "npx"


def call(path, body=None, token="", headers=None):
    req = urllib.request.Request(
        BASE + path,
        data=None if body is None else json.dumps(body).encode(),
        headers={"Content-Type": "application/json", "X-Session-Token": token, **(headers or {})},
    )
    try:
        with urllib.request.urlopen(req, timeout=15) as r:
            return json.loads(r.read())
    except urllib.error.HTTPError as e:
        return json.loads(e.read() or b"{}")


def wait_ready(timeout=60):
    end = time.time() + timeout
    while time.time() < end:
        try:
            if call("/api/health").get("ready"):
                return
        except Exception:
            pass
        time.sleep(0.5)
    raise RuntimeError("테스트 서버가 준비되지 않았습니다.")


def seed(srv_dir):
    """합성 데이터 시드"""
    with open(os.path.join(srv_dir, "initial_admin_password.txt"), encoding="utf-8") as f:
        temp_pw = [l.split(": ", 1)[1].strip() for l in f if "임시" in l][0]
    t = call("/api/auth/login", {"username": "admin", "password": temp_pw})["token"]
    call("/api/auth/password", {"current_password": temp_pw, "new_password": ADMIN_PW}, t)
    for i in range(1, 6):
        call("/api/agents/register", {"machine_id": f"SYN-{i}", "hostname": f"PC-SAMPLE-{i:02d}",
                                      "os_name": "Windows 11 Pro", "os_build": "25H2 (26200.100)",
                                      "agent_token": f"tok{i}" * 8})
    for i in (1, 2, 3):
        call(f"/api/agents/SYN-{i}/decision", {"approve": True, "ring": "ring1" if i < 3 else "ring0"}, t)
    call("/api/agents/SYN-4/decision", {"approve": False}, t)
    for i in (1, 2, 3):
        call("/api/agents/checkin", {
            "hostname": f"PC-SAMPLE-{i:02d}", "hotfix": "KB5000001",
            "updates": [{"kb": "KB5099999", "title": "2026-11 누적 업데이트 (합성)", "size": 104857600, "hid": False}],
            "history": [{"id": "u1", "kb": "KB5000001", "title": "합성 이력", "date": "2026-11-10T10:00:00", "rc": 2, "op": 1}],
        }, headers={"X-Machine-ID": f"SYN-{i}", "X-Agent-Token": f"tok{i}" * 8})
    call("/api/rules", {"kb": "KB5011111", "ring": "*", "action": "block", "note": "합성 규칙"}, t)
    call("/api/rings", {"ring": "ring-test", "copy_from": "ring1"}, t)
    # 합성 설치 파일 1개 등록 (실제 프로그램 아님, 내용은 고정된 더미 바이트)
    req = urllib.request.Request(BASE + "/api/packages/upload", data=b"AURORA-SMOKE-DUMMY-INSTALLER" * 1000,
                                 headers={"X-Session-Token": t, "X-File-Name": "SampleTool-1.2.0-setup.exe",
                                          "Content-Type": "application/octet-stream"})
    with urllib.request.urlopen(req, timeout=15) as r:
        up = json.loads(r.read())
    call("/api/packages", {"upload_id": up["upload_id"], "name": "SampleTool", "version": "1.2.0",
                           "install_args": "/S", "detect_name": "SampleTool"}, t)
    call("/api/auth/logout", {}, t)
    # 로그인 시 '콘솔 시작 검색'이 온라인 PC를 대상으로 하도록 마지막 통신 시각을 현재로
    c = sqlite3.connect(os.path.join(srv_dir, "aurora_enterprise.db"))
    c.execute("UPDATE agents SET last_seen=?", (time.time(),))
    c.commit()
    c.close()


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--update-baseline", action="store_true")
    args = ap.parse_args()

    work = tempfile.mkdtemp(prefix="aurora_smoke_")
    srv_dir = os.path.join(work, "server")
    os.makedirs(srv_dir)
    proc = None
    try:
        print("[1/4] 콘솔 화면 빌드...")
        subprocess.run([NPX, "vite", "build", "--outDir", os.path.join(srv_dir, "static"), "--emptyOutDir"],
                       cwd=os.path.join(ROOT, "frontend"), check=True, stdout=subprocess.DEVNULL)
        shutil.copytree(os.path.join(ROOT, "backend", "app"), os.path.join(srv_dir, "app"),
                        ignore=shutil.ignore_patterns("__pycache__"))

        print("[2/4] 테스트 서버 시작...")
        log = open(os.path.join(work, "server.log"), "w", encoding="utf-8")
        proc = subprocess.Popen([sys.executable, "-m", "uvicorn", "app.main:app", "--host", "127.0.0.1",
                                 "--port", str(PORT)], cwd=srv_dir, stdout=log, stderr=subprocess.STDOUT)
        wait_ready()
        # 서버 시작 직후 첫 로그인 때 실행되는 '콘솔 시작 검색'을 시드 로그인에서 소진시키지 않도록,
        # 시드는 서버 재시작 전에 넣고 서버를 다시 띄운다.
        print("[3/4] 합성 테스트 데이터 입력...")
        seed(srv_dir)
        proc.terminate()
        proc.wait(timeout=15)
        proc = subprocess.Popen([sys.executable, "-m", "uvicorn", "app.main:app", "--host", "127.0.0.1",
                                 "--port", str(PORT)], cwd=srv_dir, stdout=log, stderr=subprocess.STDOUT)
        wait_ready()
        c = sqlite3.connect(os.path.join(srv_dir, "aurora_enterprise.db"))
        c.execute("UPDATE agents SET last_seen=?", (time.time(),))
        c.commit()
        c.close()

        print("[4/4] 화면 점검...")
        out = os.path.join(work, "result.json")
        subprocess.run(["node", os.path.join(HERE, "smoke.js"), out, BASE, ADMIN_PW], cwd=HERE, check=True)
        result = json.load(open(out, encoding="utf-8"))
    finally:
        if proc:
            proc.terminate()
            try:
                proc.wait(timeout=15)
            except Exception:
                proc.kill()

    if result["errs"]:
        print("런타임 오류:", *result["errs"], sep="\n  ")
    if args.update_baseline:
        json.dump(result["snap"], open(BASELINE, "w", encoding="utf-8"), ensure_ascii=False, indent=1)
        print(f"기준 갱신 완료: {BASELINE}")
        shutil.rmtree(work, ignore_errors=True)
        return 0 if not result["errs"] else 1

    base = json.load(open(BASELINE, encoding="utf-8"))
    bad = 0
    for k, v in base.items():
        got = result["snap"].get(k)
        if got != v:
            bad += 1
            print(f"\n== 화면 다름: {k}")
            print("\n".join(list(difflib.unified_diff(v.splitlines(), (got or "").splitlines(), "기준", "현재",
                                                      lineterm="", n=0))[:30]))
    print(f"\n결과: 화면 {len(base) - bad}/{len(base)} 일치, 런타임 오류 {len(result['errs'])}건")
    if bad or result["errs"]:
        print(f"(서버 로그: {os.path.join(work, 'server.log')})")
        return 1
    shutil.rmtree(work, ignore_errors=True)
    return 0


if __name__ == "__main__":
    sys.exit(main())
