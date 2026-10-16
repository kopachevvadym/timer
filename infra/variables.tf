variable "account_id" {
  type        = string
  description = "Cloudflare account ID"
}

variable "worker_name" {
  type    = string
  default = "timer"
}

variable "d1_name" {
  type    = string
  default = "timer"
}
