output "d1_database_id" {
  description = "→ wrangler.jsonc: d1_databases[0].database_id"
  value       = cloudflare_d1_database.timer.id
}

output "access_aud" {
  description = "→ wrangler.jsonc: vars.ACCESS_AUD"
  value       = cloudflare_zero_trust_access_application.timer.aud
}

output "service_token_client_id" {
  description = "→ змінна середовища TIMER_CF_ID для Claude Code"
  value       = cloudflare_zero_trust_access_service_token.claude_code.client_id
}

output "service_token_client_secret" {
  description = "→ змінна середовища TIMER_CF_SECRET для Claude Code (terraform output -raw service_token_client_secret)"
  value       = cloudflare_zero_trust_access_service_token.claude_code.client_secret
  sensitive   = true
}

output "claude_ai_client_id" {
  description = "→ конектор claude.ai: заголовок CF-Access-Client-Id"
  value       = cloudflare_zero_trust_access_service_token.claude_ai.client_id
}

output "claude_ai_client_secret" {
  description = "→ конектор claude.ai: заголовок CF-Access-Client-Secret"
  value       = cloudflare_zero_trust_access_service_token.claude_ai.client_secret
  sensitive   = true
}
