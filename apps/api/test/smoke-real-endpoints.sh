#!/usr/bin/env bash
# Hits every endpoint on the running API server at localhost:4000.
# Generates real HS256 JWTs locally — no Supabase needed.
set -euo pipefail

BASE="http://localhost:4000"
SECRET="local-dev-jwt-secret-do-not-use-in-prod-at-least-32-chars"
USER_ID=$(cat /proc/sys/kernel/random/uuid 2>/dev/null || uuidgen)
USER_ID2=$(cat /proc/sys/kernel/random/uuid 2>/dev/null || uuidgen)
PASS=0
FAIL=0
TOTAL=0

# --- helpers ---
sign() {
  local sub="$1" role="${2:-authenticated}" tenant="$3" app_role="${4:-}" exp_offset="${5:-3600}"
  local now=$(date +%s)
  local exp=$((now + exp_offset))
  local payload="{\"sub\":\"$sub\",\"role\":\"$role\",\"app_metadata\":{\"tenant_id\":\"$tenant\""
  if [ -n "$app_role" ]; then
    payload="$payload,\"app_role\":\"$app_role\""
  fi
  payload="$payload},\"exp\":$exp}"
  echo -n "$payload" | jq -c '.' 2>/dev/null | \
    openssl dgst -sha256 -hmac "$SECRET" -binary | base64 | tr '+/' '-_' | tr -d '='
}

# Build JWT manually (header.payload.signature)
make_jwt() {
  local header=$(echo -n '{"alg":"HS256","typ":"JWT"}' | base64 | tr '+/' '-_' | tr -d '=')
  local payload="$1"
  local body=$(echo -n "$payload" | base64 | tr '+/' '-_' | tr -d '=')
  local sig=$(echo -n "${header}.${body}" | openssl dgst -sha256 -hmac "$SECRET" -binary | base64 | tr '+/' '-_' | tr -d '=')
  echo "${header}.${body}.${sig}"
}

admin_jwt() {
  local now=$(date +%s)
  make_jwt "{\"sub\":\"$USER_ID\",\"role\":\"authenticated\",\"app_metadata\":{\"tenant_id\":\"$TENANT_ID\",\"app_role\":\"admin\"},\"exp\":$((now + 3600))}"
}

agent_jwt() {
  local now=$(date +%s)
  make_jwt "{\"sub\":\"$USER_ID2\",\"role\":\"authenticated\",\"app_metadata\":{\"tenant_id\":\"$TENANT_ID\",\"app_role\":\"agent\"},\"exp\":$((now + 3600))}"
}

expired_jwt() {
  local now=$(date +%s)
  make_jwt "{\"sub\":\"$USER_ID\",\"role\":\"authenticated\",\"app_metadata\":{\"tenant_id\":\"$TENANT_ID\",\"app_role\":\"admin\"},\"exp\":$((now - 3600))}"
}

fresh_signup_jwt() {
  local now=$(date +%s)
  make_jwt "{\"sub\":\"$USER_ID\",\"exp\":$((now + 3600))}"
}

# $1 = description, $2 = expected status, $3+ = curl args
hit() {
  local desc="$1" expect="$2"
  shift 2
  TOTAL=$((TOTAL + 1))
  local res
  res=$(curl -s -o /dev/null -w "%{http_code}" "$@" 2>/dev/null || echo "000")
  if [ "$res" = "$expect" ]; then
    echo "  ✓ $desc → $res"
    PASS=$((PASS + 1))
  else
    echo "  ✗ $desc → $res (expected $expect)"
    FAIL=$((FAIL + 1))
  fi
}

FRESH=$(fresh_signup_jwt)

echo "============================================"
echo " Real endpoint smoke test — localhost:4000"
echo "============================================"
echo ""

# ── 1. PUBLIC ──────────────────────────────────────────────────────
echo "1. Public"
hit "GET /health" 200 "$BASE/health"
echo ""

