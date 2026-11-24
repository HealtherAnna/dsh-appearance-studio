$ErrorActionPreference = 'Stop'

Add-Type -TypeDefinition @'
using System;
using System.Runtime.InteropServices;

public static class DshWindowIcon {
    [DllImport("user32.dll", CharSet = CharSet.Unicode, SetLastError = true)]
    public static extern IntPtr LoadImage(IntPtr module, string path, uint type, int width, int height, uint flags);

    [DllImport("user32.dll", SetLastError = true)]
    public static extern IntPtr SendMessageTimeout(IntPtr window, uint message, IntPtr wParam, IntPtr lParam,
        uint flags, uint timeout, out IntPtr result);

    [DllImport("user32.dll")]
    public static extern uint GetWindowThreadProcessId(IntPtr window, out uint processId);

    [DllImport("user32.dll")]
    public static extern int GetSystemMetrics(int index);

    [DllImport("user32.dll")]
    public static extern bool DestroyIcon(IntPtr icon);
}
'@

function Set-WindowIcon($window, $size, $icon) {
    $previous = [IntPtr]::Zero
    # WM_SETICON, SMTO_ABORTIFHUNG
    $sent = [DshWindowIcon]::SendMessageTimeout($window, 0x80, [IntPtr]$size, $icon, 2, 500, [ref]$previous)
    if ($sent -eq [IntPtr]::Zero) { throw 'Could not set the DSH window icon.' }
    return $previous
}

function Restore-WindowIcons {
    if ($script:window -eq [IntPtr]::Zero) { return }
    $owner = [uint32]0
    [void][DshWindowIcon]::GetWindowThreadProcessId($script:window, [ref]$owner)
    if ($owner -eq $desktop.Id) {
        foreach ($size in $script:originals.Keys) {
            $current = [IntPtr]::Zero
            # Only restore handles we installed. DSH may set its own window icon in a future release.
            $read = [DshWindowIcon]::SendMessageTimeout($script:window, 0x7f, [IntPtr]$size,
                [IntPtr]::Zero, 2, 500, [ref]$current)
            if ($read -ne [IntPtr]::Zero -and $current -eq $script:icons[$size]) {
                [void](Set-WindowIcon $script:window $size $script:originals[$size])
            }
        }
    }
    $script:originals.Clear()
    $script:window = [IntPtr]::Zero
}

$desktop = Get-Process -Id ([int]$env:DSH_SKIN_DESKTOP_PID)
if ($desktop.Path -ine $env:DSH_SKIN_DESKTOP_EXE) { exit 1 }
$inputPipe = New-Object System.IO.StreamReader ([Console]::OpenStandardInput())
$pending = $inputPipe.ReadLineAsync()
$window = [IntPtr]::Zero
$originals = @{}
$icons = @{}
$enabled = $true
try {
    while (-not $desktop.HasExited) {
        if ($pending.Wait(500)) {
            $command = $pending.Result
            if ($null -eq $command) { break }
            $enabled = $command -eq 'apply'
            Restore-WindowIcons
            foreach ($icon in $icons.Values) { [void][DshWindowIcon]::DestroyIcon($icon) }
            $icons.Clear()
            $pending = $inputPipe.ReadLineAsync()
        }
        if (-not $enabled) { continue }
        $desktop.Refresh()
        $nextWindow = $desktop.MainWindowHandle
        if ($nextWindow -eq [IntPtr]::Zero -or $nextWindow -eq $window) { continue }
        Restore-WindowIcons
        if ($icons.Count -eq 0) {
            foreach ($size in 0,1) {
                $metric = @(49,11)[$size] # SM_CXSMICON, SM_CXICON
                $width = [DshWindowIcon]::GetSystemMetrics($metric)
                $height = [DshWindowIcon]::GetSystemMetrics($metric + 1)
                $icon = [DshWindowIcon]::LoadImage([IntPtr]::Zero, $env:DSH_SKIN_TRAY_ICON, 1, $width, $height, 0x10)
                if ($icon -eq [IntPtr]::Zero) { throw 'Windows could not load the DSH icon file.' }
                $icons[$size] = $icon
            }
        }
        $window = $nextWindow
        foreach ($size in 0,1) {
            $originals[$size] = Set-WindowIcon $window $size $icons[$size]
        }
    }
} finally {
    Restore-WindowIcons
    foreach ($icon in $icons.Values) { [void][DshWindowIcon]::DestroyIcon($icon) }
}
