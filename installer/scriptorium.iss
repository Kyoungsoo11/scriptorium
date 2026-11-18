; Scriptorium installer (Inno Setup 6). Built by `node scripts/package.js --installer`, which passes
; AppVersion, SourceDir (the dist folder: dist\scriptorium-<version>-win-x64) and OutputDir.
;
; Per-user, no administrator rights. Default folder %USERPROFILE%\Scriptorium rather than
; %LOCALAPPDATA%\Programs: the Microsoft Store build of Claude Desktop redirects AppData for the
; processes it starts (its MCP server runs from here), and the user profile is the same for all.
; Notes and recordings live in %USERPROFILE%\.scriptorium and are never touched by (un)installing.

#ifndef AppVersion
  #define AppVersion "0.0.0"
#endif
#ifndef SourceDir
  #error Pass /DSourceDir=<dist folder> (node scripts/package.js --installer does)
#endif
#ifndef OutputDir
  #define OutputDir "..\dist"
#endif

[Setup]
AppId={{BA6A1FB2-BB1A-46AA-8A79-40BC814F66A3}
AppName=Scriptorium
AppVersion={#AppVersion}
AppVerName=Scriptorium {#AppVersion}
AppPublisher=Kim Kyoungsoo
AppPublisherURL=https://github.com/Kyoungsoo11/scriptorium
AppSupportURL=https://github.com/Kyoungsoo11/scriptorium/issues
VersionInfoVersion={#AppVersion}
DefaultDirName={%USERPROFILE}\Scriptorium
DisableProgramGroupPage=yes
DisableDirPage=auto
PrivilegesRequired=lowest
ArchitecturesAllowed=x64compatible
ArchitecturesInstallIn64BitMode=x64compatible
MinVersion=10.0
OutputDir={#OutputDir}
OutputBaseFilename=scriptorium-{#AppVersion}-setup
SetupIconFile=..\native\scriptorium.ico
UninstallDisplayIcon={app}\Scriptorium.exe
UninstallDisplayName=Scriptorium
; the Whisper model is already quantized and barely compresses; normal keeps the build quick
Compression=lzma2/normal
SolidCompression=no
WizardStyle=modern
; Restart Manager closes what still uses the old files (e.g. Claude's MCP server); recordings and
; transcriptions are checked for first (PrepareToInstall) so none is cut off.
CloseApplications=yes
RestartApplications=no
ShowLanguageDialog=no

[Languages]
#if FileExists(AddBackslash(CompilerPath) + "Languages\Korean.isl")
Name: "korean"; MessagesFile: "compiler:Languages\Korean.isl"
#else
Name: "english"; MessagesFile: "compiler:Default.isl"
#endif

[Tasks]
Name: "desktopicon"; Description: "바탕화면에 바로가기 만들기"; Flags: unchecked
Name: "autostart"; Description: "Windows 시작 시 트레이에서 실행"; Flags: unchecked
Name: "claude"; Description: "Claude Desktop에 연결 (채팅에서 ""이 강의 녹음해 줘""처럼 요청)"

[Files]
Source: "{#SourceDir}\*"; DestDir: "{app}"; Flags: ignoreversion recursesubdirs createallsubdirs

[Icons]
Name: "{autoprograms}\Scriptorium"; Filename: "{app}\Scriptorium.exe"; AppUserModelID: "Scriptorium.App"; Comment: "강의·회의 녹음과 전사 (오프라인)"
Name: "{autodesktop}\Scriptorium"; Filename: "{app}\Scriptorium.exe"; AppUserModelID: "Scriptorium.App"; Tasks: desktopicon

[Registry]
; the same value the app's "Windows 시작 시 실행" menu item writes
Root: HKCU; Subkey: "Software\Microsoft\Windows\CurrentVersion\Run"; ValueType: string; ValueName: "Scriptorium"; ValueData: """{app}\Scriptorium.exe"" --tray"; Flags: uninsdeletevalue; Tasks: autostart

[Run]
Filename: "{app}\runtime\node.exe"; Parameters: """{app}\app\bin\scriptorium.js"" setup-claude"; Flags: runhidden; Tasks: claude; StatusMsg: "Claude Desktop에 연결하는 중..."
Filename: "{app}\Scriptorium.exe"; Description: "Scriptorium 열기"; Flags: postinstall nowait skipifsilent

[UninstallRun]
; only an entry this copy registered; another Scriptorium's stays
Filename: "{app}\runtime\node.exe"; Parameters: """{app}\app\bin\scriptorium.js"" setup-claude --remove --if-own"; Flags: runhidden; RunOnceId: "RemoveClaude"

[Code]
function GetLongPathNameW(ShortPath: String; LongPath: String; Size: Cardinal): Cardinal;
  external 'GetLongPathNameW@kernel32.dll stdcall';

{ Long form of an existing path (C:\Users\KYOUNG~1 -> C:\Users\KyoungsooKim), lower-cased for comparing. }
function LongLower(Path: String): String;
var
  Buf: String;
  N: Cardinal;
begin
  Result := Path;
  SetLength(Buf, 1024);
  N := GetLongPathNameW(Path, Buf, 1024);
  if (N > 0) and (N < 1024) then
    Result := Copy(Buf, 1, N);
  Result := Lowercase(Result);
end;

{ Recordings and transcriptions run as node.exe from this install. Replacing or removing the
  files under them would end them (Restart Manager closes what holds the files), so ask first. }
function RunningWork(Dir: String): Integer;
var
  Locator, Service, Procs, P: Variant;
  I: Integer;
  Exe, Cmd, Node: String;
begin
  Result := 0;
  Node := LongLower(AddBackslash(Dir) + 'runtime\node.exe');
  try
    Locator := CreateOleObject('WbemScripting.SWbemLocator');
    Service := Locator.ConnectServer('.', 'root\CIMV2');
    Procs := Service.ExecQuery('SELECT ExecutablePath, CommandLine FROM Win32_Process WHERE Name = ''node.exe''');
    for I := 0 to Procs.Count - 1 do
    begin
      P := Procs.ItemIndex(I);
      if VarIsNull(P.ExecutablePath) or VarIsNull(P.CommandLine) then Continue;
      Exe := P.ExecutablePath;  { Variant to String first; Lowercase takes a String }
      Cmd := P.CommandLine;
      Exe := LongLower(Exe);
      Cmd := Lowercase(Cmd);
      if (Exe = Node) and ((Pos(' record', Cmd) > 0) or (Pos(' transcribe', Cmd) > 0)) then
        Result := Result + 1;
    end;
  except
    { WMI unavailable: go on; Restart Manager will still list what it closes }
  end;
end;

procedure QuitTrayApp(Dir: String);
var
  Code: Integer;
begin
  if FileExists(AddBackslash(Dir) + 'Scriptorium.exe') then
    Exec(AddBackslash(Dir) + 'Scriptorium.exe', '--quit', '', SW_HIDE, ewWaitUntilTerminated, Code);
end;

function BusyMessage(N: Integer): String;
begin
  Result := 'Scriptorium이 녹음 또는 전사 중이에요 (' + IntToStr(N) + '개).' + #13#10 +
            '설치를 계속하면 그 작업이 끊겨요. 트레이 아이콘에서 녹음을 정지하고 전사가 끝난 뒤 다시 실행해 주세요.';
end;

function PrepareToInstall(var NeedsRestart: Boolean): String;
var
  N: Integer;
begin
  Result := '';
  N := RunningWork(ExpandConstant('{app}'));
  if N > 0 then
  begin
    Result := BusyMessage(N);
    Exit;
  end;
  QuitTrayApp(ExpandConstant('{app}'));
end;

function InitializeUninstall(): Boolean;
var
  N: Integer;
begin
  Result := True;
  N := RunningWork(ExpandConstant('{app}'));
  if N > 0 then
  begin
    MsgBox(BusyMessage(N), mbError, MB_OK);
    Result := False;
    Exit;
  end;
  QuitTrayApp(ExpandConstant('{app}'));
end;

{ The menu item may have enabled start-up without the installer task: remove that value too,
  but only when it starts this copy. }
procedure CurUninstallStepChanged(CurUninstallStep: TUninstallStep);
var
  Value: String;
begin
  if CurUninstallStep = usUninstall then
    if RegQueryStringValue(HKCU, 'Software\Microsoft\Windows\CurrentVersion\Run', 'Scriptorium', Value) then
      if (Pos(LongLower(ExpandConstant('{app}')), Lowercase(Value)) > 0) or (Pos(Lowercase(ExpandConstant('{app}')), Lowercase(Value)) > 0) then
        RegDeleteValue(HKCU, 'Software\Microsoft\Windows\CurrentVersion\Run', 'Scriptorium');
end;