# ── 2. AUTH GUARD ─────────────────────────────────────────────────
echo "2. Auth guard"
hit "missing token → 401" 401 "$BASE/onboarding/tenant"
hit "malformed token → 401" 401 -H "Authorization: Bearer not-a-jwt" "$BASE/onboarding/tenant"
hit "bad bearer scheme → 401" 401 -H "Authorization: Basic foo" "$BASE/onboarding/tenant"
echo ""

# ── 3. ONBOARDING SIGNUP ──────────────────────────────────────────
# NOTE: this env has TENANT_PROVISIONING_PROVIDER=supabase, so a *successful*
# signup call would hit the real Supabase Admin API to write claims onto the
# JWT's `sub` — which requires a real Supabase Auth user backing that sub.
# Forged local JWTs can't satisfy that, so the success path isn't exercised
# here; only the validation branches (401/400/409) are. TENANT_ID instead
# points at an already-provisioned tenant read from the DB, so every
# tenant-scoped route below gets a tenant_id that genuinely exists.
echo "3. Onboarding signup"
hit "POST /onboarding/signup — 401 no token" 401 -X POST "$BASE/onboarding/signup" -H "Content-Type: application/json" -d '{}'
hit "POST /onboarding/signup — 400 empty body" 400 -X POST "$BASE/onboarding/signup" -H "Authorization: Bearer $FRESH" -H "Content-Type: application/json" -d '{}'

TENANT_ID="${SMOKE_TENANT_ID:?Set SMOKE_TENANT_ID to an existing tenants.id before running}"
echo "  Tenant: $TENANT_ID (pre-existing, from DB)"

ADMIN=$(admin_jwt)
AGENT=$(agent_jwt)
EXPIRED=$(expired_jwt)

hit "expired token → 401" 401 -H "Authorization: Bearer $EXPIRED" "$BASE/onboarding/tenant"
hit "POST /onboarding/signup — 409 already has tenant" 409 -X POST "$BASE/onboarding/signup" -H "Authorization: Bearer $ADMIN" -H "Content-Type: application/json" -d '{"tenantName":"X"}'
echo ""

# ── 4. TENANT ─────────────────────────────────────────────────────
echo "4. Tenant"
hit "GET /onboarding/tenant — admin" 200 -H "Authorization: Bearer $ADMIN" "$BASE/onboarding/tenant"
hit "GET /onboarding/tenant — agent" 200 -H "Authorization: Bearer $AGENT" "$BASE/onboarding/tenant"
echo ""

# ── 5. TENANT POLICY (admin-only) ────────────────────────────────
echo "5. Tenant policy"
hit "GET /onboarding/tenant-policy — admin" 200 -H "Authorization: Bearer $ADMIN" "$BASE/onboarding/tenant-policy"
hit "GET /onboarding/tenant-policy — agent 403" 403 -H "Authorization: Bearer $AGENT" "$BASE/onboarding/tenant-policy"
hit "PATCH /onboarding/tenant-policy — admin" 200 -X PATCH -H "Authorization: Bearer $ADMIN" -H "Content-Type: application/json" -d '{"stuckTicketThresholdMinutes":30}' "$BASE/onboarding/tenant-policy"
hit "PATCH /onboarding/tenant-policy — agent 403" 403 -X PATCH -H "Authorization: Bearer $AGENT" -H "Content-Type: application/json" -d '{}' "$BASE/onboarding/tenant-policy"
echo ""

# ── 6. TEAM (admin-only) ─────────────────────────────────────────
echo "6. Team"
hit "GET /onboarding/team — admin" 200 -H "Authorization: Bearer $ADMIN" "$BASE/onboarding/team"
hit "GET /onboarding/team — agent 403" 403 -H "Authorization: Bearer $AGENT" "$BASE/onboarding/team"
echo ""

