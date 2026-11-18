"""AURORA Update Control - 에이전트 v0.2 (관리자 권한 필요, 의존성 없음)
실행: python agent.py --server http://콘솔IP:8080 --token 에이전트토큰 [--dry-run]
--dry-run: 레지스트리·업데이트를 건드리지 않고 가짜 데이터로 동작 (윈도우가 아니어도 됨)
"""
import argparse, base64, json, os, queue, re, socket, subprocess, sys, threading, time, urllib.request, uuid

IS_WIN = sys.platform == "win32"
if IS_WIN:
    import winreg
ap = argparse.ArgumentParser()
ap.add_argument("--server", required=True)
ap.add_argument("--token", required=True)
ap.add_argument("--interval", type=int, default=20)   # 콘솔과 통신하는 주기(초)
ap.add_argument("--sync", type=int, default=600)      # 업데이트 목록 자동 갱신 주기(초)
ap.add_argument("--dry-run", action="store_true")
A = ap.parse_args()
FAKE = A.dry_run or not IS_WIN
NOWIN = 0x08000000 if IS_WIN else 0
VER = "0.2"

# ---------- 레지스트리 정책 (HKLM\SOFTWARE\Policies 하위만 허용) ----------
def apply(it):
    path = it["path"]
    if not path.upper().startswith("SOFTWARE\\POLICIES\\"):
        return f"거부된 경로 {path}"
    if FAKE:
        print(f"[dry] {path}\\{it['name']} = {it.get('value')}")
        return None
    try:
        acc = winreg.KEY_SET_VALUE | winreg.KEY_WOW64_64KEY
        if it.get("op") == "delete":
            try:
                with winreg.OpenKey(winreg.HKEY_LOCAL_MACHINE, path, 0, acc) as k:
                    winreg.DeleteValue(k, it["name"])
            except FileNotFoundError:
                pass
            return None
        dw = it["type"] == "DWORD"
        with winreg.CreateKeyEx(winreg.HKEY_LOCAL_MACHINE, path, 0, acc) as k:
            winreg.SetValueEx(k, it["name"], 0, winreg.REG_DWORD if dw else winreg.REG_SZ,
                              int(it["value"]) if dw else str(it["value"]))
    except Exception as e:
        return f"{path}\\{it['name']}: {e}"

def reg_read(path, name):
    try:
        with winreg.OpenKey(winreg.HKEY_LOCAL_MACHINE, path, 0, winreg.KEY_READ | winreg.KEY_WOW64_64KEY) as k:
            return winreg.QueryValueEx(k, name)[0]
    except OSError:
        return None

def reg_has(path):
    try:
        winreg.CloseKey(winreg.OpenKey(winreg.HKEY_LOCAL_MACHINE, path, 0, winreg.KEY_READ | winreg.KEY_WOW64_64KEY))
        return True
    except OSError:
        return False

def machine_id():
    g = None if FAKE else reg_read("SOFTWARE\\Microsoft\\Cryptography", "MachineGuid")
    return g or str(uuid.uuid5(uuid.NAMESPACE_DNS, socket.gethostname()))

def build():
    if FAKE: return "24H2 (26100.dry)"
    cv = "SOFTWARE\\Microsoft\\Windows NT\\CurrentVersion"
    return f"{reg_read(cv, 'DisplayVersion') or '?'} ({reg_read(cv, 'CurrentBuildNumber')}.{reg_read(cv, 'UBR')})"

def reboot_pending():
    if FAKE: return 0
    return int(reg_has("SOFTWARE\\Microsoft\\Windows\\CurrentVersion\\WindowsUpdate\\Auto Update\\RebootRequired")
               or reg_has("SOFTWARE\\Microsoft\\Windows\\CurrentVersion\\Component Based Servicing\\RebootPending"))

