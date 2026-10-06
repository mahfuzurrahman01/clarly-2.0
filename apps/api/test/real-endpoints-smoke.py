#!/usr/bin/env python3
"""
Real-endpoint smoke test — hits the actual running API at localhost:4000.
Creates a real Supabase Auth user, signs up a tenant, refreshes the JWT
with claims, then hits every endpoint.
"""
import subprocess, json, time, base64, sys, hmac, hashlib, os

SUPABASE_URL = "http://127.0.0.1:54321"
ANON_KEY = os.environ["SUPABASE_ANON_KEY"]  # from `supabase status`
SERVICE_ROLE = os.environ["SUPABASE_SERVICE_ROLE_KEY"]  # from `supabase status`; never commit it
BASE = "http://localhost:4000"
PASS = FAIL = TOTAL = 0
JWT_SECRET = b"local-dev-jwt-secret-do-not-use-in-prod-at-least-32-chars"
CREATED_IDS = {}

# ── helpers ────────────────────────────────────────────────────────

def curl_raw(desc, expect, *args):
    global PASS, FAIL, TOTAL
    TOTAL += 1
    r = subprocess.run(["curl", "-s", "-o", "/dev/null", "-w", "%{http_code}"] + list(args),
                        capture_output=True, text=True, timeout=15)
    code = r.stdout.strip()
    ok = code == expect
    if ok:
        PASS += 1; print(f"  ✓ {desc} → {code}")
    else:
        FAIL += 1; print(f"  ✗ {desc} → {code} (expected {expect})")

def curl_json(desc, expect, *args):
    global PASS, FAIL, TOTAL
    TOTAL += 1
    r = subprocess.run(["curl", "-s", "-w", "\nHTTP:%{http_code}"] + list(args),
                        capture_output=True, text=True, timeout=15)
    lines = r.stdout.rsplit("\nHTTP:", 1)
    body, code = (lines[0], lines[1]) if len(lines) > 1 else (r.stdout, "?")
    ok = code == expect
    if ok:
        PASS += 1; print(f"  ✓ {desc} → {code}")
    else:
        FAIL += 1; print(f"  ✗ {desc} → {code} (expected {expect})")
    try:
        return json.loads(body)
    except Exception:
        return body

def supa(method, path, data=None):
    body = ["-d", json.dumps(data)] if data else []
    r = subprocess.run(["curl", "-s", "-X", method, f"{SUPABASE_URL}{path}",
                        "-H", f"apikey: {ANON_KEY}", "-H", "Content-Type: application/json"] + body,
                       capture_output=True, text=True, timeout=15)
    return json.loads(r.stdout)

def make_jwt(payload):
    hdr = base64.urlsafe_b64encode(json.dumps({"alg":"HS256","typ":"JWT"}).encode()).rstrip(b'=').decode()
    bod = base64.urlsafe_b64encode(json.dumps(payload).encode()).rstrip(b'=').decode()
    sig = hmac.new(JWT_SECRET, f"{hdr}.{bod}".encode(), hashlib.sha256).digest()
    return f"{hdr}.{bod}.{base64.urlsafe_b64encode(sig).rstrip(b'=').decode()}"

# ── SETUP ──────────────────────────────────────────────────────────

EMAIL = f"e2e-{int(time.time())}@example.com"
PASSWORD = "Test123456!"

su = supa("POST", "/auth/v1/signup", {"email": EMAIL, "password": PASSWORD})
USER_ID = su.get("user", {}).get("id") or su.get("id")
TOKEN = su.get("access_token")
REFRESH = su.get("refresh_token")
print(f"User:  {USER_ID}")

app_su = curl_json("POST /onboarding/signup", "201",
    "-X", "POST", "-H", f"Authorization: Bearer {TOKEN}",
    "-H", "Content-Type: application/json",
    "-d", json.dumps({"tenantName": "E2E Smoke Tenant"}),
    f"{BASE}/onboarding/signup")
TID = app_su["tenantId"]
print(f"Tenant: {TID}")

refreshed = supa("POST", "/auth/v1/token?grant_type=refresh_token", {"refresh_token": REFRESH})
TOKEN = refreshed["access_token"]
claims = json.loads(base64.urlsafe_b64decode(TOKEN.split('.')[1] + '=='))
assert claims["app_metadata"]["tenant_id"] == TID, f"tenant_id mismatch: {claims['app_metadata']['tenant_id']}"
assert claims["app_metadata"]["app_role"] == "admin"
print(f"JWT:   verified (tenant_id={TID[:8]}…, app_role=admin)")
print()

H   = ["-H", f"Authorization: Bearer {TOKEN}"]
CT  = ["-H", "Content-Type: application/json"]

# ── TESTS ──────────────────────────────────────────────────────────

print("1. Public")
curl_raw("GET /health", "200", f"{BASE}/health")
print()