# ── 7. TEAM INVITE (admin-only) ──────────────────────────────────
echo "7. Team invite"
hit "POST /onboarding/team/invite — admin" 201 -X POST -H "Authorization: Bearer $ADMIN" -H "Content-Type: application/json" -d '{"email":"test@example.com","appRole":"agent"}' "$BASE/onboarding/team/invite"
hit "POST /onboarding/team/invite — agent 403" 403 -X POST -H "Authorization: Bearer $AGENT" -H "Content-Type: application/json" -d '{"email":"x@x.com","appRole":"agent"}' "$BASE/onboarding/team/invite"
hit "POST /onboarding/team/invite — 400 bad email" 400 -X POST -H "Authorization: Bearer $ADMIN" -H "Content-Type: application/json" -d '{"email":"not-email","appRole":"agent"}' "$BASE/onboarding/team/invite"
echo ""

# ── 8. KANBAN (both roles) ───────────────────────────────────────
echo "8. Kanban"
hit "GET /kanban/tickets — admin" 200 -H "Authorization: Bearer $ADMIN" "$BASE/kanban/tickets"
hit "GET /kanban/tickets — agent" 200 -H "Authorization: Bearer $AGENT" "$BASE/kanban/tickets"
hit "GET /kanban/tickets/config" 200 -H "Authorization: Bearer $ADMIN" "$BASE/kanban/tickets/config"
hit "GET /kanban/tickets/team" 200 -H "Authorization: Bearer $ADMIN" "$BASE/kanban/tickets/team"
FAKE_ID=$(uuidgen)
hit "GET /kanban/tickets/:id — 404" 404 -H "Authorization: Bearer $ADMIN" "$BASE/kanban/tickets/$FAKE_ID"
hit "POST /kanban/tickets/:id/claim — 404" 404 -X POST -H "Authorization: Bearer $ADMIN" "$BASE/kanban/tickets/$FAKE_ID/claim"
hit "POST /kanban/tickets/:id/resolve — 404" 404 -X POST -H "Authorization: Bearer $ADMIN" "$BASE/kanban/tickets/$FAKE_ID/resolve"
hit "POST /kanban/tickets/:id/assign — 404" 404 -X POST -H "Authorization: Bearer $ADMIN" -H "Content-Type: application/json" -d '{"assigneeId":null}' "$BASE/kanban/tickets/$FAKE_ID/assign"
echo ""

# ── 9. INBOX / CONVERSATIONS (both roles) ─────────────────────────
echo "9. Inbox"
hit "GET /conversations — admin" 200 -H "Authorization: Bearer $ADMIN" "$BASE/conversations"
hit "GET /conversations — agent" 200 -H "Authorization: Bearer $AGENT" "$BASE/conversations"
hit "GET /conversations/:id — 404" 404 -H "Authorization: Bearer $ADMIN" "$BASE/conversations/$FAKE_ID"
hit "GET /conversations/:id/messages — 404" 404 -H "Authorization: Bearer $ADMIN" "$BASE/conversations/$FAKE_ID/messages"
hit "POST /conversations/:id/messages — 400 no body" 400 -X POST -H "Authorization: Bearer $ADMIN" -H "Content-Type: application/json" -d '{}' "$BASE/conversations/$FAKE_ID/messages"
hit "POST /conversations/:id/handover — 404" 404 -X POST -H "Authorization: Bearer $ADMIN" "$BASE/conversations/$FAKE_ID/handover"
hit "POST /conversations/:id/handover/return — 404" 404 -X POST -H "Authorization: Bearer $ADMIN" "$BASE/conversations/$FAKE_ID/handover/return"
echo ""

# ── 10. AGENTS (admin-only) ──────────────────────────────────────
echo "10. Agents"
hit "GET /agents — admin" 200 -H "Authorization: Bearer $ADMIN" "$BASE/agents"
hit "GET /agents — agent 403" 403 -H "Authorization: Bearer $AGENT" "$BASE/agents"
hit "GET /agents/numbers — admin" 200 -H "Authorization: Bearer $ADMIN" "$BASE/agents/numbers"

