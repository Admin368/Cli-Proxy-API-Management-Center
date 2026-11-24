# Windows server launcher

Run `./scripts/server-launcher/Install.ps1` from PowerShell. The installer uses
Windows' existing .NET Framework compiler, installs the launcher under
`%LOCALAPPDATA%\CLIProxyManagementLauncher`, and creates **CLI Proxy Server**
shortcuts on the Desktop and Start menu. It reuses the installed desktop proxy's
icon when available. No elevation or execution-policy changes are required.

Right-click the Desktop shortcut, choose **Show more options**, then **Pin to
taskbar**. Clicking the launcher starts the development server on loopback port
5173 if it is not already responding, then opens Capacity forecast. Closing the
browser does not stop the server. Repeated clicks reuse the running server.

The launcher records the checkout and Bun paths in its local `workspace.txt`;
rerun installation if either moves. Startup logs are `server.log` and
`server-error.log` in the installation folder. This starts the management web UI;
the EasyCLIProxyAPI desktop app still runs the proxy core independently.
