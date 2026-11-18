"""AURORA Update Control - 콘솔 서버 (의존성 없음)
실행: python server.py [포트]   (기본 8080)
"""
import hashlib, json, os, re, secrets, sqlite3, sys, time
from http.server import ThreadingHTTPServer, BaseHTTPRequestHandler

D = os.path.dirname(os.path.abspath(__file__))
TOKF = os.path.join(D, "tokens.json")
if not os.path.exists(TOKF):
    json.dump({"admin": secrets.token_urlsafe(12), "agent": secrets.token_urlsafe(16)}, open(TOKF, "w"))
T = json.load(open(TOKF))

def db():
    c = sqlite3.connect(os.path.join(D, "aurora.db"), timeout=10)
    c.row_factory = sqlite3.Row
    return c

def init():
    c = db()
    c.executescript("""
    CREATE TABLE IF NOT EXISTS agents(id TEXT PRIMARY KEY, host TEXT, ip TEXT, build TEXT, ring TEXT DEFAULT 'ring1',
      last_seen REAL, applied TEXT, reboot INT, hot TEXT, ver TEXT);
    CREATE TABLE IF NOT EXISTS policies(ring TEXT PRIMARY KEY, items TEXT);
    CREATE TABLE IF NOT EXISTS cmds(n INTEGER PRIMARY KEY AUTOINCREMENT, agent TEXT, type TEXT);
    CREATE TABLE IF NOT EXISTS events(ts REAL, host TEXT, msg TEXT);
    CREATE TABLE IF NOT EXISTS rules(kb TEXT, ring TEXT, action TEXT, note TEXT, ts REAL, PRIMARY KEY(kb, ring));""")
    for col, typ in (("pend", "TEXT"), ("hist", "TEXT"), ("upd_ts", "REAL")):   # 기존 DB 호환
        try: c.execute(f"ALTER TABLE agents ADD COLUMN {col} {typ}")
        except sqlite3.OperationalError: pass
    WU = "SOFTWARE\\Policies\\Microsoft\\Windows\\WindowsUpdate"
    def base(days):
        return [
            {"path": WU, "name": "DeferQualityUpdates", "type": "DWORD", "value": 1 if days else 0},
            {"path": WU, "name": "DeferQualityUpdatesPeriodInDays", "type": "DWORD", "value": days},
            {"path": WU, "name": "ProductVersion", "type": "SZ", "value": "Windows 11"},
            {"path": WU, "name": "TargetReleaseVersion", "type": "DWORD", "value": 1},
            {"path": WU, "name": "TargetReleaseVersionInfo", "type": "SZ", "value": "24H2"},
            {"path": WU, "name": "ExcludeWUDriversInQualityUpdate", "type": "DWORD", "value": 1},
            {"path": WU + "\\AU", "name": "NoAutoRebootWithLoggedOnUsers", "type": "DWORD", "value": 1},
        ]
    for r, d in (("ring0", 0), ("ring1", 7)):
        c.execute("INSERT OR IGNORE INTO policies VALUES(?,?)", (r, json.dumps(base(d))))
    c.commit(); c.close()

def phash(items):
    return hashlib.sha1(json.dumps(items, sort_keys=True).encode()).hexdigest()[:12]

def policy(c, ring):
    row = c.execute("SELECT items FROM policies WHERE ring=?", (ring,)).fetchone()
    items = json.loads(row["items"]) if row else []
    return {"items": items, "hash": phash(items)}

def ev(c, host, msg):
    c.execute("INSERT INTO events VALUES(?,?,?)", (time.time(), host, msg))

def rules_for(c, ring):
    """전체(*) 규칙 위에 링별 규칙을 덮어써서 해당 링에 적용할 KB 규칙 목록을 만든다."""
    m = {}
    for r in c.execute("SELECT kb,action FROM rules WHERE ring IN ('*',?) ORDER BY ring='*' DESC", (ring,)):
        m[r["kb"]] = r["action"]
    return [{"kb": k, "action": v} for k, v in sorted(m.items())]