AGENT_RES=$(curl -s -X POST "$BASE/agents" -H "Authorization: Bearer $ADMIN" -H "Content-Type: application/json" -d '{"name":"Smoke Test Agent"}')
AGENT_ID=$(echo "$AGENT_RES" | jq -r '.id // empty')
if [ -n "$AGENT_ID" ]; then
  hit "GET /agents/:id" 200 -H "Authorization: Bearer $ADMIN" "$BASE/agents/$AGENT_ID"
  hit "GET /agents/:id/versions" 200 -H "Authorization: Bearer $ADMIN" "$BASE/agents/$AGENT_ID/versions"
  hit "GET /agents/:id/knowledge" 200 -H "Authorization: Bearer $ADMIN" "$BASE/agents/$AGENT_ID/knowledge"
  hit "PATCH /agents/:id" 200 -X PATCH -H "Authorization: Bearer $ADMIN" -H "Content-Type: application/json" -d '{"name":"Updated Smoke Agent"}' "$BASE/agents/$AGENT_ID"
  hit "POST /agents/:id/publish" 201 -X POST -H "Authorization: Bearer $ADMIN" "$BASE/agents/$AGENT_ID/publish"
  hit "POST /agents/:id/sandbox" 201 -X POST -H "Authorization: Bearer $ADMIN" -H "Content-Type: application/json" -d '{"message":"hello"}' "$BASE/agents/$AGENT_ID/sandbox"
  hit "POST /agents/:id/archive" 201 -X POST -H "Authorization: Bearer $ADMIN" "$BASE/agents/$AGENT_ID/archive"
  hit "GET /agents/:id — agent 403" 403 -H "Authorization: Bearer $AGENT" "$BASE/agents/$AGENT_ID"
else
  echo "  ⚠ could not create agent, skipping sub-route tests"
fi
echo ""

# ── 11. TEMPLATES ────────────────────────────────────────────────
echo "11. Templates"
hit "GET /templates — admin" 200 -H "Authorization: Bearer $ADMIN" "$BASE/templates"
hit "GET /templates — agent" 200 -H "Authorization: Bearer $AGENT" "$BASE/templates"
TPL_RES=$(curl -s -X POST "$BASE/templates" -H "Authorization: Bearer $ADMIN" -H "Content-Type: application/json" -d '{"kind":"canned_reply","name":"Smoke Test Reply","body":"Hello {{1}}!","variables":[{"position":1,"label":"name","example":null}]}')
TPL_ID=$(echo "$TPL_RES" | jq -r '.id // empty')
if [ -n "$TPL_ID" ]; then
  hit "GET /templates/:id" 200 -H "Authorization: Bearer $ADMIN" "$BASE/templates/$TPL_ID"
  hit "POST /templates/:id/preview" 201 -X POST -H "Authorization: Bearer $ADMIN" -H "Content-Type: application/json" -d '{"values":["World"]}' "$BASE/templates/$TPL_ID/preview"
  hit "PATCH /templates/:id" 200 -X PATCH -H "Authorization: Bearer $ADMIN" -H "Content-Type: application/json" -d '{"body":"Hi {{1}}!"}' "$BASE/templates/$TPL_ID"
  hit "DELETE /templates/:id" 200 -X DELETE -H "Authorization: Bearer $ADMIN" "$BASE/templates/$TPL_ID"
  hit "GET /templates/:id — 404 after delete" 404 -H "Authorization: Bearer $ADMIN" "$BASE/templates/$TPL_ID"
else
  echo "  ⚠ could not create template, skipping sub-route tests"
fi
hit "POST /templates — agent 403" 403 -X POST -H "Authorization: Bearer $AGENT" -H "Content-Type: application/json" -d '{"kind":"canned_reply","name":"No","body":"Hi"}' "$BASE/templates"
echo ""

