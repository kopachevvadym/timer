# ───────────── Сторінка входу ─────────────
# Вхід лишається на Cloudflare Access (код на пошту) — тут лише його вигляд у стилі timer.
# Access дає змінити фон, колір тексту, логотип, заголовок і підпис; кнопки й поле пошти малює сам Cloudflare.
# Логотипу немає свідомо: його URL мав би відкриватися без входу, а для цього довелося б
# робити виняток (bypass) в Access. Не варто послаблювати захист заради картинки.

# Організація Zero Trust створюється разом з акаунтом, тому її імпортуємо, а не створюємо.
import {
  to = cloudflare_zero_trust_organization.this
  id = var.account_id
}

resource "cloudflare_zero_trust_organization" "this" {
  account_id = var.account_id
  # Явно, щоб Terraform не обнулив наявні значення.
  name        = var.access_org_name
  auth_domain = var.access_auth_domain

  login_design = {
    background_color = "#F6F6F3"
    text_color       = "#111110"
    header_text      = "timer"
    footer_text      = "Особистий трекер часу AI-агентів · код для входу прийде на пошту"
  }
}
