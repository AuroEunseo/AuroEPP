import json
import re
import subprocess
import time
import urllib.request
from html import unescape
from sqlalchemy.orm import Session
from .models import Agent, UpdateCatalog


def summarize_update_ko(kb: str, title: str, raw_desc: str = "") -> tuple[str, str]:
    t_lower = title.lower()

    if "cumulative update" in t_lower or "누적 업데이트" in title:
        cat = "월간 누적 업데이트"
    elif "security" in t_lower or "보안" in title:
        cat = "긴급 보안 패치"
    elif ".net framework" in t_lower:
        cat = ".NET 런타임 업데이트"
    elif "driver" in t_lower or "드라이버" in title:
        cat = "하드웨어 드라이버"
    elif "preview" in t_lower or "미리 보기" in title:
        cat = "비보안 미리보기(선택)"
    else:
        cat = "Windows 기능/품질 패치"

    ver_match = re.search(r"(2[23456]H2)", title, re.IGNORECASE)
    ver_str = f"Windows 11 {ver_match.group(1).upper()} 대상 " if ver_match else "Windows 11 "

    if raw_desc:
        clean = re.sub(r"<[^>]+>", " ", unescape(raw_desc))
        clean = re.sub(r"\s+", " ", clean).strip()
        return cat, clean[:220] + ("..." if len(clean) > 220 else "")

    if "driver" in t_lower:
        summary = f"{ver_str}장치 호환성 및 하드웨어 제어 안정화를 위한 벤더 드라이버 패키지입니다."
    elif "preview" in t_lower:
        summary = f"{ver_str}차기 정기 패치 전 기능 개선 및 버그 수정을 미리 배포하는 선택적 업데이트입니다."
    elif ".net" in t_lower:
        summary = f"{ver_str}.NET Framework 보안 취약점 보완 및 애플리케이션 실행 안정성 패치입니다."
    else:
        summary = f"{ver_str}운영체제 보안 취약점 해결, 커널 안정성 개선 및 주요 품질 버그 수정이 포함된 업데이트입니다."

    return cat, summary


def fetch_microsoft_win11_updates() -> list[dict]:
    """Microsoft Update Catalog에서 최신 Windows 11 업데이트 목록 수집"""
    results = []
    seen_kbs = set()
    queries = [
        "Cumulative+Update+for+Windows+11",
        "Security+Update+for+Windows+11",
    ]

    for q in queries:
        url = f"https://www.catalog.update.microsoft.com/Search.aspx?q={q}"
        req = urllib.request.Request(
            url,
            headers={
                "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36",
                "Accept": "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
                "Accept-Language": "ko-KR,ko;q=0.9,en-US;q=0.8,en;q=0.7",
            },
        )
        try:
            with urllib.request.urlopen(req, timeout=10) as resp:
                html = resp.read().decode("utf-8", errors="ignore")

            anchors = re.findall(r"<a\b[^>]*>(.*?)</a>", html, flags=re.IGNORECASE | re.DOTALL)
            for raw_text in anchors:
                title = re.sub(r"<[^>]+>", "", unescape(raw_text)).strip()
                title = re.sub(r"\s+", " ", title)
                if "windows 11" not in title.lower():
                    continue
                kb_m = re.search(r"\b(KB\d{6,8})\b", title, re.IGNORECASE)
                if not kb_m:
                    continue
                kb = kb_m.group(1).upper()
                if kb in seen_kbs:
                    continue
                seen_kbs.add(kb)

                date_m = re.search(r"(202\d-\d{2})", title)
                rel_date = date_m.group(1) if date_m else "최신 릴리스"
                cat, summary = summarize_update_ko(kb, title)
                results.append({
                    "kb": kb,
                    "title": title,
                    "category": cat,
                    "summary": summary,
                    "release_date": rel_date,
                    "source": "microsoft",
                })
        except Exception as e:
            print(f"[Catalog Sync] Microsoft 카탈로그 조회 경고 ({q}): {e}")

    return results