# ── 12. METRICS (admin-only) ─────────────────────────────────────
echo "12. Metrics"
FROM=$(date -d '7 days ago' +%Y-%m-%d 2>/dev/null || date -v-7d +%Y-%m-%d)
TO=$(date +%Y-%m-%d)
hit "GET /metrics/resolution-rate — admin" 200 -H "Authorization: Bearer $ADMIN" "$BASE/metrics/resolution-rate?from=$FROM&to=$TO"
hit "GET /metrics/resolution-rate — agent 403" 403 -H "Authorization: Bearer $AGENT" "$BASE/metrics/resolution-rate?from=$FROM&to=$TO"
hit "GET /metrics/escalation-breakdown — admin" 200 -H "Authorization: Bearer $ADMIN" "$BASE/metrics/escalation-breakdown?from=$FROM&to=$TO"
hit "GET /metrics/knowledge-gaps — admin" 200 -H "Authorization: Bearer $ADMIN" "$BASE/metrics/knowledge-gaps?from=$FROM&to=$TO"
echo ""

# ── 13. BILLING (admin-only) ─────────────────────────────────────
echo "13. Billing"
hit "GET /billing/plans — admin" 200 -H "Authorization: Bearer $ADMIN" "$BASE/billing/plans"
hit "GET /billing/plans — agent 403" 403 -H "Authorization: Bearer $AGENT" "$BASE/billing/plans"
hit "GET /billing/subscription — admin" 200 -H "Authorization: Bearer $ADMIN" "$BASE/billing/subscription"
hit "GET /billing/usage — admin" 200 -H "Authorization: Bearer $ADMIN" "$BASE/billing/usage"
hit "POST /billing/checkout — 400 no planId" 400 -X POST -H "Authorization: Bearer $ADMIN" -H "Content-Type: application/json" -d '{}' "$BASE/billing/checkout"
hit "POST /billing/portal — 400 no returnUrl" 400 -X POST -H "Authorization: Bearer $ADMIN" -H "Content-Type: application/json" -d '{}' "$BASE/billing/portal"
echo ""

# ── 14. AUDIT LOG (admin-only) ───────────────────────────────────
echo "14. Audit log"
hit "GET /audit-log — admin" 200 -H "Authorization: Bearer $ADMIN" "$BASE/audit-log"
hit "GET /audit-log — agent 403" 403 -H "Authorization: Bearer $AGENT" "$BASE/audit-log"
echo ""

# ── 15. DATA EXPORTS (admin-only) ────────────────────────────────
echo "15. Data exports"
hit "GET /data-exports — admin" 200 -H "Authorization: Bearer $ADMIN" "$BASE/data-exports"
hit "GET /data-exports — agent 403" 403 -H "Authorization: Bearer $AGENT" "$BASE/data-exports"
hit "GET /data-exports/:id — 404" 404 -H "Authorization: Bearer $ADMIN" "$BASE/data-exports/$FAKE_ID"
hit "GET /data-exports/:id/download — 404" 404 -H "Authorization: Bearer $ADMIN" "$BASE/data-exports/$FAKE_ID/download"
echo ""

# ── 16. CUSTOMER CONSENT (admin-only) ────────────────────────────
echo "16. Customer consent"
hit "GET /customers/consent — admin" 200 -H "Authorization: Bearer $ADMIN" "$BASE/customers/consent?phone=%2B1234567890"
hit "GET /customers/consent — agent 403" 403 -H "Authorization: Bearer $AGENT" "$BASE/customers/consent?phone=%2B1234567890"
hit "PUT /customers/consent — admin opt-out" 200 -X PUT -H "Authorization: Bearer $ADMIN" -H "Content-Type: application/json" -d '{"phone":"+1234567890","optedOut":true}' "$BASE/customers/consent"
hit "PUT /customers/consent — admin opt-in" 200 -X PUT -H "Authorization: Bearer $ADMIN" -H "Content-Type: application/json" -d '{"phone":"+1234567890","optedOut":false}' "$BASE/customers/consent"
echo ""

