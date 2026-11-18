// Scriptorium.exe - the tray app. A small Win32 program that lives in the notification area while
// Scriptorium is working: it shows what is recording or transcribing, starts new recordings and
// stops running ones. It does no audio work itself; it runs the CLI (`scriptorium record --detach`)
// and watches the state files the CLI keeps in <data>\run (see src/activity.js), so recordings
// started from the CLI or from Claude (MCP) show up here too, and closing the app never stops one.
//
//   Scriptorium.exe [--data-dir <dir>]     open the app: tray icon + window; stays until "종료".
//                                          A second launch brings the running app forward.
//   Scriptorium.exe --background [...]     tray icon only; exits by itself once nothing is running.
//                                          Does nothing if the app is already running.
//   Scriptorium.exe --probe <file> [...]   write a JSON self-check to <file> after 3 s and exit
//                                          (runs next to a real instance; for scripts and tests)

#define WIN32_LEAN_AND_MEAN
#define NOMINMAX
#include <windows.h>
#include <shellapi.h>
#include <windowsx.h>
#include <commctrl.h>

#include <algorithm>
#include <cmath>
#include <cwchar>
#include <set>
#include <string>
#include <vector>

#include "app/json.h"
#include "app/util.h"

using namespace app;

namespace {

constexpr wchar_t kMutexName[] = L"Local\\Scriptorium.App";
constexpr wchar_t kWindowClass[] = L"Scriptorium.App";
constexpr wchar_t kProbeClass[] = L"Scriptorium.App.Probe";
constexpr wchar_t kShowMessageName[] = L"Scriptorium.App.Show";
constexpr UINT kTrayId = 1;
constexpr UINT WM_TRAY = WM_APP + 1;

enum MenuId : UINT {
    ID_SHOW = 100,
    ID_OPEN_DATA,
    ID_STOP_ALL,
    ID_EXIT,
    ID_STOP_FIRST = 1000,  // + index into the menu's snapshot of recordings
    ID_ROW_FIRST = 2000,   // window rows: + row * kRowIds + {title, status, stop}
};
constexpr UINT kRowIds = 4;
constexpr UINT ID_EMPTY = 1900;
constexpr UINT ID_RUNNING_HEADER = 1901;

enum TimerId : UINT_PTR { TIMER_PROBE = 1, TIMER_POLL };
constexpr ULONGLONG kIdleExitMs = 15000;           // background mode: linger so the last notice can be read
constexpr ULONGLONG kStaleNoticeMs = 10 * 60 * 1000;  // notices older than this at start-up are dropped

// ---- where things are ---------------------------------------------------------

struct Paths {
    std::wstring root;     // the Scriptorium folder (packaged) or the repository (development)
    std::wstring node;     // node.exe that runs the CLI
    std::wstring cli;      // bin\scriptorium.js
    std::wstring dataDir;  // notes, recordings, run\ (same rule as src/env.js)
    std::wstring runDir;
    bool packaged = false;
};

std::wstring findOnPath(const wchar_t *exe) {
    wchar_t buf[MAX_PATH * 4];
    DWORD n = SearchPathW(nullptr, exe, nullptr, (DWORD)std::size(buf), buf, nullptr);
    return n && n < std::size(buf) ? std::wstring(buf, n) : std::wstring();
}

/**
 * Packaged:     <root>\Scriptorium.exe, <root>\runtime\node.exe, <root>\app\bin\scriptorium.js
 * Development:  <repo>\build\app\Scriptorium.exe, node on PATH, <repo>\bin\scriptorium.js
 */
Paths resolvePaths(const std::wstring &dataDirArg) {
    Paths p;
    std::wstring exeDir = parentDir(exePath());
    if (fileExists(joinPath(exeDir, L"app\\bin\\scriptorium.js"))) {
        p.packaged = true;
        p.root = exeDir;
        p.cli = joinPath(exeDir, L"app\\bin\\scriptorium.js");
        p.node = joinPath(exeDir, L"runtime\\node.exe");
    } else {
        for (std::wstring d = exeDir; !d.empty(); d = parentDir(d)) {
            if (fileExists(joinPath(d, L"bin\\scriptorium.js")) && fileExists(joinPath(d, L"package.json"))) {
                p.root = d;
                p.cli = joinPath(d, L"bin\\scriptorium.js");
                break;
            }
        }
        std::wstring bundled = joinPath(p.root, L"runtime\\node.exe");
        p.node = fileExists(bundled) ? bundled : findOnPath(L"node.exe");
    }
    if (!dataDirArg.empty()) p.dataDir = fullPath(dataDirArg);
    else if (std::wstring home = envVar(L"SCRIPTORIUM_HOME"); !home.empty()) p.dataDir = fullPath(home);
    else p.dataDir = joinPath(envVar(L"USERPROFILE"), L".scriptorium");
    p.runDir = joinPath(p.dataDir, L"run");
    return p;
}

// ---- time ------------------------------------------------------------------------------

ULONGLONG nowEpochMs() {
    FILETIME ft;
    GetSystemTimeAsFileTime(&ft);
    ULARGE_INTEGER u{{ft.dwLowDateTime, ft.dwHighDateTime}};
    return (u.QuadPart - 116444736000000000ULL) / 10000;
}

/** "2026-11-18T09:26:10.347Z" (what JavaScript's toISOString writes) to epoch ms; 0 if unreadable. */
ULONGLONG parseIsoMs(const std::wstring &s) {
    SYSTEMTIME st{};
    int y, mo, d, h, mi, sec, ms = 0;
    if (swscanf_s(s.c_str(), L"%d-%d-%dT%d:%d:%d.%dZ", &y, &mo, &d, &h, &mi, &sec, &ms) < 6) return 0;
    st.wYear = (WORD)y, st.wMonth = (WORD)mo, st.wDay = (WORD)d;
    st.wHour = (WORD)h, st.wMinute = (WORD)mi, st.wSecond = (WORD)sec, st.wMilliseconds = (WORD)ms;
    FILETIME ft;
    if (!SystemTimeToFileTime(&st, &ft)) return 0;
    ULARGE_INTEGER u{{ft.dwLowDateTime, ft.dwHighDateTime}};
    return (u.QuadPart - 116444736000000000ULL) / 10000;
}

ULONGLONG fileTimeEpochMs(const FILETIME &ft) {
    ULARGE_INTEGER u{{ft.dwLowDateTime, ft.dwHighDateTime}};
    return u.QuadPart > 116444736000000000ULL ? (u.QuadPart - 116444736000000000ULL) / 10000 : 0;
}

/** 75 -> "1:15", 3725 -> "1:02:05" */
std::wstring clockText(long long seconds) {
    if (seconds < 0) seconds = 0;
    wchar_t buf[32];
    if (seconds >= 3600)
        swprintf_s(buf, L"%lld:%02lld:%02lld", seconds / 3600, (seconds / 60) % 60, seconds % 60);
    else
        swprintf_s(buf, L"%lld:%02lld", seconds / 60, seconds % 60);
    return buf;
}

// ---- running work ---------------------------------------------------------------------

/** One recording or file transcription, read from its state file in <data>\run. */
struct Activity {
    std::wstring key;  // file name without .json: "recording-<id>" or "transcribe-<pid>"
    bool recording = false;
    DWORD pid = 0;
    std::wstring title;
    std::wstring phase;  // recording: "recording" | "finishing"; transcribe: "transcribing" | "finishing"
    ULONGLONG startedMs = 0;
    double totalSeconds = -1, doneSeconds = 0;  // transcribe
    int index = 0, count = 1;                   // transcribe: which file of how many
    bool micMuted = false, micSilent = false;   // recording
    bool stopRequested = false;                 // a .stop file is waiting for the recorder

