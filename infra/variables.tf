variable "account_id" {
  type        = string
  description = "Cloudflare account ID"
}

variable "hostname" {
  type        = string
  description = "Домен трекера, напр. timer.example.com (зона має бути в цьому акаунті). Має збігатися з routes у wrangler.jsonc."
}

variable "owner_email" {
  type        = string
  description = "Пошта, якій Access дозволяє вхід у веб-інтерфейс"
}

variable "worker_name" {
  type    = string
  default = "timer"
}

variable "d1_name" {
  type    = string
  default = "timer"
}

variable "service_token_duration" {
  type        = string
  default     = "8760h"
  description = "Термін дії service token для хуків і MCP (8760h = рік)"
}

variable "access_org_name" {
  type        = string
  description = "Назва організації Zero Trust як є (Zero Trust → Settings → Custom pages / або GET /access/organizations → name)"
}

variable "access_auth_domain" {
  type        = string
  description = "Team domain, напр. kopachev.cloudflareaccess.com — має збігатися з ACCESS_TEAM_DOMAIN у wrangler.jsonc"
}

variable "oauth_redirect_uris" {
  type        = list(string)
  description = "Дозволені redirect URI для OAuth-клієнтів MCP (Managed OAuth в Access)"
  default = [
    "https://claude.ai/api/mcp/auth_callback",
    "https://claude.com/api/mcp/auth_callback",
  ]
}
