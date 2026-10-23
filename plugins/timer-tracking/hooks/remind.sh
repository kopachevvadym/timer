#!/usr/bin/env bash
# Перед кожним промптом нагадує агенту про облік часу в timer. Мережі не потребує: лише додає контекст.
cat <<'JSON'
{"hookSpecificOutput":{"hookEventName":"UserPromptSubmit","additionalContext":"[timer] Якщо цей промпт — робота над задачею (код, дослідження, документ), ПЕРШИМ кроком виклич timer_task_start з назвою задачі або timer_task_add з start=true для нової. Передавай repo (вивід git remote get-url origin), якщо працюєш у git-репозиторії, і cwd; без git — project. Задачу закінчено — одразу timer_task_done; переходиш до іншої — спершу done попередньої. Та сама задача вже йде — повторно не запускай. Просте питання без роботи — таймер не потрібен. Якщо інструментів timer немає — пропусти."}}
JSON