print("2. Auth guard")
curl_raw("no token → 401", "401", f"{BASE}/onboarding/tenant")
curl_raw("bad token → 401", "401", "-H", "Authorization: Bearer x", f"{BASE}/onboarding/tenant")
curl_raw("bad scheme → 401", "401", "-H", "Authorization: Basic foo", f"{BASE}/onboarding/tenant")
# HS256 token with random UUID → valid signature, but tenant doesn't exist → 403
hs = make_jwt({"sub":"0"*36,"role":"authenticated","app_metadata":{"tenant_id":"00000000-0000-0000-0000-000000000001","app_role":"admin"},"exp":9999999999})
curl_raw("synthetic HS256 token → 403", "403", "-H", f"Authorization: Bearer {hs}", f"{BASE}/onboarding/tenant")
print()

print("3. Onboarding")
curl_raw("GET /onboarding/tenant", "200", *H, f"{BASE}/onboarding/tenant")
curl_raw("GET /onboarding/tenant-policy", "200", *H, f"{BASE}/onboarding/tenant-policy")
curl_raw("PATCH /onboarding/tenant-policy", "200", "-X", "PATCH", *H, *CT,
         "-d", json.dumps({"stuckTicketThresholdMinutes": 45}), f"{BASE}/onboarding/tenant-policy")
curl_raw("GET /onboarding/team", "200", *H, f"{BASE}/onboarding/team")
curl_json("POST /onboarding/team/invite", "201", "-X", "POST", *H, *CT,
          "-d", json.dumps({"email": "bob@example.com", "appRole": "agent"}),
          f"{BASE}/onboarding/team/invite")
curl_raw("POST /onboarding/team/invite 400", "400", "-X", "POST", *H, *CT,
         "-d", '{"email":"bad","appRole":"agent"}', f"{BASE}/onboarding/team/invite")
curl_raw("GET /onboarding/tenant/closure", "200", *H, f"{BASE}/onboarding/tenant/closure")
print()

print("4. Kanban")
curl_raw("GET /kanban/tickets", "200", *H, f"{BASE}/kanban/tickets")
curl_raw("GET /kanban/tickets/config", "200", *H, f"{BASE}/kanban/tickets/config")
curl_raw("GET /kanban/tickets/team", "200", *H, f"{BASE}/kanban/tickets/team")
# Kanban tickets are created via webhook, not directly via API — GET returns 200 with empty list
curl_raw("GET /kanban/tickets/:bad → 404", "404", *H, f"{BASE}/kanban/tickets/00000000-0000-0000-0000-000000000000")
print()

print("5. Conversations")
curl_raw("GET /conversations", "200", *H, f"{BASE}/conversations")
curl_raw("GET /conversations/:bad → 404", "404", *H, f"{BASE}/conversations/00000000-0000-0000-0000-000000000000")
curl_raw("GET /conversations/:bad/messages → 404", "404", *H, f"{BASE}/conversations/00000000-0000-0000-0000-000000000000/messages")
print()

print("6. Agents")
curl_raw("GET /agents", "200", *H, f"{BASE}/agents")
curl_raw("GET /agents/numbers", "200", *H, f"{BASE}/agents/numbers")
agent = curl_json("POST /agents create", "201", "-X", "POST", *H, *CT,
                  "-d", json.dumps({"name": "Smoke Agent", "persona": "Friendly helper"}),
                  f"{BASE}/agents")
AID = agent.get("id")
if AID:
    curl_raw(f"GET /agents/{AID[:8]}…", "200", *H, f"{BASE}/agents/{AID}")
    curl_raw("GET .../versions", "200", *H, f"{BASE}/agents/{AID}/versions")
    curl_raw("GET .../knowledge", "200", *H, f"{BASE}/agents/{AID}/knowledge")
    curl_raw("PATCH .../name", "200", "-X", "PATCH", *H, *CT,
             "-d", '{"name":"Updated Agent"}', f"{BASE}/agents/{AID}")
    curl_raw("POST .../publish", "201", "-X", "POST", *H, f"{BASE}/agents/{AID}/publish")
    curl_raw("POST .../sandbox", "201", "-X", "POST", *H, *CT,
             "-d", '{"message":"hello"}', f"{BASE}/agents/{AID}/sandbox")
    curl_raw("POST .../archive", "201", "-X", "POST", *H, f"{BASE}/agents/{AID}/archive")
print()

print("7. Templates")
curl_raw("GET /templates", "200", *H, f"{BASE}/templates")
tpl = curl_json("POST /templates create", "201", "-X", "POST", *H, *CT,
                "-d", json.dumps({"kind": "canned_reply", "name": "Smoke Reply",
                                  "body": "Hi {{1}}!",
                                  "variables": [{"position": 1, "label": "name", "example": None}]}),
                f"{BASE}/templates")
