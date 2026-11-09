param([string]$CmdFile)
$ErrorActionPreference = 'Stop'
function Inner($ex) { while ($ex.InnerException) { $ex = $ex.InnerException }; $ex.Message }
[Console]::OutputEncoding = [System.Text.Encoding]::UTF8
Add-Type -AssemblyName System.Runtime.WindowsRuntime
$audioErr = $null
try {
Add-Type -TypeDefinition @'
using System.Runtime.InteropServices;
[Guid("5CDF2C82-841E-4546-9722-0CF74078229A"), InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
interface IAudioEndpointVolume {
  int f(); int g(); int h(); int i();
  int SetMasterVolumeLevelScalar(float fLevel, ref System.Guid pguidEventContext);
  int j();
  int GetMasterVolumeLevelScalar(out float pfLevel);
  int k(); int l(); int m(); int n();
  int SetMute([MarshalAs(UnmanagedType.Bool)] bool bMute, ref System.Guid pguidEventContext);
  int GetMute(out bool pbMute);
}
[Guid("D666063F-1587-4E43-81F1-B948E807363F"), InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
interface IMMDevice { int Activate(ref System.Guid id, int clsCtx, int activationParams, out IAudioEndpointVolume aev); }
[Guid("A95664D2-9614-4F35-A746-DE8DB63617E6"), InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
interface IMMDeviceEnumerator { int f(); int GetDefaultAudioEndpoint(int dataFlow, int role, out IMMDevice endpoint); }
[ComImport, Guid("BCDE0395-E52F-467C-8E3D-C4579291692E")] class MMDeviceEnumeratorComObject { }
public class Audio {
  static IAudioEndpointVolume Vol() {
    var en = new MMDeviceEnumeratorComObject() as IMMDeviceEnumerator;
    IMMDevice dev = null;
    Marshal.ThrowExceptionForHR(en.GetDefaultAudioEndpoint(0, 1, out dev));
    IAudioEndpointVolume epv = null;
    var id = typeof(IAudioEndpointVolume).GUID;
    Marshal.ThrowExceptionForHR(dev.Activate(ref id, 23, 0, out epv));
    return epv;
  }
  public static float Get() { float v = -1; Marshal.ThrowExceptionForHR(Vol().GetMasterVolumeLevelScalar(out v)); return v; }
  public static void Set(float v) { var ctx = System.Guid.Empty; Marshal.ThrowExceptionForHR(Vol().SetMasterVolumeLevelScalar(v, ref ctx)); }
}
'@
} catch { $audioErr = 'audio setup: ' + (Inner $_.Exception) }

$initErr = $null
try {
$asTask = ([System.WindowsRuntimeSystemExtensions].GetMethods() | Where-Object { $_.Name -eq 'AsTask' -and $_.GetParameters().Count -eq 1 -and $_.GetParameters()[0].ParameterType.Name -eq 'IAsyncOperation`1' })[0]
function Await($op, $type) { $t = $asTask.MakeGenericMethod($type).Invoke($null, @($op)); $t.Wait(-1) | Out-Null; $t.Result }

$MgrT    = [Windows.Media.Control.GlobalSystemMediaTransportControlsSessionManager,Windows.Media.Control,ContentType=WindowsRuntime]
$PropT   = [Windows.Media.Control.GlobalSystemMediaTransportControlsSessionMediaProperties,Windows.Media.Control,ContentType=WindowsRuntime]
$StreamT = [Windows.Storage.Streams.IRandomAccessStreamWithContentType,Windows.Storage.Streams,ContentType=WindowsRuntime]
$ReaderT = [Windows.Storage.Streams.DataReader,Windows.Storage.Streams,ContentType=WindowsRuntime]
$mgr = Await ($MgrT::RequestAsync()) $MgrT

} catch { $initErr = 'media setup: ' + (Inner $_.Exception) }

# Prefer whichever app is actually playing (YouTube in Chrome/Edge, Spotify...), not just the "current" one
function Pick {
  $first = $null
  foreach ($x in $mgr.GetSessions()) {
    if ($x.GetPlaybackInfo().PlaybackStatus -eq 'Playing') { return $x }
    if (-not $first) { $first = $x }
  }
  if ($first) { return $first }
  return $mgr.GetCurrentSession()
}

$tick = 0; $lastKey = ''; $gotArt = $false; $tries = 0
while ($true) {
  try {
    if (Test-Path $CmdFile) {
      $c = (Get-Content $CmdFile -Raw).Trim()
      Remove-Item $CmdFile -Force
      try {
        if ($c -like 'vol *') { [Audio]::Set([single]::Parse($c.Substring(4), [Globalization.CultureInfo]::InvariantCulture)) }
        else {
          $s = Pick
          if ($s) {
            if ($c -eq 'play') { [void](Await ($s.TryTogglePlayPauseAsync()) ([bool])) }
            if ($c -eq 'next') { [void](Await ($s.TrySkipNextAsync()) ([bool])) }
            if ($c -eq 'prev') { [void](Await ($s.TrySkipPreviousAsync()) ([bool])) }
            if ($c -like 'seek *') {
              $secs = [double]::Parse($c.Substring(5), [Globalization.CultureInfo]::InvariantCulture)
              [void](Await ($s.TryChangePlaybackPositionAsync([long]($secs * 10000000))) ([bool]))
            }
          }
        }
      } catch { @{ err = 'command: ' + (Inner $_.Exception) } | ConvertTo-Json -Compress }
      $tick = 0
    }
    if ($tick % 5 -eq 0) {
      $o = @{}
      try { $o.vol = [math]::Round([Audio]::Get(), 2) } catch { $o.err = if ($audioErr) { $audioErr } else { 'volume: ' + (Inner $_.Exception) } }
      if ($initErr) { $o.err = $initErr }
      else {
        try {
          $s = Pick
          if ($s) {
            $p = Await ($s.TryGetMediaPropertiesAsync()) $PropT
            $key = "$($p.Title)|$($p.Artist)"
            if ($key -ne $lastKey) { $lastKey = $key; $gotArt = $false; $tries = 0 }
            if (-not $gotArt -and $tries -lt 6 -and $p.Thumbnail) {
              $tries++
              try {
                $st = Await ($p.Thumbnail.OpenReadAsync()) $StreamT
                $r = $ReaderT::new($st)
                [void](Await ($r.LoadAsync([uint32]$st.Size)) ([uint32]))
                $b = New-Object byte[] $st.Size
                $r.ReadBytes($b)
                $o.art = 'data:' + $st.ContentType + ';base64,' + [Convert]::ToBase64String($b)
                $gotArt = $true
              } catch {}
            }
            $o.title = [string]$p.Title
            $o.artist = [string]$p.Artist
            $o.playing = ($s.GetPlaybackInfo().PlaybackStatus -eq 'Playing')
            try {
              $tl = $s.GetTimelineProperties()
              $dur = $tl.EndTime.TotalSeconds - $tl.StartTime.TotalSeconds
              $pos = $tl.Position.TotalSeconds - $tl.StartTime.TotalSeconds
              if ($o.playing) { $el = ([DateTimeOffset]::UtcNow - $tl.LastUpdatedTime).TotalSeconds; if ($el -ge 0 -and $el -lt 21600) { $pos += $el } }
              if ($pos -lt 0) { $pos = 0 }
              if ($dur -gt 0 -and $pos -gt $dur) { $pos = $dur }
              $o.dur = [math]::Round($dur, 1); $o.pos = [math]::Round($pos, 1)
            } catch { $o.err = 'timeline: ' + (Inner $_.Exception) }
          }
        } catch { $o.err = 'media: ' + (Inner $_.Exception) }
      }
      $o | ConvertTo-Json -Compress
    }
  } catch { @{ err = 'loop: ' + (Inner $_.Exception) } | ConvertTo-Json -Compress }
  $tick++
  Start-Sleep -Milliseconds 250
}
