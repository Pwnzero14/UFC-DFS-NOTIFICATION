' Launches the watcher with no visible window, appending everything to
' watcher.log. This is what the Startup shortcut points at, so there is no
' console window sitting around that can be closed by accident.
'
' Stop it with stop.bat (or Task Manager -> node.exe).

Option Explicit

Dim shell, fso, root, logPath, cmd
Set shell = CreateObject("WScript.Shell")
Set fso = CreateObject("Scripting.FileSystemObject")

root = fso.GetParentFolderName(WScript.ScriptFullName)
logPath = fso.BuildPath(root, "watcher.log")

shell.CurrentDirectory = root

' cmd /c so the restart loop in run.bat keeps working; 0 = hidden window,
' False = do not block this script waiting for it.
cmd = "cmd /c """"" & fso.BuildPath(root, "run.bat") & """ >> """ & logPath & """ 2>&1"""
shell.Run cmd, 0, False
