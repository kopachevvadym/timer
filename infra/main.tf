# Поділ відповідальності:
#   Terraform — ресурси: база D1, Worker як ресурс, Cloudflare Access.
#   Wrangler  — код і все, що деплоїться з ним: версії, маршрут домену, cron, міграції D1.
# Так радить документація Cloudflare: https://developers.cloudflare.com/workers/platform/infrastructure-as-code

resource "cloudflare_d1_database" "timer" {
  account_id = var.account_id
  name       = var.d1_name

  # Читаємо одразу після запису (хук → звіт), тому без read replicas.
  read_replication = {
    mode = "disabled"
  }
}

resource "cloudflare_worker" "timer" {
  account_id = var.account_id
  name       = var.worker_name

  # Лише власний домен під Access: workers.dev і preview-URL обійшли б захист.
  subdomain = {
    enabled          = false
    previews_enabled = false
  }

  observability = {
    enabled = true
  }
}

# ───────────── Cloudflare Access ─────────────

# Один токен для HTTP-хуків і MCP-сервера в Claude Code.
resource "cloudflare_zero_trust_access_service_token" "claude_code" {
  account_id = var.account_id
  name       = "timer: Claude Code"
  duration   = var.service_token_duration
}

resource "cloudflare_zero_trust_access_policy" "owner" {
  account_id = var.account_id
  name       = "timer: owner"
  decision   = "allow"
  include = [{
    email = { email = var.owner_email }
  }]
}

# Окремий токен для конектора claude.ai: його можна відкликати, не зачіпаючи хуки.
resource "cloudflare_zero_trust_access_service_token" "claude_ai" {
  account_id = var.account_id
  name       = "timer: claude.ai connector"
  duration   = var.service_token_duration
}

resource "cloudflare_zero_trust_access_policy" "claude_code" {
  account_id = var.account_id
  name       = "timer: Claude Code service token"
  decision   = "non_identity"
  include = [
    { service_token = { token_id = cloudflare_zero_trust_access_service_token.claude_code.id } },
    { service_token = { token_id = cloudflare_zero_trust_access_service_token.claude_ai.id } },
  ]
}

resource "cloudflare_zero_trust_access_application" "timer" {
  account_id       = var.account_id
  name             = "Timer"
  type             = "self_hosted"
  domain           = var.hostname
  session_duration = "168h"

  destinations = [{
    type = "public"
    uri  = var.hostname
  }]

  app_launcher_visible = false

  # Захист від CSRF і крадіжки cookie (Worker додатково відхиляє крос-сайтові запити).
  same_site_cookie_attribute = "strict"
  http_only_cookie_attribute = true

  policies = [
    { id = cloudflare_zero_trust_access_policy.claude_code.id, precedence = 1 },
    { id = cloudflare_zero_trust_access_policy.owner.id, precedence = 2 },
  ]

  # Managed OAuth: MCP-клієнти (конектор claude.ai) входять через OAuth, де сервером
  # авторизації є сам Access. Вхід — та сама політика owner (код на пошту), Worker отримує
  # звичайний Cf-Access-Jwt-Assertion. Хуки й Claude Code далі ходять із service token.
  oauth_configuration = {
    enabled = true
    dynamic_client_registration = {
      enabled                = true
      allowed_uris           = var.oauth_redirect_uris
      allow_any_on_localhost = false
      allow_any_on_loopback  = false
    }
    grant = {
      access_token_lifetime = "15m"
      session_duration      = "336h"
    }
  }
}