# ---------- Windows Update Agent(COM) 연동 ----------
HEAD = """[Console]::OutputEncoding=[Text.Encoding]::UTF8
$s=New-Object -ComObject Microsoft.Update.Session
$q=$s.CreateUpdateSearcher()
"""
PS_SCAN = HEAD + """
$p=@($q.Search('IsInstalled=0').Updates|ForEach-Object{[pscustomobject]@{id=$_.Identity.UpdateID;kbs=(@($_.KBArticleIDs) -join ',');title=[string]$_.Title;size=[int64]$_.MaxDownloadSize;dl=[bool]$_.IsDownloaded;hid=[bool]$_.IsHidden;rb=([int]$_.InstallationBehavior.RebootBehavior -gt 0);sev=[string]$_.MsrcSeverity;cat=((@($_.Categories)|ForEach-Object{$_.Name}) -join ',')}})
$h=@($q.QueryHistory(0,40)|ForEach-Object{[pscustomobject]@{id=$_.UpdateIdentity.UpdateID;title=[string]$_.Title;date=$_.Date.ToString('s');rc=[int]$_.ResultCode;op=[int]$_.Operation}})
ConvertTo-Json -InputObject @{pend=$p;hist=$h} -Depth 4 -Compress
"""
# 규칙: block=숨김(자동 설치 제외) / allow=숨김 해제(설치 허가) / install=즉시 설치
PS_ACT = HEAD + """
$a=@($env:AURORA_ACT|ConvertFrom-Json)
$all=($env:AURORA_ALL -eq '1')
$out=@();$inst=@()
foreach($u in $q.Search('IsInstalled=0').Updates){
 $k=@($u.KBArticleIDs)|Select-Object -First 1;$kb=if($k){'KB'+$k}else{''}
 $r=($a|Where-Object{$_.kb -eq $kb}|Select-Object -First 1).action
 if($r -eq 'block' -and -not $u.IsHidden){$u.IsHidden=$true;$out+="차단(숨김) $kb"}
 elseif($r -eq 'allow' -and $u.IsHidden){$u.IsHidden=$false;$out+="차단 해제 $kb"}
 if($r -eq 'install' -or ($all -and $r -ne 'block')){
  if($u.IsHidden){$u.IsHidden=$false}
  if(-not $u.EulaAccepted){$u.AcceptEula()}
  $inst+=$u}}
if($inst.Count){
 $c=New-Object -ComObject Microsoft.Update.UpdateColl
 foreach($u in $inst){[void]$c.Add($u)}
 $d=$s.CreateUpdateDownloader();$d.Updates=$c;[void]$d.Download()
 $i=$s.CreateUpdateInstaller();$i.Updates=$c;$x=$i.Install()
 $out+="설치 $($c.Count)건 결과코드=$($x.ResultCode) 재부팅필요=$($x.RebootRequired)"}
ConvertTo-Json -InputObject @($out) -Compress
"""

def ps(script, env=None, timeout=900):
    enc = base64.b64encode(script.encode("utf-16-le")).decode()
    r = subprocess.run(["powershell", "-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass", "-EncodedCommand", enc],
                       capture_output=True, text=True, encoding="utf-8-sig", timeout=timeout,
                       env={**os.environ, **(env or {})}, creationflags=NOWIN)
    if r.returncode:
        raise RuntimeError((r.stderr or r.stdout).strip()[:300])
    return json.loads(r.stdout)

def scan():
    if FAKE:
        return {"pend": [
            {"id": "d1", "kbs": "5050009", "title": "2026-11 Windows 11 24H2 누적 업데이트 (KB5050009)", "size": 412e6, "dl": False, "hid": False, "rb": True, "sev": "Important", "cat": "Security Updates"},
            {"id": "d2", "kbs": "5049999", "title": ".NET Framework 보안 업데이트 (KB5049999)", "size": 61e6, "dl": True, "hid": False, "rb": False, "sev": "Moderate", "cat": "Security Updates"},
            {"id": "d3", "kbs": "", "title": "Realtek - Audio - 6.0.9500.1", "size": 18e6, "dl": False, "hid": False, "rb": False, "sev": "", "cat": "Drivers"}],
            "hist": [{"id": "h1", "title": "2026-10 Windows 11 24H2 누적 업데이트 (KB5048000)", "date": "2026-10-14T03:10:00", "rc": 2, "op": 1},
                     {"id": "h2", "title": "Intel - Net - 22.250.1.2", "date": "2026-10-20T11:02:00", "rc": 4, "op": 1}]}
    return ps(PS_SCAN)

def kbof(ids, title):
    m = re.search(r"KB\d+", title or "")
    return ("KB" + ids.split(",")[0]) if ids else (m.group(0) if m else "")

