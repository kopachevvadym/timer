terraform {
  required_version = ">= 1.6"

  required_providers {
    cloudflare = {
      source  = "cloudflare/cloudflare"
      version = "~> 5.28"
    }
  }

  # State містить client_secret service token. Тримайте його в зашифрованому
  # віддаленому backend (R2 / S3 / Terraform Cloud), а не в git.
  # backend "s3" { ... }
}

# Токен: змінна середовища CLOUDFLARE_API_TOKEN.
# Потрібні права: Account → D1 Edit, Workers Scripts Edit, Access: Apps and Policies Edit,
# Access: Service Tokens Edit, Access: Organizations, Identity Providers, and Groups Edit (вигляд сторінки входу).
provider "cloudflare" {}
