@echo off
chcp 65001 >nul
title 申论朱批 · 一键启动（本地服务 + 公网隧道）

echo ============================================
echo   申论朱批 · 一键启动
echo ============================================
echo.
echo   本地端口：8788（8787 常被其他项目的 wrangler dev 占用）
echo   启动后本机可直接打开  http://127.0.0.1:8788
echo.

cd /d "E:\Vscode\申论批改app"

echo [1/2] 启动本地网站服务（端口 8788，访问口令 zhupi2026）...
start "申论朱批-本地服务" cmd /c "set PORT=8788&& set ACCESS_CODE=zhupi2026&& node site-server.js"

timeout /t 2 /nobreak >nul

echo [2/2] 启动 Cloudflare 公网隧道...
echo.
echo   下面日志里以 https:// 开头、以 .trycloudflare.com 结尾的那一行，
echo   就是发给朋友的网址（每次重启会变化）。
echo   本窗口不要关闭；关掉窗口 = 网址失效。
echo.

cd /d "E:\Vscode\.cloudflared"
cloudflared.exe tunnel --url http://127.0.0.1:8788 --protocol http2 --no-autoupdate

pause