class H(BaseHTTPRequestHandler):
    def log_message(self, *a): pass

    def out(self, code, body, ct="application/json"):
        b = body if isinstance(body, bytes) else json.dumps(body, ensure_ascii=False).encode()
        self.send_response(code)
        self.send_header("Content-Type", ct + "; charset=utf-8")
        self.send_header("Content-Length", str(len(b)))
        self.end_headers(); self.wfile.write(b)

    def data(self):
        return json.loads(self.rfile.read(int(self.headers.get("Content-Length") or 0)) or b"{}")

    def auth(self, role, hdr):
        if secrets.compare_digest(self.headers.get(hdr, ""), T[role]): return True
        self.out(401, {"error": "auth"}); return False

    def do_GET(self):
        if self.path == "/":
            return self.out(200, open(os.path.join(D, "console.html"), "rb").read(), "text/html")
        if self.path == "/api/state" and self.auth("admin", "X-Admin"):
            c = db()
            pol = {r["ring"]: {"items": json.loads(r["items"]), "hash": phash(json.loads(r["items"]))}
                   for r in c.execute("SELECT * FROM policies")}
            agents = [dict(r) for r in c.execute("SELECT * FROM agents ORDER BY host")]
            for a in agents:
                a["target"] = pol.get(a["ring"], {}).get("hash")
                a["pend"], a["hist"] = json.loads(a["pend"] or "[]"), json.loads(a["hist"] or "[]")
            rules = [dict(r) for r in c.execute("SELECT * FROM rules ORDER BY kb")]
            evs = [dict(r) for r in c.execute("SELECT * FROM events ORDER BY ts DESC LIMIT 60")]
            c.close()
            return self.out(200, {"now": time.time(), "agents": agents, "policies": pol, "events": evs, "rules": rules})
        if self.path != "/api/state": self.out(404, {})

    def do_POST(self):
        p, d = self.path, self.data()
        c = db()
        try:
            if p == "/api/checkin":
                if not self.auth("agent", "X-Agent"): return
                row = c.execute("SELECT 1 FROM agents WHERE id=?", (d["id"],)).fetchone()
                if not row:
                    c.execute("INSERT INTO agents(id,ring) VALUES(?, 'ring1')", (d["id"],))
                    ev(c, d["host"], "새 에이전트 등록")
                c.execute("UPDATE agents SET host=?,ip=?,build=?,last_seen=?,applied=?,reboot=?,hot=?,ver=? WHERE id=?",
                          (d["host"], self.client_address[0], d["build"], time.time(), d.get("applied", ""),
                           int(d.get("reboot", 0)), d.get("hot", ""), d.get("ver", ""), d["id"]))
                for r in d.get("results", []):
                    ev(c, d["host"], f"{'OK' if r['ok'] else 'FAIL'} {r['type']}: {r.get('out', '')}"[:300])
                if "updates" in d:
                    c.execute("UPDATE agents SET pend=?,hist=?,upd_ts=? WHERE id=?",
                              (json.dumps(d["updates"]), json.dumps(d.get("history", [])), time.time(), d["id"]))
                ring = c.execute("SELECT ring FROM agents WHERE id=?", (d["id"],)).fetchone()["ring"]
                cmds = [r["type"] for r in c.execute("SELECT type FROM cmds WHERE agent=? ORDER BY n", (d["id"],))]
                c.execute("DELETE FROM cmds WHERE agent=?", (d["id"],))
                rl = rules_for(c, ring)
                res = {"policy": policy(c, ring), "commands": cmds, "rules": rl, "rhash": phash(rl)}
            elif not self.auth("admin", "X-Admin"):
                return
            elif p == "/api/ring":
                c.execute("UPDATE agents SET ring=? WHERE id=?", (d["ring"], d["id"])); res = {"ok": 1}
            elif p == "/api/policy":
                c.execute("INSERT OR REPLACE INTO policies VALUES(?,?)", (d["ring"], json.dumps(d["items"])))
                ev(c, "console", f"{d['ring']} 정책 저장 ({phash(d['items'])})"); res = {"ok": 1}
            elif p == "/api/rule":
                kb = str(d.get("kb", "")).upper().strip()
                if not re.fullmatch(r"KB\d{5,8}", kb) or d.get("action") not in ("block", "allow", "install", "none"):
                    return self.out(400, {"error": "KB 번호 또는 동작이 올바르지 않습니다"})
                if d["action"] == "none":
                    c.execute("DELETE FROM rules WHERE kb=? AND ring=?", (kb, d["ring"]))
                else:
                    c.execute("INSERT OR REPLACE INTO rules VALUES(?,?,?,?,?)", (kb, d["ring"], d["action"], d.get("note", ""), time.time()))
                ev(c, "console", f"규칙 {kb} → {d['action']} ({'전체' if d['ring'] == '*' else d['ring']})"); res = {"ok": 1}
            elif p == "/api/cmd":
                for i in d["ids"]: c.execute("INSERT INTO cmds(agent,type) VALUES(?,?)", (i, d["type"]))
                ev(c, "console", f"명령 {d['type']} → {len(d['ids'])}대"); res = {"ok": 1}
            else:
                return self.out(404, {})
            c.commit()
        finally:
            c.close()
        self.out(200, res)

if __name__ == "__main__":
    init()
    port = int(sys.argv[1]) if len(sys.argv) > 1 else 8080
    print(f"AURORA Update Control  http://0.0.0.0:{port}")
    print(f"  관리자 토큰: {T['admin']}\n  에이전트 토큰: {T['agent']}")
    ThreadingHTTPServer(("0.0.0.0", port), H).serve_forever()