def fetch_local_wua_history() -> list[dict]:
    """관제 서버 PC 자체의 Windows Update API(COM)에서 설치/가용 업데이트 이력 조회"""
    ps_script = (
        "[Console]::OutputEncoding = [System.Text.Encoding]::UTF8; "
        "$s = New-Object -ComObject Microsoft.Update.Session; "
        "$searcher = $s.CreateUpdateSearcher(); "
        "$cnt = $searcher.GetTotalHistoryCount(); "
        "if ($cnt -gt 0) { "
        "  $hist = $searcher.QueryHistory(0, [Math]::Min($cnt, 40)); "
        "  $hist | ForEach-Object { [PSCustomObject]@{ Title = $_.Title; Date = $_.Date.ToString('yyyy-MM-dd') } } | ConvertTo-Json -Compress "
        "}"
    )
    results = []
    try:
        out = subprocess.check_output(
            ["powershell", "-NoProfile", "-Command", ps_script],
            timeout=12,
            stderr=subprocess.DEVNULL,
        ).decode("utf-8", errors="ignore").strip()
        if not out:
            return []
        items = json.loads(out)
        if isinstance(items, dict):
            items = [items]
        for it in items:
            title = str(it.get("Title", "")).strip()
            kb_m = re.search(r"\b(KB\d{6,8})\b", title, re.IGNORECASE)
            if not kb_m:
                continue
            kb = kb_m.group(1).upper()
            cat, summary = summarize_update_ko(kb, title)
            results.append({
                "kb": kb,
                "title": title,
                "category": cat,
                "summary": summary,
                "release_date": str(it.get("Date", "로컬 이력")),
                "source": "wua_local",
            })
    except Exception as e:
        print(f"[Catalog Sync] 로컬 WUA 이력 조회 생략: {e}")
    return results


def sync_catalog_database(db: Session, fetch_online: bool = True) -> int:
    now = time.time()
    existing_kbs = {row[0] for row in db.query(UpdateCatalog.kb).all()}
    merged_map: dict[str, dict] = {}

    def stage(kb: str, title: str, rel_date: str, source: str, raw_desc: str = ""):
        kb = kb.strip().upper()
        if not re.match(r"^KB\d{5,8}$", kb):
            return
        cat, summary = summarize_update_ko(kb, title or kb, raw_desc)
        prev = merged_map.get(kb)
        if not prev or len(title or "") > len(prev.get("title") or ""):
            merged_map[kb] = {
                "kb": kb,
                "title": title or (prev["title"] if prev else f"Windows 11 업데이트 ({kb})"),
                "category": cat,
                "summary": summary,
                "release_date": rel_date or (prev["release_date"] if prev else "수집됨"),
                "source": source,
            }

    # 1) 사내 에이전트들이 보고한 대기/기설치 KB 수집
    for a in db.query(Agent).all():
        try:
            for u in json.loads(a.pend_json or "[]"):
                if u.get("kb"):
                    stage(u["kb"], u.get("title", ""), "대기 중 감지", "agent")
        except Exception:
            pass

        if a.hotfix:
            for token in a.hotfix.split(","):
                kb_tok = token.strip().upper()
                if kb_tok.startswith("KB"):
                    stage(kb_tok, f"Windows 11 기설치 보안/품질 핫픽스 ({kb_tok})", "설치 이력 감지", "agent")

    # 2) 관제 서버 PC 로컬 Windows Update 이력 수집
    for item in fetch_local_wua_history():
        stage(item["kb"], item["title"], item["release_date"], item["source"])

    # 3) Microsoft Update Catalog 온라인 수집
    if fetch_online:
        for item in fetch_microsoft_win11_updates():
            stage(item["kb"], item["title"], item["release_date"], item["source"])

    new_count = 0
    for kb, data in merged_map.items():
        if kb not in existing_kbs:
            new_count += 1
        db.merge(
            UpdateCatalog(
                kb=data["kb"],
                title=data["title"],
                category=data["category"],
                summary=data["summary"],
                release_date=data["release_date"],
                source=data["source"],
                updated_at=now,
            )
        )

    db.commit()
    return new_count