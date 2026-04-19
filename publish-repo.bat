@echo off
REM ============================================================================
REM  publish-repo.bat
REM
REM  Publishes this folder as a PUBLIC GitHub repository named
REM  HA-Cloudflare-Access-Recovery, then deletes the earlier gist that held
REM  the same content.
REM
REM  Steps:
REM    1. Verify gh is installed and authenticated.
REM    2. Initialize git if needed, commit the current files.
REM    3. Create the public repo via `gh repo create` and push.
REM    4. Delete the old gist (id: 895660ce083116776bdc50b97c37ef59).
REM
REM  Usage: double-click, or run from cmd in this folder.
REM ============================================================================

setlocal EnableExtensions EnableDelayedExpansion

REM Config
set "REPO_NAME=HA-Cloudflare-Access-Recovery"
set "REPO_DESC=Self-healing Cloudflare Access auth for Home Assistant - recovers the HA web frontend in any browser (desktop or mobile) when the CF_Authorization cookie expires."
set "OLD_GIST_ID=895660ce083116776bdc50b97c37ef59"

REM Always operate from the folder this .bat lives in.
pushd "%~dp0"

echo.
echo === Publishing %REPO_NAME% to GitHub ===
echo.

REM --- 1. gh must be installed ---------------------------------------------------
where gh >nul 2>nul
if errorlevel 1 (
    echo [ERROR] GitHub CLI ^("gh"^) is not installed or not on PATH.
    echo         Install from https://cli.github.com/ then re-run.
    goto :end
)

REM --- 2. gh must be authenticated ----------------------------------------------
gh auth status >nul 2>nul
if errorlevel 1 (
    echo [INFO] Not logged into gh. Launching "gh auth login"...
    echo.
    gh auth login
    if errorlevel 1 (
        echo [ERROR] gh auth login failed. Aborting.
        goto :end
    )
)

REM --- 3. git must be installed -------------------------------------------------
where git >nul 2>nul
if errorlevel 1 (
    echo [ERROR] git is not installed or not on PATH. Install Git for Windows.
    goto :end
)

REM --- 4. Sanity-check the files exist ------------------------------------------
if not exist "README.md" (
    echo [ERROR] README.md not found in %CD%.
    goto :end
)
if not exist "cloudflare_recovery.js" (
    echo [ERROR] cloudflare_recovery.js not found in %CD%.
    goto :end
)

REM --- 5. Initialize git if not already a repo ----------------------------------
if not exist ".git\" (
    echo Initializing git repository...
    git init -b main
    if errorlevel 1 (
        echo [ERROR] git init failed.
        goto :end
    )
)

REM --- 6. Stage and commit everything that's new or changed ---------------------
git add README.md cloudflare_recovery.js LICENSE publish-repo.bat
REM Commit only if there's something staged.
git diff --cached --quiet
if errorlevel 1 (
    git commit -m "Initial commit: self-healing Cloudflare Access recovery script"
    if errorlevel 1 (
        echo [ERROR] git commit failed.
        goto :end
    )
) else (
    echo [INFO] Nothing new to commit.
)

REM --- 7. Create the public repo and push ---------------------------------------
echo.
echo Creating public GitHub repo "%REPO_NAME%" and pushing...
echo.

REM If the remote "origin" already exists, skip repo creation and just push.
git remote get-url origin >nul 2>nul
if errorlevel 1 (
    gh repo create "%REPO_NAME%" --public --source "." --remote origin --push --description "%REPO_DESC%"
    if errorlevel 1 (
        echo [ERROR] gh repo create failed. See message above.
        goto :end
    )
) else (
    echo [INFO] Remote "origin" already configured. Pushing current branch...
    git push -u origin HEAD
    if errorlevel 1 (
        echo [ERROR] git push failed.
        goto :end
    )
)

REM --- 8. Delete the old gist ---------------------------------------------------
echo.
echo Deleting old gist %OLD_GIST_ID% ...
gh gist delete "%OLD_GIST_ID%" --yes
if errorlevel 1 (
    echo [WARN] Could not delete gist %OLD_GIST_ID%. It may already be gone,
    echo        or owned by a different account. Check manually at:
    echo        https://gist.github.com/%OLD_GIST_ID%
) else (
    echo [OK] Old gist deleted.
)

echo.
echo === Done. Repo URL should be printed above. ===
echo.

:end
popd
echo.
pause
endlocal
