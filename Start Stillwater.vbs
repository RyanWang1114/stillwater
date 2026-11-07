Option Explicit
Dim shell, files, directory, command
Set shell = CreateObject("WScript.Shell")
Set files = CreateObject("Scripting.FileSystemObject")
directory = files.GetParentFolderName(WScript.ScriptFullName)
command = "powershell.exe -NoProfile -ExecutionPolicy Bypass -File """ & directory & "\launch.ps1"""
shell.Run command, 0, False
