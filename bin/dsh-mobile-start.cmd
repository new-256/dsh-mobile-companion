@echo off
setlocal
echo === DSH 手机伴侣试运行 ===
echo.
set DSH_HOME=%~dp0..\..
set DSH_WEB_PORT=8787

echo DSH_HOME=%DSH_HOME%
echo 检测端口 %DSH_WEB_PORT%...

curl -s -o NUL -w "HTTP %%{http_code}" -m 2 "http://localhost:%DSH_WEB_PORT%/m/"
echo.
if ERRORLEVEL 0 (
    echo /m/ 静态资源 OK
) else (
    echo /m/ 访问失败——请确保 DSH Desktop 已启动
    echo 重启后再试 (安装此插件并 Restart DSH)
)
echo.
echo 移动端浏览器访问: http://%COMPUTERNAME%.local:%DSH_WEB_PORT%/m/
pause