    bool live() const { return recording && phase != L"finishing"; }
};

// ---- state ------------------------------------------------------------------------

enum class TrayState { Idle, Recording, Working };

struct Row {
    HWND title = nullptr, status = nullptr, stop = nullptr;
    bool warn = false;
};

struct App {
    HINSTANCE inst = nullptr;
    HWND wnd = nullptr;
    Paths paths;
    bool resident = false;  // opened by the user: stays until "종료"
    bool exitWhenIdle = false;  // "종료" was chosen while work was running
    bool probe = false;
    std::wstring probeFile;
    UINT taskbarCreated = 0;
    UINT showMessage = 0;
    bool trayAdded = false;
    TrayState trayState = TrayState::Idle;
    std::wstring tip = L"Scriptorium";
    HICON trayIcons[3] = {};
    UINT trayIconDpi = 0;
    HFONT font = nullptr, boldFont = nullptr;
    UINT fontDpi = 0;
    ULONGLONG idleSince = 0;
    bool firstPoll = true;

    std::vector<Activity> activities;
    std::set<std::wstring> warned;  // recordings whose microphone problem was already announced
    std::vector<std::wstring> menuStopKeys;  // recordings listed in the open tray menu

    std::vector<Row> rows;
    std::wstring rowsShape;  // keys + stop-button visibility the rows were built for
    HWND runningHeader = nullptr, emptyLabel = nullptr;
} g;

UINT windowDpi() { return g.wnd ? GetDpiForWindow(g.wnd) : 96; }
int scaled(int px, UINT dpi) { return MulDiv(px, (int)dpi, 96); }
int S(int px) { return scaled(px, windowDpi()); }

bool busy() { return !g.activities.empty(); }

int liveRecordings() {
    return (int)std::count_if(g.activities.begin(), g.activities.end(), [](const Activity &a) { return a.live(); });
}

// ---- tray icon ------------------------------------------------------------------------

/**
 * The app icon at `size` px with a status dot in the lower right (none for idle). Drawn by hand
 * into a 32-bit bitmap so the dot's edge is anti-aliased and the icon keeps its transparency.
 */
HICON makeStateIcon(int size, TrayState state) {
    HICON base = static_cast<HICON>(LoadImageW(g.inst, MAKEINTRESOURCEW(1), IMAGE_ICON, size, size, LR_DEFAULTCOLOR));
    if (state == TrayState::Idle || !base) return base;

    ICONINFO ii{};
    if (!GetIconInfo(base, &ii)) return base;
    BITMAPINFO bi{};
    bi.bmiHeader.biSize = sizeof bi.bmiHeader;
    bi.bmiHeader.biWidth = size;
    bi.bmiHeader.biHeight = -size;  // top-down
    bi.bmiHeader.biPlanes = 1;
    bi.bmiHeader.biBitCount = 32;
    bi.bmiHeader.biCompression = BI_RGB;
    std::vector<uint32_t> px((size_t)size * size);
    HDC dc = GetDC(nullptr);
    bool ok = GetDIBits(dc, ii.hbmColor, 0, size, px.data(), &bi, DIB_RGB_COLORS) == size;
    if (ii.hbmColor) DeleteObject(ii.hbmColor);
    if (ii.hbmMask) DeleteObject(ii.hbmMask);
    if (!ok) {
        ReleaseDC(nullptr, dc);
        return base;
    }

    // Recording: red. Working (transcribing, finishing a recording): blue.
    const bool rec = state == TrayState::Recording;
    const double fill[3] = {rec ? 229.0 : 37.0, rec ? 57.0 : 122.0, rec ? 53.0 : 245.0};  // r, g, b
    const double r = size * 0.24, ring = std::max(1.0, size / 16.0);
    const double cx = size - r - ring, cy = size - r - ring;
    for (int y = 0; y < size; y++) {
        for (int x = 0; x < size; x++) {
            double d = std::hypot(x + 0.5 - cx, y + 0.5 - cy);
            double outer = std::clamp(r + ring - d + 0.5, 0.0, 1.0);  // dot + white ring coverage
            if (outer <= 0) continue;
            double inner = std::clamp(r - d + 0.5, 0.0, 1.0);  // dot coverage
            uint32_t &p = px[(size_t)y * size + x];
            double a0 = ((p >> 24) & 0xFF) / 255.0;
            // straight (non-premultiplied) colour of the existing pixel
            double b0 = a0 ? (p & 0xFF) / a0 : 0, g0 = a0 ? ((p >> 8) & 0xFF) / a0 : 0, r0 = a0 ? ((p >> 16) & 0xFF) / a0 : 0;
            // the ring is white; the dot is drawn on top of it
            double cr = 255 * (1 - inner) + fill[0] * inner, cg = 255 * (1 - inner) + fill[1] * inner,
                   cb = 255 * (1 - inner) + fill[2] * inner;
            double a = outer + a0 * (1 - outer);
            auto mix = [&](double top, double bottom) { return a ? (top * outer + bottom * a0 * (1 - outer)) / a : 0; };
            double nr = mix(cr, r0), ng = mix(cg, g0), nb = mix(cb, b0);
            // GDI icons take premultiplied alpha
            p = ((uint32_t)std::lround(a * 255) << 24) | ((uint32_t)std::lround(nr * a) << 16) |
                ((uint32_t)std::lround(ng * a) << 8) | (uint32_t)std::lround(nb * a);
        }
    }

    void *bits = nullptr;
    HBITMAP color = CreateDIBSection(dc, &bi, DIB_RGB_COLORS, &bits, nullptr, 0);
    ReleaseDC(nullptr, dc);
    if (!color) return base;
    memcpy(bits, px.data(), px.size() * 4);
    HBITMAP mask = CreateBitmap(size, size, 1, 1, nullptr);
    ICONINFO out{TRUE, 0, 0, mask, color};
    HICON icon = CreateIconIndirect(&out);
    DeleteObject(color);
    DeleteObject(mask);
    if (!icon) return base;
    DestroyIcon(base);
    return icon;
}

void loadTrayIcons() {
    UINT dpi = windowDpi();
    if (dpi == g.trayIconDpi && g.trayIcons[0]) return;
    for (HICON &i : g.trayIcons)
        if (i) DestroyIcon(i), i = nullptr;
    int size = GetSystemMetricsForDpi(SM_CXSMICON, dpi);
    g.trayIcons[0] = makeStateIcon(size, TrayState::Idle);
    g.trayIcons[1] = makeStateIcon(size, TrayState::Recording);
    g.trayIcons[2] = makeStateIcon(size, TrayState::Working);
    g.trayIconDpi = dpi;
}

NOTIFYICONDATAW trayData(UINT flags) {
    NOTIFYICONDATAW nid{};
    nid.cbSize = sizeof nid;
    nid.hWnd = g.wnd;
    nid.uID = kTrayId;
    nid.uFlags = flags;
    return nid;
}

void fillTrayLook(NOTIFYICONDATAW &nid) {
    loadTrayIcons();
    nid.uFlags |= NIF_ICON | NIF_TIP | NIF_SHOWTIP;
    nid.hIcon = g.trayIcons[(int)g.trayState];
    wcsncpy_s(nid.szTip, g.tip.c_str(), _TRUNCATE);
}

bool addTrayIcon() {
    NOTIFYICONDATAW nid = trayData(NIF_MESSAGE);
    nid.uCallbackMessage = WM_TRAY;
    fillTrayLook(nid);
    g.trayAdded = Shell_NotifyIconW(NIM_ADD, &nid) != FALSE;
    if (g.trayAdded) {
        nid.uVersion = NOTIFYICON_VERSION_4;
        Shell_NotifyIconW(NIM_SETVERSION, &nid);
    }
    return g.trayAdded;
}

/** Updates the icon and tooltip; re-adds the icon if Explorer lost it. */
void setTray(TrayState state, const std::wstring &tip) {
    if (state == g.trayState && tip == g.tip && g.trayAdded) return;
    g.trayState = state;
    g.tip = tip;
    NOTIFYICONDATAW nid = trayData(0);
    fillTrayLook(nid);
    if (!g.trayAdded || !Shell_NotifyIconW(NIM_MODIFY, &nid)) addTrayIcon();
}

void removeTrayIcon() {
    NOTIFYICONDATAW nid = trayData(0);
    Shell_NotifyIconW(NIM_DELETE, &nid);
    g.trayAdded = false;
}

/** A Windows notification from the tray icon (shown as a toast on Windows 10/11). */
void notify(const std::wstring &title, const std::wstring &text, bool warning = false) {
    NOTIFYICONDATAW nid = trayData(NIF_INFO);
    wcsncpy_s(nid.szInfoTitle, title.c_str(), _TRUNCATE);
    wcsncpy_s(nid.szInfo, text.empty() ? L" " : text.c_str(), _TRUNCATE);
    nid.dwInfoFlags = (warning ? NIIF_WARNING : NIIF_INFO) | NIIF_RESPECT_QUIET_TIME;
    Shell_NotifyIconW(NIM_MODIFY, &nid);
}

// ---- window -------------------------------------------------------------------------------

void ensureFonts() {
    UINT dpi = windowDpi();
    if (g.font && g.fontDpi == dpi) return;
    if (g.font) DeleteObject(g.font);
    if (g.boldFont) DeleteObject(g.boldFont);
    NONCLIENTMETRICSW ncm{sizeof ncm};
    SystemParametersInfoForDpi(SPI_GETNONCLIENTMETRICS, sizeof ncm, &ncm, 0, dpi);
    g.font = CreateFontIndirectW(&ncm.lfMessageFont);
    LOGFONTW bold = ncm.lfMessageFont;
    bold.lfWeight = FW_SEMIBOLD;
    g.boldFont = CreateFontIndirectW(&bold);
    g.fontDpi = dpi;
}

HWND makeChild(const wchar_t *cls, const wchar_t *text, DWORD style, UINT id, HFONT font) {
    HWND h = CreateWindowExW(0, cls, text, WS_CHILD | WS_VISIBLE | style, 0, 0, 0, 0, g.wnd,
                             reinterpret_cast<HMENU>(static_cast<UINT_PTR>(id)), g.inst, nullptr);
    SendMessageW(h, WM_SETFONT, reinterpret_cast<WPARAM>(font), FALSE);
    return h;
}

void setTextIfChanged(HWND h, const std::wstring &text) {
    int n = GetWindowTextLengthW(h);
    std::wstring cur(n, L'\0');
    if (n) GetWindowTextW(h, cur.data(), n + 1);
    if (cur != text) SetWindowTextW(h, text.c_str());
}

std::wstring statusText(const Activity &a, bool *warn) {
    *warn = false;
    long long elapsed = a.startedMs ? (long long)(nowEpochMs() - a.startedMs) / 1000 : 0;
    if (a.recording) {
        if (a.phase == L"finishing") return L"녹음 끝 · 전사 마무리 중…";
        std::wstring s = L"녹음 중 " + clockText(elapsed);
        if (a.stopRequested) return s + L" · 정지하는 중…";
        if (a.micMuted) {
            *warn = true;
            return s + L" · 마이크가 음소거돼 있어요";
        }
        if (a.micSilent) {
            *warn = true;
            return s + L" · 마이크 신호가 없어요";
        }
        return s;
    }
    std::wstring s;
    if (a.phase == L"finishing") s = L"화자 구분·마무리 중…";
    else if (a.totalSeconds > 0) {
        int pct = (int)std::lround(100.0 * std::min(a.doneSeconds, a.totalSeconds) / a.totalSeconds);
        s = L"파일 전사 " + std::to_wstring(pct) + L"% (" + clockText((long long)a.doneSeconds) + L" / " +
            clockText((long long)a.totalSeconds) + L")";
    } else {
        s = L"파일 전사 준비 중…";
    }
    if (a.count > 1) s += L" · 파일 " + std::to_wstring(a.index + 1) + L"/" + std::to_wstring(a.count);
    return s;
}

/** Height of the client area; positions every control. Extended by the new-recording form. */
int layout() {
    ensureFonts();
    RECT rc;
    GetClientRect(g.wnd, &rc);
    const int m = S(14), w = rc.right - rc.left - 2 * m;
    int y = m;
    if (g.runningHeader) SetWindowPos(g.runningHeader, nullptr, m, y, w, S(20), SWP_NOZORDER), y += S(24);
    if (g.rows.empty()) {
        if (g.emptyLabel) SetWindowPos(g.emptyLabel, nullptr, m, y, w, S(20), SWP_NOZORDER);
        y += S(26);
    }
    const int stopW = S(56), stopH = S(26), lineH = S(19);
    for (const Row &r : g.rows) {
        int textW = r.stop ? w - stopW - S(8) : w;
        SetWindowPos(r.title, nullptr, m, y, textW, lineH, SWP_NOZORDER);
        SetWindowPos(r.status, nullptr, m, y + lineH, textW, lineH, SWP_NOZORDER);
        if (r.stop) SetWindowPos(r.stop, nullptr, m + w - stopW, y + (2 * lineH - stopH) / 2, stopW, stopH, SWP_NOZORDER);
        y += 2 * lineH + S(10);
    }
    return y + m - S(10) + S(4);
}

/** Sizes the window to its content (fixed width), keeping its bottom edge where it was. */
void fitWindow() {
    UINT dpi = windowDpi();
    int clientW = scaled(340, dpi);
    // lay out once at the right width so the height is right
    RECT wr;
    GetWindowRect(g.wnd, &wr);
    RECT want{0, 0, clientW, 100};
    DWORD style = (DWORD)GetWindowLongPtrW(g.wnd, GWL_STYLE), ex = (DWORD)GetWindowLongPtrW(g.wnd, GWL_EXSTYLE);
    AdjustWindowRectExForDpi(&want, style, FALSE, ex, dpi);
    int frameW = want.right - want.left, frameExtraH = (want.bottom - want.top) - 100;
    if (wr.right - wr.left != frameW) SetWindowPos(g.wnd, nullptr, 0, 0, frameW, wr.bottom - wr.top, SWP_NOMOVE | SWP_NOZORDER | SWP_NOACTIVATE);
    int h = layout() + frameExtraH;
    GetWindowRect(g.wnd, &wr);
    if (wr.bottom - wr.top != h)
        SetWindowPos(g.wnd, nullptr, wr.left, wr.bottom - h, frameW, h, SWP_NOZORDER | SWP_NOACTIVATE);
    layout();
}

/** Rebuilds the rows when the set of activities (or which have a stop button) changed; else updates text. */
void refreshRows() {
    ensureFonts();
    std::wstring shape;
    for (const Activity &a : g.activities) shape += a.key + (a.live() && !a.stopRequested ? L"|s;" : L"|;");
    if (!g.runningHeader) {
        g.runningHeader = makeChild(L"STATIC", L"진행 중", SS_LEFT | SS_NOPREFIX, ID_RUNNING_HEADER, g.boldFont);
        g.emptyLabel = makeChild(L"STATIC", L"진행 중인 작업이 없어요", SS_LEFT | SS_NOPREFIX, ID_EMPTY, g.font);
    }
    if (shape != g.rowsShape) {
        for (Row &r : g.rows) {
            DestroyWindow(r.title);
            DestroyWindow(r.status);
            if (r.stop) DestroyWindow(r.stop);
        }
        g.rows.clear();
        for (size_t i = 0; i < g.activities.size(); i++) {
            const Activity &a = g.activities[i];
            UINT base = ID_ROW_FIRST + (UINT)i * kRowIds;
            Row r;
            r.title = makeChild(L"STATIC", a.title.c_str(), SS_LEFT | SS_NOPREFIX | SS_ENDELLIPSIS, base, g.boldFont);
            r.status = makeChild(L"STATIC", L"", SS_LEFT | SS_NOPREFIX | SS_ENDELLIPSIS, base + 1, g.font);
            if (a.live() && !a.stopRequested)
                r.stop = makeChild(L"BUTTON", L"정지", BS_PUSHBUTTON | WS_TABSTOP, base + 2, g.font);
            g.rows.push_back(r);
        }
        ShowWindow(g.emptyLabel, g.rows.empty() ? SW_SHOW : SW_HIDE);
        g.rowsShape = shape;
        fitWindow();
    }
    for (size_t i = 0; i < g.rows.size(); i++) {
        bool warn = false;
        setTextIfChanged(g.rows[i].title, g.activities[i].title.empty() ? L"(제목 없음)" : g.activities[i].title);
        setTextIfChanged(g.rows[i].status, statusText(g.activities[i], &warn));
        if (warn != g.rows[i].warn) {
            g.rows[i].warn = warn;
            InvalidateRect(g.rows[i].status, nullptr, TRUE);
        }
    }
}

/** Puts the window in the lower right of the work area, next to the notification area. */
void placeNearTray() {
    RECT wr;
    GetWindowRect(g.wnd, &wr);
    MONITORINFO mi{sizeof mi};
    HWND taskbar = FindWindowW(L"Shell_TrayWnd", nullptr);
    GetMonitorInfoW(MonitorFromWindow(taskbar ? taskbar : g.wnd, MONITOR_DEFAULTTOPRIMARY), &mi);
    int margin = S(12);
    int w = wr.right - wr.left, h = wr.bottom - wr.top;
    SetWindowPos(g.wnd, nullptr, mi.rcWork.right - w - margin, mi.rcWork.bottom - h - margin, 0, 0,
                 SWP_NOSIZE | SWP_NOZORDER | SWP_NOACTIVATE);
}

void showWindow() {
    // Not SW_SHOWNORMAL: on a process's first ShowWindow call Windows replaces SW_SHOWNORMAL with
    // the launcher's STARTUPINFO show state, which started the window minimized in testing.
    if (!IsWindowVisible(g.wnd)) placeNearTray();
    ShowWindow(g.wnd, SW_SHOW);
    if (IsIconic(g.wnd)) ShowWindow(g.wnd, SW_RESTORE);
    SetForegroundWindow(g.wnd);
}

void openDataFolder() {
    makeDirs(g.paths.dataDir);
    ShellExecuteW(g.wnd, L"open", g.paths.dataDir.c_str(), nullptr, nullptr, SW_SHOWNORMAL);
}

// ---- reading the run folder ------------------------------------------------------------

bool readActivity(const std::wstring &file, const std::wstring &key, Activity &a) {
    bool ok = false;
    std::string text = readFile(file, &ok);
    Json j;
    if (!ok || !parseJson(text, j) || j.type != Json::Object) return false;
    a.key = key;
    a.recording = key.rfind(L"recording-", 0) == 0;
    a.pid = (DWORD)j.number(L"pid");
    a.title = j.text(L"title");
    a.startedMs = parseIsoMs(j.text(L"startedAt"));
    if (a.recording) {
        a.phase = j.text(L"phase", L"recording");  // state files from before 0.4 have no phase
        if (const Json *audio = j.get(L"audio")) {
            a.micMuted = audio->flag(L"microphoneMuted");
            a.micSilent = audio->flag(L"microphoneSilent");
        }
        a.stopRequested = fileExists(joinPath(g.paths.runDir, key + L".stop"));
    } else {
        a.phase = j.text(L"phase", L"transcribing");
        a.totalSeconds = j.has(L"totalSeconds") ? j.number(L"totalSeconds") : -1;
        a.doneSeconds = j.number(L"doneSeconds");
        a.index = (int)j.number(L"index");
        a.count = std::max(1, (int)j.number(L"count", 1));
    }
    return a.pid != 0;
}

struct Finished {
    bool recording = false, ok = false;
    std::wstring title, error;
};

/** Scans <data>\run: running work into g.activities, and finished-*.json notices (which are consumed). */
std::vector<Finished> scanRunDir() {
    std::vector<Activity> found;
    std::vector<Finished> finished;
    WIN32_FIND_DATAW fd;
    HANDLE h = FindFirstFileW(joinPath(g.paths.runDir, L"*.json").c_str(), &fd);
    if (h != INVALID_HANDLE_VALUE) {
        ULONGLONG now = nowEpochMs();
        do {
            if (fd.dwFileAttributes & FILE_ATTRIBUTE_DIRECTORY) continue;
            std::wstring name = fd.cFileName;
            if (name.size() < 6 || name.compare(name.size() - 5, 5, L".json") != 0) continue;
            std::wstring key = name.substr(0, name.size() - 5), file = joinPath(g.paths.runDir, name);
            if (key.rfind(L"recording-", 0) == 0 || key.rfind(L"transcribe-", 0) == 0) {
                Activity a;
                if (!readActivity(file, key, a)) continue;  // being written, or not ours
                if (!processAlive(a.pid)) {
                    // its process died without cleaning up (as `status` does); a probe only looks
                    if (!g.probe) {
                        DeleteFileW(file.c_str());
                        DeleteFileW(joinPath(g.paths.runDir, key + L".stop").c_str());
                    }
                    continue;
                }
                found.push_back(std::move(a));
            } else if (key.rfind(L"finished-", 0) == 0 && !g.probe) {
                bool stale = g.firstPoll && now - fileTimeEpochMs(fd.ftLastWriteTime) > kStaleNoticeMs;
                bool ok = false;
                std::string text = readFile(file, &ok);
                Json j;
                if (ok && !stale && parseJson(text, j) && j.type == Json::Object) {
                    Finished f;
                    f.recording = j.text(L"kind") == L"recording";
                    f.ok = j.flag(L"ok");
                    f.title = j.text(L"title");
                    f.error = j.text(L"error");
                    finished.push_back(std::move(f));
                }
                if (ok) DeleteFileW(file.c_str());
            }
        } while (FindNextFileW(h, &fd));
        FindClose(h);
    }
    // Oldest first, so rows keep their order as work comes and goes.
    std::sort(found.begin(), found.end(), [](const Activity &a, const Activity &b) {
        return a.startedMs != b.startedMs ? a.startedMs < b.startedMs : a.key < b.key;
    });
    g.activities = std::move(found);
    g.firstPoll = false;
    return finished;
}

void announce(const std::vector<Finished> &finished) {
    if (finished.empty()) return;
    if (finished.size() == 1) {
        const Finished &f = finished[0];
        std::wstring what = f.recording ? L"녹음" : L"파일 전사";
        if (f.ok) notify(what + L" 완료", f.title + L" — 노트에 저장했어요");
        else notify(what + L" 실패", f.title + (f.error.empty() ? L"" : L": " + f.error), true);
        return;
    }
    int failed = (int)std::count_if(finished.begin(), finished.end(), [](const Finished &f) { return !f.ok; });
    std::wstring text;
    for (const Finished &f : finished) text += (text.empty() ? L"" : L", ") + f.title + (f.ok ? L"" : L" (실패)");
    notify(std::to_wstring(finished.size()) + L"개 작업이 끝났어요" + (failed ? L" · 실패 " + std::to_wstring(failed) + L"개" : L""),
           text, failed > 0);
}

/** Announces a microphone problem once per recording. */
void warnAboutMicrophones() {
    std::set<std::wstring> stillBad;
    for (const Activity &a : g.activities) {
        if (!a.live() || !(a.micMuted || a.micSilent)) continue;
        stillBad.insert(a.key);
        if (g.warned.count(a.key)) continue;
        notify(a.micMuted ? L"마이크가 음소거돼 있어요" : L"마이크 신호가 없어요",
               a.title + L" — 마이크 소리가 녹음되지 않고 있어요. 음소거 키나 Windows 소리 설정을 확인하세요.", true);
    }
    g.warned = std::move(stillBad);
}

std::wstring tooltipText() {
    if (g.activities.empty()) return L"Scriptorium";
    int rec = liveRecordings();
    int other = (int)g.activities.size() - rec;
    std::wstring tip = L"Scriptorium";
    if (rec) tip += L" · 녹음 중 " + std::to_wstring(rec) + L"개";
    if (other) tip += L" · 전사 중 " + std::to_wstring(other) + L"개";
    if (g.activities.size() == 1) tip += L"\n" + g.activities[0].title;
    return tip;
}

/** Background mode (and "종료" while busy) ends by itself a little while after the last piece of work. */
void checkIdleExit() {
    if ((g.resident && !g.exitWhenIdle) || g.probe || busy()) {
        g.idleSince = 0;
        return;
    }
    ULONGLONG now = GetTickCount64();
    if (!g.idleSince) g.idleSince = now;
    else if (now - g.idleSince >= kIdleExitMs) DestroyWindow(g.wnd);
}

void poll() {
    std::vector<Finished> finished = scanRunDir();
    announce(finished);
    warnAboutMicrophones();
    TrayState state = liveRecordings() ? TrayState::Recording : busy() ? TrayState::Working : TrayState::Idle;
    setTray(state, tooltipText());
    refreshRows();
    checkIdleExit();
}

// ---- actions --------------------------------------------------------------------------

/** Asks a recording to stop, the same way `scriptorium stop` does: <data>\run\recording-<id>.stop. */
void stopRecording(const std::wstring &key) {
    HANDLE h = CreateFileW(joinPath(g.paths.runDir, key + L".stop").c_str(), GENERIC_WRITE, 0, nullptr, CREATE_ALWAYS,
                           FILE_ATTRIBUTE_NORMAL, nullptr);
    if (h != INVALID_HANDLE_VALUE) CloseHandle(h);
}

void stopAllRecordings() {
    for (const Activity &a : g.activities)
        if (a.live()) stopRecording(a.key);
}

/**
 * "종료": quits at once when nothing runs. Otherwise the tray icon has to stay while work runs, so
 * it offers to stop the recordings and quit once everything has finished.
 */
void requestExit() {
    if (!busy()) {
        DestroyWindow(g.wnd);
        return;
    }
    int rec = liveRecordings(), other = (int)g.activities.size() - rec;
    std::wstring text;
    if (rec) text = L"녹음 " + std::to_wstring(rec) + L"개를 정지하고, ";
    text += L"진행 중인 전사가 모두 끝나면 Scriptorium을 종료할까요?\n\n전사가 끝날 때까지는 트레이 아이콘이 남아 있어요.";
    if (!rec && other) text = L"진행 중인 파일 전사 " + std::to_wstring(other) + L"개가 끝나면 Scriptorium을 종료할까요?";
    if (MessageBoxW(g.wnd, text.c_str(), L"Scriptorium 종료", MB_OKCANCEL | MB_ICONQUESTION | MB_SETFOREGROUND) != IDOK)
        return;
    stopAllRecordings();
    g.exitWhenIdle = true;
    ShowWindow(g.wnd, SW_HIDE);
    poll();
}

// ---- menu -----------------------------------------------------------------------------------

void showMenu(POINT pt) {
    HMENU menu = CreatePopupMenu();
    AppendMenuW(menu, MF_STRING, ID_SHOW, L"열기");
    g.menuStopKeys.clear();
    for (const Activity &a : g.activities) {
        if (!a.live() || a.stopRequested) continue;
        if (g.menuStopKeys.empty()) AppendMenuW(menu, MF_SEPARATOR, 0, nullptr);
        long long elapsed = a.startedMs ? (long long)(nowEpochMs() - a.startedMs) / 1000 : 0;
        std::wstring label = L"정지: " + a.title + L" (" + clockText(elapsed) + L")";
        // '&' would underline the next letter in a menu
        for (size_t i = 0; (i = label.find(L'&', i)) != std::wstring::npos; i += 2) label.insert(i, 1, L'&');
        AppendMenuW(menu, MF_STRING, ID_STOP_FIRST + (UINT)g.menuStopKeys.size(), label.c_str());
        g.menuStopKeys.push_back(a.key);
    }
    if (g.menuStopKeys.size() > 1) AppendMenuW(menu, MF_STRING, ID_STOP_ALL, L"녹음 모두 정지");
    AppendMenuW(menu, MF_SEPARATOR, 0, nullptr);
    AppendMenuW(menu, MF_STRING, ID_OPEN_DATA, L"데이터 폴더 열기");
    AppendMenuW(menu, MF_SEPARATOR, 0, nullptr);
    AppendMenuW(menu, MF_STRING, ID_EXIT, L"종료");
    SetMenuDefaultItem(menu, ID_SHOW, FALSE);
    SetForegroundWindow(g.wnd);  // otherwise the menu does not close when clicking elsewhere
    UINT align = GetSystemMetrics(SM_MENUDROPALIGNMENT) ? TPM_RIGHTALIGN : TPM_LEFTALIGN;
    TrackPopupMenuEx(menu, align | TPM_BOTTOMALIGN | TPM_RIGHTBUTTON, pt.x, pt.y, g.wnd, nullptr);
    PostMessageW(g.wnd, WM_NULL, 0, 0);
    DestroyMenu(menu);
}

void onCommand(UINT id) {
    if (id >= ID_STOP_FIRST && id < ID_STOP_FIRST + g.menuStopKeys.size()) {
        stopRecording(g.menuStopKeys[id - ID_STOP_FIRST]);
        poll();
        return;
    }
    if (id >= ID_ROW_FIRST && (id - ID_ROW_FIRST) % kRowIds == 2) {  // a row's 정지 button
        size_t row = (id - ID_ROW_FIRST) / kRowIds;
        if (row < g.activities.size() && g.activities[row].live()) stopRecording(g.activities[row].key);
        poll();
        return;
    }
    switch (id) {
    case IDCANCEL: ShowWindow(g.wnd, SW_HIDE); break;  // Esc
    case ID_SHOW: showWindow(); break;
    case ID_OPEN_DATA: openDataFolder(); break;
    case ID_STOP_ALL:
        stopAllRecordings();
        poll();
        break;
    case ID_EXIT: requestExit(); break;
    }
}

// ---- probe ------------------------------------------------------------------------------------

void writeProbe() {
    const Paths &p = g.paths;
    std::string json = "{\"ok\":true";
    json += ",\"pid\":" + std::to_string(GetCurrentProcessId());
    json += std::string(",\"tray\":") + (g.trayAdded ? "true" : "false");
    json += ",\"dpi\":" + std::to_string(windowDpi());
    json += ",\"exe\":" + jsonString(exePath());
    json += std::string(",\"packaged\":") + (p.packaged ? "true" : "false");
    json += ",\"root\":" + jsonString(p.root);
    json += ",\"node\":" + jsonString(p.node);
    json += std::string(",\"nodeFound\":") + (fileExists(p.node) ? "true" : "false");
    json += ",\"cli\":" + jsonString(p.cli);
    json += std::string(",\"cliFound\":") + (fileExists(p.cli) ? "true" : "false");
    json += ",\"dataDir\":" + jsonString(p.dataDir);
    json += ",\"activities\":[";
    for (size_t i = 0; i < g.activities.size(); i++) {
        const Activity &a = g.activities[i];
        bool warn = false;
        json += (i ? "," : "");
        json += "{\"key\":" + jsonString(a.key) + ",\"title\":" + jsonString(a.title) + ",\"phase\":" + jsonString(a.phase) +
                ",\"status\":" + jsonString(statusText(a, &warn)) + "}";
    }
    json += "]}\n";
    writeFileAtomic(g.probeFile, json);
}

// ---- window procedure -------------------------------------------------------------------

LRESULT CALLBACK wndProc(HWND hwnd, UINT msg, WPARAM wp, LPARAM lp) {
    if (g.taskbarCreated && msg == g.taskbarCreated) {
        g.trayAdded = false;  // Explorer restarted: the icon is gone until we add it again
        g.trayIconDpi = 0;
        addTrayIcon();
        return 0;
    }
    if (g.showMessage && msg == g.showMessage) {
        if (wp == 1) g.resident = true, g.exitWhenIdle = false;  // the user opened the app: it stays
        showWindow();
        return 0;
    }
    switch (msg) {
    case WM_TRAY:
        switch (LOWORD(lp)) {
        case WM_LBUTTONUP:
        case NIN_SELECT:
        case NIN_KEYSELECT:
        case NIN_BALLOONUSERCLICK:
            showWindow();
            return 0;
        case WM_CONTEXTMENU:
            showMenu({GET_X_LPARAM(wp), GET_Y_LPARAM(wp)});
            return 0;
        }
        return 0;
    case WM_COMMAND:
        onCommand(LOWORD(wp));
        return 0;
    case WM_TIMER:
        if (wp == TIMER_PROBE) {
            KillTimer(hwnd, TIMER_PROBE);
            writeProbe();
            DestroyWindow(hwnd);
        } else if (wp == TIMER_POLL) {
            poll();
        }
        return 0;
    case WM_CTLCOLORSTATIC: {
        HDC dc = reinterpret_cast<HDC>(wp);
        HWND ctl = reinterpret_cast<HWND>(lp);
        UINT id = (UINT)GetDlgCtrlID(ctl);
        SetBkColor(dc, GetSysColor(COLOR_WINDOW));
        COLORREF color = GetSysColor(COLOR_WINDOWTEXT);
        if (id == ID_EMPTY) color = GetSysColor(COLOR_GRAYTEXT);
        else if (id >= ID_ROW_FIRST && (id - ID_ROW_FIRST) % kRowIds == 1) {
            size_t row = (id - ID_ROW_FIRST) / kRowIds;
            color = row < g.rows.size() && g.rows[row].warn ? RGB(196, 43, 28) : GetSysColor(COLOR_GRAYTEXT);
        }
        SetTextColor(dc, color);
        return reinterpret_cast<LRESULT>(GetSysColorBrush(COLOR_WINDOW));
    }
    case WM_DPICHANGED: {  // moved to a monitor with a different scale
        const RECT *r = reinterpret_cast<const RECT *>(lp);
        SetWindowPos(hwnd, nullptr, r->left, r->top, r->right - r->left, r->bottom - r->top,
                     SWP_NOZORDER | SWP_NOACTIVATE);
        g.trayIconDpi = 0;
        setTray(g.trayState, g.tip);
        ensureFonts();
        for (HWND c = GetWindow(hwnd, GW_CHILD); c; c = GetWindow(c, GW_HWNDNEXT)) {
            UINT id = (UINT)GetDlgCtrlID(c);
            bool bold = id == ID_RUNNING_HEADER || (id >= ID_ROW_FIRST && (id - ID_ROW_FIRST) % kRowIds == 0);
            SendMessageW(c, WM_SETFONT, reinterpret_cast<WPARAM>(bold ? g.boldFont : g.font), TRUE);
        }
        fitWindow();
        return 0;
    }
    case WM_CLOSE:
        ShowWindow(hwnd, SW_HIDE);  // closing hides; "종료" in the tray menu exits
        return 0;
    case WM_ERASEBKGND: {
        RECT rc;
        GetClientRect(hwnd, &rc);
        FillRect(reinterpret_cast<HDC>(wp), &rc, GetSysColorBrush(COLOR_WINDOW));
        return 1;
    }
    case WM_DESTROY:
        removeTrayIcon();
        PostQuitMessage(0);
        return 0;
    }
    return DefWindowProcW(hwnd, msg, wp, lp);
}

}  // namespace

