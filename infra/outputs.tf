output "d1_database_id" {
  description = "→ wrangler.jsonc: d1_databases[0].database_id"
  value       = cloudflare_d1_database.timer.id
}

output "oauth_kv_id" {
  description = "→ wrangler.jsonc: kv_namespaces[0].id (OAUTH_KV)"
  value       = cloudflare_workers_kv_namespace.oauth.id
}