def enforce(rules, all_):
    if FAKE:
        return [f"[dry] {r['action']} {r['kb']}" for r in rules] + (["[dry] 차단 외 전체 설치"] if all_ else [])
    out = ps(PS_ACT, {"AURORA_ACT": json.dumps(rules), "AURORA_ALL": "1" if all_ else "0"}, 3600)
    return [out] if isinstance(out, str) else out

# ---------- 백그라운드 작업 (긴 작업 중에도 콘솔 통신 유지) ----------
RULES = []
Q, LOCK, BUSY = queue.Queue(), threading.Lock(), threading.Event()
OUT = {"report": None, "results": []}

def job(kind):
    BUSY.set()
    try:
        d, msgs = scan(), []
        if RULES or kind == "installall":
            msgs = enforce(list(RULES), kind == "installall")
            if msgs and not FAKE:
                d = scan()
        for p in d["pend"]: p["kb"] = kbof(p.get("kbs"), p["title"])
        for h in d["hist"]: h["kb"] = kbof("", h["title"])
        done = [h["kb"] for h in d["hist"] if h["op"] == 1 and h["rc"] in (2, 3) and h["kb"]]
        with LOCK:
            OUT["report"] = {"updates": d["pend"], "history": d["hist"], "hot": ",".join(dict.fromkeys(done))[:60]}
            OUT["results"] += [{"type": "update", "ok": True, "out": m} for m in msgs]
    except Exception as e:
        with LOCK:
            OUT["results"].append({"type": kind, "ok": False, "out": str(e)[:200]})
    finally:
        BUSY.clear()

def worker():
    while True:
        job(Q.get())

def want(kind):
    if kind == "installall" or (not BUSY.is_set() and Q.empty()):
        Q.put(kind)
        return True
    return False

def reboot():
    if FAKE: return {"type": "reboot", "ok": True, "out": "dry-run"}
    subprocess.run(["shutdown", "/r", "/t", "60", "/c", "AURORA: 업데이트 적용을 위해 60초 후 재부팅합니다"], creationflags=NOWIN)
    return {"type": "reboot", "ok": True, "out": "60초 후 재부팅"}

def post(body):
    req = urllib.request.Request(A.server.rstrip("/") + "/api/checkin", json.dumps(body).encode(),
                                 {"Content-Type": "application/json", "X-Agent": A.token})
    return json.load(urllib.request.urlopen(req, timeout=15))

def main():
    global RULES
    mid, host = machine_id(), socket.gethostname()
    applied, seen_rh, last_sync, hot, rep, results = "", None, 0, "", None, []
    threading.Thread(target=worker, daemon=True).start()
    print(f"AURORA agent {VER}  {host}  → {A.server}  {'(dry-run)' if FAKE else ''}")
    while True:
        try:
            with LOCK:
                if OUT["report"]: rep, OUT["report"] = OUT["report"], None
                results += OUT["results"]; OUT["results"].clear()
            if rep: hot = rep["hot"]
            body = {"id": mid, "host": host, "build": build(), "applied": applied, "reboot": reboot_pending(),
                    "hot": hot, "ver": VER, "results": results}
            if rep: body.update(rep)
            r = post(body)
            rep, results = None, []
            RULES = r["rules"]
            for c in r["commands"]:                      # 명령은 유실되지 않도록 정책 처리보다 먼저
                if c == "scan": want("sync")
                elif c == "installall": want("installall")
                elif c == "reboot": results.append(reboot())
            if r["rhash"] != seen_rh or time.time() - last_sync > A.sync:
                if want("sync"): seen_rh, last_sync = r["rhash"], time.time()
            pol = r["policy"]
            if pol["hash"] != applied:
                errs = [e for e in map(apply, pol["items"]) if e]
                results.append({"type": "policy", "ok": not errs,
                                "out": f"{pol['hash']} " + ("; ".join(errs) if errs else f"{len(pol['items'])}개 적용")})
                if not errs:
                    applied = pol["hash"]
                    continue  # 즉시 재보고
        except Exception as e:
            print("checkin 실패:", e)
        time.sleep(A.interval)

if __name__ == "__main__":
    main()
