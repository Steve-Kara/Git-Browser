@echo off
rem Git Browser 启动器：双击即可，或把仓库路径当参数传进来
rem   start.cmd                     浏览本目录
rem   start.cmd -r "D:\code\proj"   浏览指定仓库
cd /d "%~dp0"
echo [git-browser] 启动中，稍后打开 http://127.0.0.1:8787
node server.mjs %*
pause
