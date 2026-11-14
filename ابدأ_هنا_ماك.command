#!/bin/bash
# تشغيل الموقع محليًا ثم فتحه في Chrome (الميكروفون يعمل على localhost)
cd "$(dirname "$0")" || exit 1
PORT=8000
if ! command -v python3 >/dev/null 2>&1; then echo "python3 غير مثبّت. ثبّته من python.org ثم أعد المحاولة."; read -r -p "اضغط Enter للإغلاق"; exit 1; fi
( sleep 2; open -a "Google Chrome" "http://localhost:$PORT" 2>/dev/null || open "http://localhost:$PORT" ) &
echo "الموقع يعمل على http://localhost:$PORT — أغلق هذه النافذة لإيقافه."
python3 serve.py --port $PORT
