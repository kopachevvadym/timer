# timer-tracking

Перед кожним вашим повідомленням додає агенту коротке нагадування: запустити таймер задачі в
[timer](https://timer.kopachev.life) (`timer_task_start` / `timer_task_add start=true`) з `repo` і `cwd`,
а після роботи — `timer_task_done`.

Плагін не ходить у мережу і не містить ключів. Потрібен підключений конектор timer
(`https://timer.kopachev.life/mcp`).