TPID = tpl.get("id")
if TPID:
    curl_raw(f"GET /templates/{TPID[:8]}…", "200", *H, f"{BASE}/templates/{TPID}")
    curl_raw("POST .../preview", "201", "-X", "POST", *H, *CT,
             "-d", json.dumps({"values": ["World"]}), f"{BASE}/templates/{TPID}/preview")
    curl_raw("PATCH ...", "200", "-X", "PATCH", *H, *CT,
             "-d", '{"body":"Hello {{1}}!"}', f"{BASE}/templates/{TPID}")
    curl_raw("DELETE ...", "200", "-X", "DELETE", *H, f"{BASE}/templates/{TPID}")
    curl_raw("GET ... (deleted)", "404", *H, f"{BASE}/templates/{TPID}")
print()

print("8. Metrics")
FR = time.strftime("%Y-%m-%d", time.gmtime(time.time() - 7 * 86400))
TO = time.strftime("%Y-%m-%d")
QS = f"?from={FR}&to={TO}"
curl_raw("GET /metrics/resolution-rate", "200", *H, f"{BASE}/metrics/resolution-rate{QS}")
curl_raw("GET /metrics/escalation-breakdown", "200", *H, f"{BASE}/metrics/escalation-breakdown{QS}")
curl_raw("GET /metrics/knowledge-gaps", "200", *H, f"{BASE}/metrics/knowledge-gaps{QS}")
print()

print("9. Billing")
curl_raw("GET /billing/plans", "200", *H, f"{BASE}/billing/plans")
curl_raw("GET /billing/subscription", "200", *H, f"{BASE}/billing/subscription")
curl_raw("GET /billing/usage", "200", *H, f"{BASE}/billing/usage")
curl_raw("POST /billing/checkout 400", "400", "-X", "POST", *H, *CT,
         "-d", "{}", f"{BASE}/billing/checkout")
curl_raw("POST /billing/portal 400", "400", "-X", "POST", *H, *CT,
         "-d", "{}", f"{BASE}/billing/portal")
print()

print("10. Audit log")
curl_raw("GET /audit-log", "200", *H, f"{BASE}/audit-log")
print()

print("11. Data exports")
curl_raw("GET /data-exports", "200", *H, f"{BASE}/data-exports")
curl_raw("GET /data-exports/:bad → 404", "404", *H, f"{BASE}/data-exports/00000000-0000-0000-0000-000000000000")
curl_raw("GET .../download → 404", "404", *H, f"{BASE}/data-exports/00000000-0000-0000-0000-000000000000/download")
print()

print("12. Customer consent")
curl_raw("GET /customers/consent?phone=…", "200", *H, f"{BASE}/customers/consent?phone=%2B1555000001")
curl_raw("PUT /customers/consent opt-out", "200", "-X", "PUT", *H, *CT,
         "-d", json.dumps({"phone": "+1555000001", "optedOut": True}), f"{BASE}/customers/consent")
curl_raw("PUT /customers/consent opt-in", "200", "-X", "PUT", *H, *CT,
         "-d", json.dumps({"phone": "+1555000001", "optedOut": False}), f"{BASE}/customers/consent")
print()

print("13. Outbound webhooks")
curl_raw("GET /outbound/webhooks", "200", *H, f"{BASE}/outbound/webhooks")
wh = curl_json("POST /outbound/webhooks create", "201", "-X", "POST", *H, *CT,
               "-d", json.dumps({"url": "https://httpbin.org/post", "events": ["ticket.created"]}),
               f"{BASE}/outbound/webhooks")
WHID = wh.get("id")
if WHID:
    curl_raw("DELETE ...", "200", "-X", "DELETE", *H, f"{BASE}/outbound/webhooks/{WHID}")
curl_raw("DELETE bad id → 404", "404", "-X", "DELETE", *H,
         f"{BASE}/outbound/webhooks/00000000-0000-0000-0000-000000000000")
print()

print("14. Notifications")
curl_raw("GET /notifications", "200", *H, f"{BASE}/notifications")
curl_raw("GET /notifications/unread-count", "200", *H, f"{BASE}/notifications/unread-count")
curl_raw("POST /notifications/read-all", "201", "-X", "POST", *H, f"{BASE}/notifications/read-all")
print()

print("15. Knowledge base")
curl_raw("GET /knowledge-base/documents", "200", *H, f"{BASE}/knowledge-base/documents")
curl_raw("GET /knowledge-base/documents/:bad → 404", "404", *H,
         f"{BASE}/knowledge-base/documents/00000000-0000-0000-0000-000000000000")
print()

print("16. SSE stream")
curl_raw("GET /kanban/tickets/stream", "200", *H, "-H", "Accept: text/event-stream",
         "--max-time", "1", f"{BASE}/kanban/tickets/stream")
print()

# ══════════════════════════════════════════════════════════════════
print("=" * 44)
print(f" Results: {PASS} passed / {FAIL} failed / {TOTAL} total")
print("=" * 44)
sys.exit(0 if FAIL == 0 else 1)