# ── 17. OUTBOUND WEBHOOKS (admin-only) ───────────────────────────
echo "17. Outbound webhooks"
hit "GET /outbound/webhooks — admin" 200 -H "Authorization: Bearer $ADMIN" "$BASE/outbound/webhooks"
hit "GET /outbound/webhooks — agent 403" 403 -H "Authorization: Bearer $AGENT" "$BASE/outbound/webhooks"
WH_RES=$(curl -s -X POST "$BASE/outbound/webhooks" -H "Authorization: Bearer $ADMIN" -H "Content-Type: application/json" -d '{"url":"https://httpbin.org/post","events":["ticket.escalated"]}')
WH_ID=$(echo "$WH_RES" | jq -r '.id // empty')
if [ -n "$WH_ID" ]; then
  hit "DELETE /outbound/webhooks/:id" 200 -X DELETE -H "Authorization: Bearer $ADMIN" "$BASE/outbound/webhooks/$WH_ID"
fi
hit "DELETE /outbound/webhooks/:id — 404" 404 -X DELETE -H "Authorization: Bearer $ADMIN" "$BASE/outbound/webhooks/$FAKE_ID"
echo ""

# ── 18. NOTIFICATIONS (both roles) ───────────────────────────────
echo "18. Notifications"
hit "GET /notifications — admin" 200 -H "Authorization: Bearer $ADMIN" "$BASE/notifications"
hit "GET /notifications — agent" 200 -H "Authorization: Bearer $AGENT" "$BASE/notifications"
hit "GET /notifications/unread-count" 200 -H "Authorization: Bearer $ADMIN" "$BASE/notifications/unread-count"
hit "POST /notifications/:id/read — 404" 404 -X POST -H "Authorization: Bearer $ADMIN" "$BASE/notifications/$FAKE_ID/read"
hit "POST /notifications/read-all" 201 -X POST -H "Authorization: Bearer $ADMIN" "$BASE/notifications/read-all"
echo ""

# ── 19. KNOWLEDGE BASE (admin-only) ──────────────────────────────
echo "19. Knowledge base"
hit "GET /knowledge-base/documents — admin" 200 -H "Authorization: Bearer $ADMIN" "$BASE/knowledge-base/documents"
hit "GET /knowledge-base/documents — agent 403" 403 -H "Authorization: Bearer $AGENT" "$BASE/knowledge-base/documents"
hit "GET /knowledge-base/documents/:id — 404" 404 -H "Authorization: Bearer $ADMIN" "$BASE/knowledge-base/documents/$FAKE_ID"
hit "DELETE /knowledge-base/documents/:id — 404" 404 -X DELETE -H "Authorization: Bearer $ADMIN" "$BASE/knowledge-base/documents/$FAKE_ID"
echo ""

# ── 20. TENANT LIFECYCLE (admin-only) ────────────────────────────
echo "20. Tenant lifecycle"
hit "GET /onboarding/tenant/closure — admin" 200 -H "Authorization: Bearer $ADMIN" "$BASE/onboarding/tenant/closure"
hit "GET /onboarding/tenant/closure — agent 403" 403 -H "Authorization: Bearer $AGENT" "$BASE/onboarding/tenant/closure"
echo ""

# ── 21. SSE stream (can't fully test, just verify it opens) ──────
echo "21. SSE"
hit "GET /kanban/tickets/stream — 200 (SSE)" 200 -H "Authorization: Bearer $ADMIN" -H "Accept: text/event-stream" --max-time 1 "$BASE/kanban/tickets/stream" || true
echo ""

# ══════════════════════════════════════════════════════════════════
echo "============================================"
echo " Results: $PASS passed / $FAIL failed / $TOTAL total"
echo "============================================"
[ "$FAIL" -eq 0 ] && exit 0 || exit 1
