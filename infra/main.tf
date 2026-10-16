# Поділ відповідальності:
#   Terraform — ресурси: база D1, Worker як ресурс, KV для OAuth.
#   Wrangler  — код і все, що деплоїться з ним: версії, маршрут домену, cron, міграції D1, секрети.
# Так радить документація Cloudflare: https://developers.cloudflare.com/workers/platform/infrastructure-as-code
#
# Доступ: вхід через GitHub і API-ключі в самому Worker (src/users.ts). Cloudflare Access не використовується:
# сервіс публічний, а безкоштовний Zero Trust обмежений кількістю користувачів.

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

  # Лише власний домен: OAuth знає одну адресу (PUBLIC_URL), workers.dev і preview-URL не потрібні.
  subdomain = {
    enabled          = false
    previews_enabled = false
  }

  observability = {
    enabled = true
  }
}

# Сховище OAuth для MCP (клієнти, гранти, токени — лише хеші). Прив'язка OAUTH_KV у wrangler.jsonc.
resource "cloudflare_workers_kv_namespace" "oauth" {
  account_id = var.account_id
  title      = "timer-oauth"
}
