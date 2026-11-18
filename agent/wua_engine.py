import base64
import json
import os
import re
import subprocess
import sys

IS_WIN = sys.platform == "win32"
NOWIN = 0x08000000 if IS_WIN else 0

if IS_WIN:
    import winreg


def apply_registry_item(item: dict) -> str | None:
    path = item.get("path", "")
    if not path.upper().startswith("SOFTWARE\\POLICIES\\"):
        return f"허용되지 않은 레지스트리 경로: {path}"
    if not IS_WIN:
        return None

    try:
        acc = winreg.KEY_SET_VALUE | winreg.KEY_WOW64_64KEY
        if item.get("op") == "delete":
            try:
                with winreg.OpenKey(winreg.HKEY_LOCAL_MACHINE, path, 0, acc) as k:
                    winreg.DeleteValue(k, item["name"])
            except FileNotFoundError:
                pass
            return None

        is_dword = item.get("type") == "DWORD"
        val = int(item["value"]) if is_dword else str(item["value"])
        with winreg.CreateKeyEx(winreg.HKEY_LOCAL_MACHINE, path, 0, acc) as k:
            winreg.SetValueEx(k, item["name"], 0, winreg.REG_DWORD if is_dword else winreg.REG_SZ, val)
        return None
    except Exception as e:
        return f"{path}\\{item.get('name')}: {e}"


def is_reboot_pending() -> bool:
    if not IS_WIN:
        return False
    checks = [
        r"SOFTWARE\Microsoft\Windows\CurrentVersion\WindowsUpdate\Auto Update\RebootRequired",
        r"SOFTWARE\Microsoft\Windows\CurrentVersion\Component Based Servicing\RebootPending",
    ]
    for path in checks:
        try:
            k = winreg.OpenKey(winreg.HKEY_LOCAL_MACHINE, path, 0, winreg.KEY_READ | winreg.KEY_WOW64_64KEY)
            winreg.CloseKey(k)
            return True
        except OSError:
            pass
    return False


PS_HEADER = """[Console]::OutputEncoding=[Text.Encoding]::UTF8
$s = New-Object -ComObject Microsoft.Update.Session
$q = $s.CreateUpdateSearcher()
"""

PS_SCAN = PS_HEADER + """
$p = @($q.Search('IsInstalled=0').Updates | ForEach-Object {
    [pscustomobject]@{
        id    = $_.Identity.UpdateID
        kbs   = (@($_.KBArticleIDs) -join ',')
        title = [string]$_.Title
        size  = [int64]$_.MaxDownloadSize
        dl    = [bool]$_.IsDownloaded
        hid   = [bool]$_.IsHidden
        rb    = ([int]$_.InstallationBehavior.RebootBehavior -gt 0)
        sev   = [string]$_.MsrcSeverity
        cat   = ((@($_.Categories) | ForEach-Object {$_.Name}) -join ',')
    }
})
$h = @($q.QueryHistory(0, 40) | ForEach-Object {
    [pscustomobject]@{
        id    = $_.UpdateIdentity.UpdateID
        title = [string]$_.Title
        date  = $_.Date.ToString('s')
        rc    = [int]$_.ResultCode
        op    = [int]$_.Operation
    }
})
ConvertTo-Json -InputObject @{pend=$p; hist=$h} -Depth 4 -Compress
"""

PS_ENFORCE = PS_HEADER + """
$rules = @($env:AURORA_RULES | ConvertFrom-Json)
$installAll = ($env:AURORA_ALL -eq '1')
$out = @()
$toInstall = @()

foreach ($u in $q.Search('IsInstalled=0').Updates) {
    $k = @($u.KBArticleIDs) | Select-Object -First 1
    $kb = if ($k) { 'KB' + $k } else { '' }
    $rule = ($rules | Where-Object { $_.kb -eq $kb } | Select-Object -First 1).action

    if ($rule -eq 'block' -and -not $u.IsHidden) {
        $u.IsHidden = $true
        $out += "숨김(차단) 완료: $kb"
    }
    elseif ($rule -eq 'allow' -and $u.IsHidden) {
        $u.IsHidden = $false
        $out += "숨김 해제 완료: $kb"
    }

    if ($rule -eq 'install' -or ($installAll -and $rule -ne 'block')) {
        if ($u.IsHidden) { $u.IsHidden = $false }
        if (-not $u.EulaAccepted) { $u.AcceptEula() }
        $toInstall += $u
    }
}

if ($toInstall.Count -gt 0) {
    $coll = New-Object -ComObject Microsoft.Update.UpdateColl
    foreach ($u in $toInstall) { [void]$coll.Add($u) }
    $dl = $s.CreateUpdateDownloader()
    $dl.Updates = $coll
    [void]$dl.Download()

    $inst = $s.CreateUpdateInstaller()
    $inst.Updates = $coll
    $res = $inst.Install()
    $out += "설치 $($coll.Count)건 완료 (결과코드=$($res.ResultCode), 재부팅필요=$($res.RebootRequired))"
}
ConvertTo-Json -InputObject @($out) -Compress
"""


def _run_ps(script: str, env: dict = None, timeout: int = 1800):
    enc = base64.b64encode(script.encode("utf-16-le")).decode("ascii")
    proc = subprocess.run(
        ["powershell", "-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass", "-EncodedCommand", enc],
        capture_output=True,
        text=True,
        encoding="utf-8-sig",
        timeout=timeout,
        env={**os.environ, **(env or {})},
        creationflags=NOWIN,
    )
    if proc.returncode != 0:
        raise RuntimeError((proc.stderr or proc.stdout).strip()[:300])
    return json.loads(proc.stdout) if proc.stdout.strip() else []


def extract_kb(kbs_str: str, title: str) -> str:
    if kbs_str:
        return "KB" + kbs_str.split(",")[0].strip()
    m = re.search(r"KB\d+", title or "", re.IGNORECASE)
    return m.group(0).upper() if m else ""


def scan_updates() -> dict:
    if not IS_WIN:
        return {"pend": [], "hist": []}
    data = _run_ps(PS_SCAN, timeout=600)
    for p in data.get("pend", []):
        p["kb"] = extract_kb(p.get("kbs", ""), p.get("title", ""))
    for h in data.get("hist", []):
        h["kb"] = extract_kb("", h.get("title", ""))
    return data


def enforce_updates(rules: list[dict], install_all: bool = False) -> list[str]:
    if not IS_WIN:
        return []
    out = _run_ps(
        PS_ENFORCE,
        env={
            "AURORA_RULES": json.dumps(rules),
            "AURORA_ALL": "1" if install_all else "0",
        },
        timeout=3600,
    )
    return [out] if isinstance(out, str) else out