int WINAPI wWinMain(HINSTANCE inst, HINSTANCE, PWSTR, int) {
    g.inst = inst;
    bool background = false;
    std::wstring dataDirArg;
    int argc = 0;
    wchar_t **argv = CommandLineToArgvW(GetCommandLineW(), &argc);
    for (int i = 1; i < argc; i++) {
        std::wstring a = argv[i];
        if (a == L"--probe" && i + 1 < argc) g.probeFile = argv[++i];
        else if (a == L"--data-dir" && i + 1 < argc) dataDirArg = argv[++i];
        else if (a == L"--background") background = true;
    }
    LocalFree(argv);
    g.probe = !g.probeFile.empty();
    g.resident = !background && !g.probe;
    g.paths = resolvePaths(dataDirArg);

    g.showMessage = RegisterWindowMessageW(kShowMessageName);
    // A probe runs alongside a real instance, so it skips the single-instance check.
    HANDLE mutex = nullptr;
    if (!g.probe) {
        mutex = CreateMutexW(nullptr, TRUE, kMutexName);
        if (GetLastError() == ERROR_ALREADY_EXISTS) {
            // Background launches only make sure the app runs; a user launch brings it forward.
            if (!background) {
                if (HWND other = FindWindowW(kWindowClass, nullptr)) {
                    DWORD pid = 0;
                    GetWindowThreadProcessId(other, &pid);
                    AllowSetForegroundWindow(pid);
                    PostMessageW(other, g.showMessage, 1, 0);
                }
            }
            if (mutex) CloseHandle(mutex);
            return 0;
        }
    }

    INITCOMMONCONTROLSEX icc{sizeof icc, ICC_STANDARD_CLASSES};
    InitCommonControlsEx(&icc);

    WNDCLASSEXW wc{sizeof wc};
    wc.lpfnWndProc = wndProc;
    wc.hInstance = inst;
    wc.hIcon = static_cast<HICON>(LoadImageW(inst, MAKEINTRESOURCEW(1), IMAGE_ICON, GetSystemMetrics(SM_CXICON),
                                             GetSystemMetrics(SM_CYICON), LR_DEFAULTCOLOR));
    wc.hIconSm = static_cast<HICON>(LoadImageW(inst, MAKEINTRESOURCEW(1), IMAGE_ICON, GetSystemMetrics(SM_CXSMICON),
                                               GetSystemMetrics(SM_CYSMICON), LR_DEFAULTCOLOR));
    wc.hCursor = LoadCursorW(nullptr, IDC_ARROW);
    wc.lpszClassName = g.probe ? kProbeClass : kWindowClass;
    RegisterClassExW(&wc);

    g.taskbarCreated = RegisterWindowMessageW(L"TaskbarCreated");
    // WS_EX_TOOLWINDOW keeps the window off the taskbar; the tray icon is the way in.
    // WS_EX_CONTROLPARENT lets Tab move between the buttons and fields.
    g.wnd = CreateWindowExW(WS_EX_TOOLWINDOW | WS_EX_CONTROLPARENT, wc.lpszClassName, L"Scriptorium",
                            WS_OVERLAPPED | WS_CAPTION | WS_SYSMENU | WS_CLIPCHILDREN, CW_USEDEFAULT, CW_USEDEFAULT, 340,
                            300, nullptr, nullptr, inst, nullptr);
    if (!g.wnd) return 1;
    // Lets Explorer's TaskbarCreated broadcast through UIPI if we ever run elevated.
    ChangeWindowMessageFilterEx(g.wnd, g.taskbarCreated, MSGFLT_ALLOW, nullptr);
    ChangeWindowMessageFilterEx(g.wnd, g.showMessage, MSGFLT_ALLOW, nullptr);

    addTrayIcon();
    poll();  // builds the window's content and sizes it
    SetTimer(g.wnd, TIMER_POLL, 1000, nullptr);
    if (g.probe) SetTimer(g.wnd, TIMER_PROBE, 3000, nullptr);
    else if (g.resident) showWindow();

    MSG m;
    while (GetMessageW(&m, nullptr, 0, 0) > 0) {
        if (IsDialogMessageW(g.wnd, &m)) continue;  // Tab / Enter / Esc between controls
        TranslateMessage(&m);
        DispatchMessageW(&m);
    }
    for (HICON i : g.trayIcons)
        if (i) DestroyIcon(i);
    if (mutex) CloseHandle(mutex);
    return 0;
}
