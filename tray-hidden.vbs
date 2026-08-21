' Launches the tray status widget with no console window.
' The widget only reads state files - the watcher itself is unaffected by it.

Option Explicit

Dim shell, fso, root, cmd
Set shell = CreateObject("WScript.Shell")
Set fso = CreateObject("Scripting.FileSystemObject")

root = fso.GetParentFolderName(WScript.ScriptFullName)
shell.CurrentDirectory = root

cmd = "powershell.exe -NoProfile -ExecutionPolicy Bypass -File """ & _
      fso.BuildPath(root, "tray.ps1") & """"

' 0 = hidden window, False = do not wait for it
shell.Run cmd, 0, False
