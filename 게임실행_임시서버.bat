@echo off
echo OneArm 로컬 서버를 시작합니다...
echo 브라우저가 열리면 게임을 플레이할 수 있습니다.
echo 이 창을 끄면 게임 서버가 종료됩니다.
start http://localhost:8000/game.html
python -m http.server 8000
pause