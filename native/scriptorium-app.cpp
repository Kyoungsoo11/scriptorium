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
#include <memory>
#include <set>
#include <string>
#include <thread>
#include <vector>

#include "app/json.h"
#include "app/util.h"

using namespace app;

namespace {

// One app per data folder: the names get a hash of the folder appended (see instanceSuffix).
constexpr wchar_t kMutexPrefix[] = L"Local\\Scriptorium.App.";
constexpr wchar_t kClassPrefix[] = L"Scriptorium.App.";
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
    ID_ROW_FIRST = 10000,  // window rows: + row * kRowIds + {title, status, stop}; above every other id
};
constexpr UINT kRowIds = 4;
constexpr UINT ID_EMPTY = 1900;
constexpr UINT ID_RUNNING_HEADER = 1901;
// the new-recording form
enum FormId : UINT {
    ID_NEW_HEADER = 3000,
    ID_LABEL,  // all field labels share it
    ID_TITLE,
    ID_FOLDER,
    ID_SOURCE,
    ID_MIC,
    ID_LANG,
    ID_ADVANCED,
    ID_SPEAKERS,
    ID_DURATION,
    ID_PROMPT,
    ID_START,
    ID_FORM_STATUS,
};
constexpr int kClientWidth = 360;  // at 96 DPI

constexpr UINT WM_LISTS_LOADED = WM_APP + 2;  // lParam: Lists* from a worker thread
constexpr UINT WM_START_DONE = WM_APP + 3;    // lParam: StartResult* from a worker thread

enum TimerId : UINT_PTR { TIMER_PROBE = 1, TIMER_POLL, TIMER_CLEAR_STATUS };
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
/**
 * One app per data folder: a hash of the folder (case-insensitive, no trailing slash) for the
 * mutex and window class names, so `scriptorium app --data-dir X` gets its own app for X.
 */
std::wstring instanceSuffix(const std::wstring &dataDir) {
    std::wstring d = dataDir;
    while (d.size() > 3 && (d.back() == L'\\' || d.back() == L'/')) d.pop_back();
    CharLowerBuffW(d.data(), (DWORD)d.size());
    unsigned long long h = 1469598103934665603ULL;  // FNV-1a
    for (wchar_t c : d) {
        h ^= (unsigned long long)c;
        h *= 1099511628211ULL;
    }
    wchar_t buf[17];
    swprintf_s(buf, L"%016llx", h);
    return buf;
}

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
    std::wstring rowsShape = L"\x1";  // keys + stop-button visibility the rows were built for (none yet)
    HWND runningHeader = nullptr, emptyLabel = nullptr;
    HWND lastFocus = nullptr;  // focused control when the window was last deactivated
    bool modal = false;        // a message box is open
} g;

UINT windowDpi() { return g.wnd ? GetDpiForWindow(g.wnd) : 96; }
int scaled(int px, UINT dpi) { return MulDiv(px, (int)dpi, 96); }
int S(int px) { return scaled(px, windowDpi()); }

bool busy() { return !g.activities.empty(); }

enum RowPart { ROW_TITLE = 0, ROW_STATUS = 1, ROW_STOP = 2 };

/** Which part of a window row a control id is (ROW_*), with the row; -1 for any other control. */
int rowPart(UINT id, size_t *row) {
    if (id < ID_ROW_FIRST) return -1;
    size_t r = (id - ID_ROW_FIRST) / kRowIds;
    if (r >= g.rows.size()) return -1;
    *row = r;
    return (int)((id - ID_ROW_FIRST) % kRowIds);
}

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
    if (Shell_NotifyIconW(NIM_MODIFY, &nid)) g.trayAdded = true;  // also when NIM_ADD timed out but worked
    else addTrayIcon();
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

int layoutForm(int m, int y, int w);
void requestLists();
void poll();
void restoreFocus();

/** Height of the client area; positions every control: running work on top, the new-recording form below. */
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
    if (!g.rows.empty()) y -= S(4);
    return layoutForm(m, y + S(6), w) + m;
}

/** Sizes the window to its content (fixed width), keeping its bottom edge where it was. */
void fitWindow() {
    UINT dpi = windowDpi();
    int clientW = scaled(kClientWidth, dpi);
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
    MONITORINFO mi{sizeof mi};
    GetMonitorInfoW(MonitorFromWindow(g.wnd, MONITOR_DEFAULTTONEAREST), &mi);
    int top = std::max<int>(wr.bottom - h, mi.rcWork.top);  // keep the title bar on screen
    if (wr.bottom - wr.top != h || wr.top != top)
        SetWindowPos(g.wnd, nullptr, wr.left, top, frameW, h, SWP_NOZORDER | SWP_NOACTIVATE);
    layout();
    // Moved controls leave their old pixels behind otherwise (WS_CLIPCHILDREN keeps the parent
    // from painting under them while they move).
    RedrawWindow(g.wnd, nullptr, nullptr, RDW_INVALIDATE | RDW_ERASE | RDW_ALLCHILDREN | RDW_UPDATENOW);
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
        HWND focus = GetFocus();
        bool rowHadFocus = false;
        for (const Row &r : g.rows) rowHadFocus |= focus && (focus == r.stop || focus == r.title || focus == r.status);
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
        if (rowHadFocus) restoreFocus();  // its 정지 button is gone
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
    if (!IsWindowVisible(g.wnd)) {
        placeNearTray();
        requestLists();  // microphones and folders may have changed while it was hidden
    }
    ShowWindow(g.wnd, SW_SHOW);
    if (IsIconic(g.wnd)) ShowWindow(g.wnd, SW_RESTORE);
    SetForegroundWindow(g.wnd);
    g.idleSince = 0;
}

void openDataFolder() {
    makeDirs(g.paths.dataDir);
    ShellExecuteW(g.wnd, L"open", g.paths.dataDir.c_str(), nullptr, nullptr, SW_SHOWNORMAL);
}

// ---- new-recording form -----------------------------------------------------------------

/** What the user picked last time, kept in <data>\gui.json. */
struct Settings {
    int source = 0;  // 0 microphone + computer audio, 1 computer audio only, 2 microphone only
    std::wstring mic = L"default";
    std::wstring lang = L"ko";
    std::wstring folder;
    bool advanced = false;
};

struct Form {
    HWND header = nullptr;
    std::vector<HWND> labels;  // 제목, 폴더, 소리, 마이크, 언어, 화자 수, 시간 제한, 단어 힌트
    HWND title = nullptr, folder = nullptr, source = nullptr, mic = nullptr, lang = nullptr;
    HWND advanced = nullptr, speakers = nullptr, duration = nullptr, prompt = nullptr;
    HWND start = nullptr, status = nullptr;
    bool statusError = false;
    std::vector<std::wstring> micIds;  // parallel to the mic combo's items
    bool starting = false;
    bool listsLoading = false;
    Settings settings;
    bool listsLoaded = false;  // the microphone list came back at least once
} form;

/** Focus for the window when it becomes active: the control that had it, else the title field. */
void restoreFocus() {
    HWND h = g.lastFocus;
    if (!h || !IsWindow(h) || !IsChild(g.wnd, h) || !IsWindowVisible(h) || !IsWindowEnabled(h)) h = form.title;
    if (h) SetFocus(h);
}

const wchar_t *kLanguages[][2] = {{L"ko", L"한국어"}, {L"en", L"영어"}, {L"auto", L"자동 감지"}};
const wchar_t *kSources[] = {L"마이크 + 컴퓨터 소리", L"컴퓨터 소리만", L"마이크만"};

std::wstring windowText(HWND h) {
    int n = GetWindowTextLengthW(h);
    std::wstring s(n, L'\0');
    if (n) GetWindowTextW(h, s.data(), n + 1);
    // trim spaces at both ends
    size_t a = s.find_first_not_of(L" \t\r\n"), b = s.find_last_not_of(L" \t\r\n");
    return a == std::wstring::npos ? std::wstring() : s.substr(a, b - a + 1);
}

std::wstring settingsPath() { return joinPath(g.paths.dataDir, L"gui.json"); }

void loadSettings() {
    bool ok = false;
    std::string text = readFile(settingsPath(), &ok);
    Json j;
    if (!ok || !parseJson(text, j) || j.type != Json::Object) return;
    Settings &s = form.settings;
    s.source = std::clamp((int)j.number(L"source", 0), 0, 2);
    s.mic = j.text(L"mic", L"default");
    s.lang = j.text(L"lang", L"ko");
    s.folder = j.text(L"folder");
    s.advanced = j.flag(L"advanced");
}

void saveSettings() {
    const Settings &s = form.settings;
    std::string json = "{\"source\":" + std::to_string(s.source) + ",\"mic\":" + jsonString(s.mic) +
                       ",\"lang\":" + jsonString(s.lang) + ",\"folder\":" + jsonString(s.folder) +
                       ",\"advanced\":" + (s.advanced ? "true" : "false") + "}\n";
    makeDirs(g.paths.dataDir);
    writeFileAtomic(settingsPath(), json);
}

void setFormStatus(const std::wstring &text, bool error) {
    form.statusError = error;
    SetWindowTextW(form.status, text.c_str());
    InvalidateRect(form.status, nullptr, TRUE);
    KillTimer(g.wnd, TIMER_CLEAR_STATUS);
    fitWindow();
}

void updateFormEnabled() {
    int source = (int)SendMessageW(form.source, CB_GETCURSEL, 0, 0);
    EnableWindow(form.mic, source != 1);  // computer audio only: no microphone to pick
    EnableWindow(form.start, !form.starting);
}

void createForm() {
    ensureFonts();
    auto label = [](const wchar_t *text) {
        form.labels.push_back(makeChild(L"STATIC", text, SS_LEFT | SS_NOPREFIX | SS_CENTERIMAGE, ID_LABEL, g.font));
    };
    auto edit = [](UINT id, const wchar_t *cue, DWORD extra = 0) {
        HWND h = CreateWindowExW(WS_EX_CLIENTEDGE, L"EDIT", L"", WS_CHILD | WS_VISIBLE | WS_TABSTOP | ES_AUTOHSCROLL | extra,
                                 0, 0, 0, 0, g.wnd, reinterpret_cast<HMENU>(static_cast<UINT_PTR>(id)), g.inst, nullptr);
        SendMessageW(h, WM_SETFONT, reinterpret_cast<WPARAM>(g.font), FALSE);
        SendMessageW(h, EM_SETCUEBANNER, TRUE, reinterpret_cast<LPARAM>(cue));
        return h;
    };
    auto combo = [](UINT id, DWORD style) {
        return makeChild(L"COMBOBOX", L"", style | WS_TABSTOP | WS_VSCROLL, id, g.font);
    };

    form.header = makeChild(L"STATIC", L"새 녹음", SS_LEFT | SS_NOPREFIX, ID_NEW_HEADER, g.boldFont);
    label(L"제목");
    form.title = edit(ID_TITLE, L"비워두면 날짜와 시간");
    label(L"폴더");
    form.folder = combo(ID_FOLDER, CBS_DROPDOWN | CBS_AUTOHSCROLL);
    if (HWND inner = FindWindowExW(form.folder, nullptr, L"Edit", nullptr))
        SendMessageW(inner, EM_SETCUEBANNER, TRUE, reinterpret_cast<LPARAM>(L"폴더 없음 (새 이름이면 만들어요)"));
    label(L"소리");
    form.source = combo(ID_SOURCE, CBS_DROPDOWNLIST);
    for (const wchar_t *s : kSources) SendMessageW(form.source, CB_ADDSTRING, 0, reinterpret_cast<LPARAM>(s));
    label(L"마이크");
    form.mic = combo(ID_MIC, CBS_DROPDOWNLIST);
    SendMessageW(form.mic, CB_ADDSTRING, 0, reinterpret_cast<LPARAM>(L"기본 마이크"));
    form.micIds = {L"default"};
    label(L"언어");
    form.lang = combo(ID_LANG, CBS_DROPDOWNLIST);
    for (auto &l : kLanguages) SendMessageW(form.lang, CB_ADDSTRING, 0, reinterpret_cast<LPARAM>(l[1]));
    form.advanced = makeChild(L"BUTTON", L"고급 설정", BS_AUTOCHECKBOX | WS_TABSTOP, ID_ADVANCED, g.font);
    label(L"화자 수");
    form.speakers = edit(ID_SPEAKERS, L"자동", ES_NUMBER);
    label(L"시간 제한");
    form.duration = edit(ID_DURATION, L"없음 (예: 50m, 1h30m)");
    label(L"단어 힌트");
    form.prompt = edit(ID_PROMPT, L"전문 용어를 쉼표로 (예: 세마포어, LRU)");
    form.start = makeChild(L"BUTTON", L"녹음 시작", BS_DEFPUSHBUTTON | WS_TABSTOP, ID_START, g.font);
    form.status = makeChild(L"STATIC", L"", SS_LEFT | SS_NOPREFIX, ID_FORM_STATUS, g.font);

    const Settings &s = form.settings;
    SendMessageW(form.source, CB_SETCURSEL, s.source, 0);
    SendMessageW(form.mic, CB_SETCURSEL, 0, 0);
    int lang = 0;
    for (int i = 0; i < (int)std::size(kLanguages); i++)
        if (s.lang == kLanguages[i][0]) lang = i;
    SendMessageW(form.lang, CB_SETCURSEL, lang, 0);
    SetWindowTextW(form.folder, s.folder.c_str());
    Button_SetCheck(form.advanced, s.advanced ? BST_CHECKED : BST_UNCHECKED);
    updateFormEnabled();
}

int layoutForm(int m, int y, int w) {
    if (!form.header) return y;
    const int labelW = S(68), fieldX = m + labelW, fieldW = w - labelW, rowH = S(26), gap = S(6);
    SetWindowPos(form.header, nullptr, m, y, w, S(20), SWP_NOZORDER);
    y += S(26);
    bool advanced = Button_GetCheck(form.advanced) == BST_CHECKED;
    HWND fields[] = {form.title, form.folder, form.source, form.mic, form.lang};
    for (int i = 0; i < 5; i++) {
        SetWindowPos(form.labels[i], nullptr, m, y, labelW - S(6), rowH, SWP_NOZORDER);
        // a combo box's height includes its drop-down list
        bool isCombo = fields[i] != form.title;
        SetWindowPos(fields[i], nullptr, fieldX, y, fieldW, isCombo ? S(240) : rowH, SWP_NOZORDER);
        y += rowH + gap;
    }
    SetWindowPos(form.advanced, nullptr, fieldX, y, fieldW, S(22), SWP_NOZORDER);
    y += S(22) + gap;
    HWND extra[] = {form.speakers, form.duration, form.prompt};
    for (int i = 0; i < 3; i++) {
        ShowWindow(form.labels[5 + i], advanced ? SW_SHOW : SW_HIDE);
        ShowWindow(extra[i], advanced ? SW_SHOW : SW_HIDE);
        if (!advanced) continue;
        SetWindowPos(form.labels[5 + i], nullptr, m, y, labelW - S(6), rowH, SWP_NOZORDER);
        SetWindowPos(extra[i], nullptr, fieldX, y, i == 0 ? S(80) : fieldW, rowH, SWP_NOZORDER);
        y += rowH + gap;
    }
    y += S(4);
    const int startW = S(116), startH = S(30);
    SetWindowPos(form.start, nullptr, m + w - startW, y, startW, startH, SWP_NOZORDER);
    y += startH;
    if (GetWindowTextLengthW(form.status)) {
        // measure the status text so long errors wrap instead of being cut off
        std::wstring text = windowText(form.status);
        HDC dc = GetDC(form.status);
        HGDIOBJ old = SelectObject(dc, g.font);
        RECT r{0, 0, w, 0};
        DrawTextW(dc, text.c_str(), -1, &r, DT_CALCRECT | DT_WORDBREAK | DT_NOPREFIX);
        SelectObject(dc, old);
        ReleaseDC(form.status, dc);
        int h = std::min<int>(r.bottom, S(120));
        SetWindowPos(form.status, nullptr, m, y + S(8), w, h, SWP_NOZORDER);
        ShowWindow(form.status, SW_SHOW);
        y += S(8) + h;
    } else {
        ShowWindow(form.status, SW_HIDE);
    }
    return y;
}

// -- device and folder lists, loaded off the UI thread through the CLI --

struct Lists {
    bool devicesOk = false, foldersOk = false;
    std::vector<std::pair<std::wstring, std::wstring>> mics;  // id, label
    std::wstring defaultMic;
    std::vector<std::wstring> folders;
};

std::vector<std::wstring> cliArgs(std::initializer_list<std::wstring> rest) {
    std::vector<std::wstring> a = {g.paths.node, g.paths.cli};
    a.insert(a.end(), rest.begin(), rest.end());
    a.push_back(L"--data-dir");
    a.push_back(g.paths.dataDir);
    return a;
}

bool cliReady() { return fileExists(g.paths.node) && fileExists(g.paths.cli); }

void requestLists() {
    if (form.listsLoading || !cliReady()) return;
    form.listsLoading = true;
    std::vector<std::wstring> devices = cliArgs({L"devices"}), folders = cliArgs({L"folders", L"list"});
    HWND wnd = g.wnd;
    std::thread([wnd, devices, folders] {
        auto *lists = new Lists();
        RunResult d = runAndCapture(devices, 30000);
        Json j;
        if (d.exitCode == 0 && parseJson(d.out, j)) {
            if (const Json *audio = j.get(L"audio"); audio && audio->type == Json::Array) {
                lists->devicesOk = true;
                for (const Json &dev : audio->arr) {
                    if (!dev.flag(L"input")) continue;
                    std::wstring name = dev.text(L"name");
                    if (dev.flag(L"default")) lists->defaultMic = name;
                    lists->mics.emplace_back(dev.text(L"id"), name + (dev.flag(L"muted") ? L" (음소거됨)" : L""));
                }
            }
        }
        RunResult fo = runAndCapture(folders, 30000);
        Json k;
        if (fo.exitCode == 0 && parseJson(fo.out, k) && k.type == Json::Array) {
            lists->foldersOk = true;
            for (const Json &folder : k.arr) lists->folders.push_back(folder.text(L"name"));
        }
        if (!PostMessageW(wnd, WM_LISTS_LOADED, 0, reinterpret_cast<LPARAM>(lists))) delete lists;
    }).detach();
}

void applyLists(std::unique_ptr<Lists> lists) {
    form.listsLoading = false;
    if (lists->devicesOk) {
        int cur = std::max(0, (int)SendMessageW(form.mic, CB_GETCURSEL, 0, 0));
        std::wstring current = cur < (int)form.micIds.size() ? form.micIds[cur] : L"default";
        if (!form.listsLoaded) current = form.settings.mic;  // first load: the saved choice
        form.listsLoaded = true;
        SendMessageW(form.mic, CB_RESETCONTENT, 0, 0);
        form.micIds = {L"default"};
        std::wstring def = lists->defaultMic.empty() ? L"기본 마이크" : L"기본 마이크 (" + lists->defaultMic + L")";
        SendMessageW(form.mic, CB_ADDSTRING, 0, reinterpret_cast<LPARAM>(def.c_str()));
        int sel = 0;
        for (auto &[id, label] : lists->mics) {
            SendMessageW(form.mic, CB_ADDSTRING, 0, reinterpret_cast<LPARAM>(label.c_str()));
            if (id == current) sel = (int)form.micIds.size();
            form.micIds.push_back(id);
        }
        SendMessageW(form.mic, CB_SETCURSEL, sel, 0);
    }
    if (lists->foldersOk) {
        std::wstring text = windowText(form.folder);
        SendMessageW(form.folder, CB_RESETCONTENT, 0, 0);
        for (const auto &name : lists->folders) SendMessageW(form.folder, CB_ADDSTRING, 0, reinterpret_cast<LPARAM>(name.c_str()));
        SetWindowTextW(form.folder, text.c_str());
    }
}

// -- starting a recording --

struct StartResult {
    bool ok = false;
    std::wstring title, typed, message;
};

/** "Recording 2026-11-18 14:30", like the CLI's default, plus " (2)" if that title is already running. */
std::wstring defaultTitle() {
    SYSTEMTIME st;
    GetLocalTime(&st);
    wchar_t buf[64];
    swprintf_s(buf, L"Recording %04d-%02d-%02d %02d:%02d", st.wYear, st.wMonth, st.wDay, st.wHour, st.wMinute);
    std::wstring base = buf, title = base;
    for (int n = 2;; n++) {
        bool taken = std::any_of(g.activities.begin(), g.activities.end(), [&](const Activity &a) { return a.title == title; });
        if (!taken) return title;
        title = base + L" (" + std::to_wstring(n) + L")";
    }
}

/** The CLI's error line without its "scriptorium: " prefix and usage hint. */
std::wstring cliError(const RunResult &r) {
    std::wstring err = wide(r.err);
    size_t i = err.rfind(L"scriptorium: ");
    if (i != std::wstring::npos) err = err.substr(i + 13);
    if (size_t hint = err.find(L"\nRun \"scriptorium help\""); hint != std::wstring::npos) err = err.substr(0, hint);
    while (!err.empty() && (err.back() == L'\n' || err.back() == L'\r')) err.pop_back();
    if (err.empty()) err = L"녹음을 시작하지 못했어요 (종료 코드 " + std::to_wstring(r.exitCode) + L")";
    return err;
}

void startRecording() {
    if (form.starting) return;
    if (!cliReady()) {
        std::wstring what = !fileExists(g.paths.node) ? (g.paths.node.empty() ? L"node.exe (PATH에 없음)" : g.paths.node)
                                                      : g.paths.cli;
        setFormStatus(L"Scriptorium 명령줄 도구를 찾지 못했어요: " + what, true);
        return;
    }
    std::wstring typed = windowText(form.title);
    std::wstring title = typed.empty() ? defaultTitle() : typed;
    int source = std::max(0, (int)SendMessageW(form.source, CB_GETCURSEL, 0, 0));
    int micSel = std::max(0, (int)SendMessageW(form.mic, CB_GETCURSEL, 0, 0));
    std::wstring micId = micSel < (int)form.micIds.size() ? form.micIds[micSel] : L"default";
    if (!form.listsLoaded) micId = form.settings.mic;  // the list (with the saved choice) has not arrived yet
    int langSel = std::clamp((int)SendMessageW(form.lang, CB_GETCURSEL, 0, 0), 0, (int)std::size(kLanguages) - 1);
    std::wstring folder = windowText(form.folder);
    bool advanced = Button_GetCheck(form.advanced) == BST_CHECKED;
    std::wstring speakers = advanced ? windowText(form.speakers) : L"";
    std::wstring duration = advanced ? windowText(form.duration) : L"";
    std::wstring prompt = advanced ? windowText(form.prompt) : L"";
    if (!speakers.empty() && _wtoi(speakers.c_str()) < 1) {
        setFormStatus(L"화자 수는 1 이상의 숫자로 적어 주세요.", true);
        return;
    }

    std::vector<std::wstring> args = {g.paths.node, g.paths.cli, L"record", L"--detach", L"--data-dir", g.paths.dataDir,
                                      L"--title", title, L"--lang", kLanguages[langSel][0]};
    if (!folder.empty()) args.insert(args.end(), {L"--folder", folder});
    if (source == 1) args.insert(args.end(), {L"--mic", L"none"});
    else args.insert(args.end(), {L"--mic", micId});
    if (source == 2) args.push_back(L"--no-system");
    if (!speakers.empty()) args.insert(args.end(), {L"--speakers", speakers});
    if (!duration.empty()) args.insert(args.end(), {L"--duration", duration});
    if (!prompt.empty()) args.insert(args.end(), {L"--prompt", prompt});

    form.settings = {source, micId, kLanguages[langSel][0], folder, advanced};
    saveSettings();
    form.starting = true;
    updateFormEnabled();
    setFormStatus(L"녹음을 준비하는 중… (음성 인식 모델을 불러오느라 몇 초 걸려요)", false);

    HWND wnd = g.wnd;
    std::thread([wnd, args, title, typed] {
        auto *res = new StartResult();
        res->title = title;
        res->typed = typed;
        // `record --detach` returns once the recorder runs (it waits up to 90 s for that)
        RunResult r = runAndCapture(args, 120000);
        res->ok = r.started && r.exitCode == 0;
        if (!r.started) res->message = L"node.exe를 실행하지 못했어요";
        else if (!res->ok) res->message = cliError(r);
        if (!PostMessageW(wnd, WM_START_DONE, 0, reinterpret_cast<LPARAM>(res))) delete res;
    }).detach();
}

void onStartDone(std::unique_ptr<StartResult> res) {
    form.starting = false;
    updateFormEnabled();
    if (res->ok) {
        // the next recording gets its own title, unless one was typed while this one started
        if (windowText(form.title) == res->typed) SetWindowTextW(form.title, L"");
        setFormStatus(L"'" + res->title + L"' 녹음을 시작했어요", false);
        SetTimer(g.wnd, TIMER_CLEAR_STATUS, 6000, nullptr);
    } else {
        setFormStatus(res->message, true);
    }
    poll();
}

// ---- reading the run folder ------------------------------------------------------------

/**
 * True when `pid` belongs to a process created after the work began: the writer died and Windows
 * reused its pid (a killed transcription leaves its file behind). The writer itself always
 * starts before it records startedAt; a minute of slack covers clock adjustments.
 */
bool startedAfter(DWORD pid, ULONGLONG startedMs) {
    if (!startedMs) return false;
    HANDLE h = OpenProcess(PROCESS_QUERY_LIMITED_INFORMATION, FALSE, pid);
    if (!h) return false;
    FILETIME created, exited, kernel, user;
    bool ok = GetProcessTimes(h, &created, &exited, &kernel, &user) != FALSE;
    CloseHandle(h);
    return ok && fileTimeEpochMs(created) > startedMs + 60000;
}

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
                if (!processAlive(a.pid) || startedAfter(a.pid, a.startedMs)) {
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
                    Finished fin;
                    fin.recording = j.text(L"kind") == L"recording";
                    fin.ok = j.flag(L"ok");
                    fin.title = j.text(L"title");
                    fin.error = j.text(L"error");
                    finished.push_back(std::move(fin));
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
        const Finished &fin = finished[0];
        std::wstring what = fin.recording ? L"녹음" : L"파일 전사";
        if (fin.ok) notify(what + L" 완료", fin.title + L" — 노트에 저장했어요");
        else notify(what + L" 실패", fin.title + (fin.error.empty() ? L"" : L": " + fin.error), true);
        return;
    }
    int failed = (int)std::count_if(finished.begin(), finished.end(), [](const Finished &x) { return !x.ok; });
    std::wstring text;
    for (const Finished &fin : finished) text += (text.empty() ? L"" : L", ") + fin.title + (fin.ok ? L"" : L" (실패)");
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
    // a start in flight, an open window or an open prompt keeps the app
    bool inUse = form.starting || g.modal || IsWindowVisible(g.wnd);
    if ((g.resident && !g.exitWhenIdle) || g.probe || busy() || inUse) {
        g.idleSince = 0;
        return;
    }
    ULONGLONG now = GetTickCount64();
    if (!g.idleSince) g.idleSince = now;
    else if (now - g.idleSince >= kIdleExitMs) DestroyWindow(g.wnd);
}

void poll() {
    if (!IsWindow(g.wnd)) return;
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
int modalBox(const std::wstring &text, UINT flags) {
    g.modal = true;
    int r = MessageBoxW(g.wnd, text.c_str(), L"Scriptorium 종료", flags | MB_SETFOREGROUND);
    g.modal = false;
    return r;
}

void requestExit() {
    if (form.starting) {
        // the recorder is about to start; quitting now would leave it running with no icon
        modalBox(L"녹음을 시작하는 중이에요. 시작된 뒤에 다시 종료해 주세요.", MB_OK | MB_ICONINFORMATION);
        return;
    }
    if (!busy()) {
        DestroyWindow(g.wnd);
        return;
    }
    int live = liveRecordings(), finishing = 0, files = 0;
    for (const Activity &a : g.activities) {
        if (a.recording && !a.live()) finishing++;
        else if (!a.recording) files++;
    }
    std::wstring text;
    if (live) text = L"녹음 " + std::to_wstring(live) + L"개를 정지하고, ";
    std::wstring waits;
    if (live || finishing) waits = L"녹음 전사";
    if (files) waits += (waits.empty() ? L"" : L"와 ") + std::wstring(L"파일 전사 ") + std::to_wstring(files) + L"개";
    text += waits + L"가 모두 끝나면 Scriptorium을 종료할까요?\n\n그때까지는 트레이 아이콘이 남아 있어요.";
    if (modalBox(text, MB_OKCANCEL | MB_ICONQUESTION) != IDOK || !IsWindow(g.wnd)) return;
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

void onCommand(UINT id, UINT code) {
    if (id >= ID_STOP_FIRST && id < ID_STOP_FIRST + g.menuStopKeys.size()) {
        stopRecording(g.menuStopKeys[id - ID_STOP_FIRST]);
        poll();
        return;
    }
    size_t row = 0;
    if (rowPart(id, &row) == ROW_STOP) {  // a row's 정지 button
        if (row < g.activities.size() && g.activities[row].live()) stopRecording(g.activities[row].key);
        poll();
        return;
    }
    switch (id) {
    case IDCANCEL: ShowWindow(g.wnd, SW_HIDE); break;  // Esc
    case IDOK:  // Enter
    case ID_START:
        if (code == BN_CLICKED) startRecording();
        break;
    case ID_SOURCE:
        if (code == CBN_SELCHANGE) updateFormEnabled();
        break;
    case ID_ADVANCED:
        if (code == BN_CLICKED) fitWindow();
        break;
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
        onCommand(LOWORD(wp), HIWORD(wp));
        return 0;
    case WM_TIMER:
        if (wp == TIMER_PROBE) {
            KillTimer(hwnd, TIMER_PROBE);
            writeProbe();
            DestroyWindow(hwnd);
        } else if (wp == TIMER_POLL) {
            poll();
        } else if (wp == TIMER_CLEAR_STATUS) {
            KillTimer(hwnd, TIMER_CLEAR_STATUS);
            if (!form.starting && !form.statusError) setFormStatus(L"", false);
        }
        return 0;
    case WM_CTLCOLORSTATIC: {
        HDC dc = reinterpret_cast<HDC>(wp);
        HWND ctl = reinterpret_cast<HWND>(lp);
        UINT id = (UINT)GetDlgCtrlID(ctl);
        SetBkColor(dc, GetSysColor(COLOR_WINDOW));
        COLORREF color = GetSysColor(COLOR_WINDOWTEXT);
        if (id == ID_EMPTY) color = GetSysColor(COLOR_GRAYTEXT);
        else if (id == ID_FORM_STATUS) color = form.statusError ? RGB(196, 43, 28) : GetSysColor(COLOR_GRAYTEXT);
        else if (size_t row = 0; rowPart(id, &row) == ROW_STATUS)
            color = g.rows[row].warn ? RGB(196, 43, 28) : GetSysColor(COLOR_GRAYTEXT);
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
            size_t row = 0;
            bool bold = id == ID_RUNNING_HEADER || id == ID_NEW_HEADER || rowPart(id, &row) == ROW_TITLE;
            SendMessageW(c, WM_SETFONT, reinterpret_cast<WPARAM>(bold ? g.boldFont : g.font), TRUE);
        }
        fitWindow();
        return 0;
    }
    case WM_ACTIVATE:
        if (LOWORD(wp) == WA_INACTIVE) {
            HWND focus = GetFocus();
            if (focus && IsChild(hwnd, focus)) g.lastFocus = focus;
        } else {
            restoreFocus();
        }
        return 0;
    case WM_LISTS_LOADED:
        applyLists(std::unique_ptr<Lists>(reinterpret_cast<Lists *>(lp)));
        return 0;
    case WM_START_DONE:
        onStartDone(std::unique_ptr<StartResult>(reinterpret_cast<StartResult *>(lp)));
        return 0;
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
    const std::wstring windowClass = kClassPrefix + instanceSuffix(g.paths.dataDir);
    // A probe runs alongside a real instance, so it skips the single-instance check.
    HANDLE mutex = nullptr;
    if (!g.probe) {
        mutex = CreateMutexW(nullptr, TRUE, (kMutexPrefix + instanceSuffix(g.paths.dataDir)).c_str());
        if (GetLastError() == ERROR_ALREADY_EXISTS) {
            // Background launches only make sure the app runs; a user launch brings it forward.
            if (!background) {
                if (HWND other = FindWindowW(windowClass.c_str(), nullptr)) {
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
    wc.lpszClassName = g.probe ? kProbeClass : windowClass.c_str();
    RegisterClassExW(&wc);

    g.taskbarCreated = RegisterWindowMessageW(L"TaskbarCreated");
    // WS_EX_TOOLWINDOW keeps the window off the taskbar; the tray icon is the way in.
    // WS_EX_CONTROLPARENT lets Tab move between the buttons and fields.
    g.wnd = CreateWindowExW(WS_EX_TOOLWINDOW | WS_EX_CONTROLPARENT, wc.lpszClassName, L"Scriptorium",
                            WS_OVERLAPPED | WS_CAPTION | WS_SYSMENU | WS_CLIPCHILDREN, CW_USEDEFAULT, CW_USEDEFAULT, kClientWidth,
                            300, nullptr, nullptr, inst, nullptr);
    if (!g.wnd) return 1;
    // Lets Explorer's TaskbarCreated broadcast through UIPI if we ever run elevated.
    ChangeWindowMessageFilterEx(g.wnd, g.taskbarCreated, MSGFLT_ALLOW, nullptr);
    ChangeWindowMessageFilterEx(g.wnd, g.showMessage, MSGFLT_ALLOW, nullptr);

    addTrayIcon();
    loadSettings();
    createForm();
    poll();  // builds the window's content and sizes it
    if (!g.probe) requestLists();
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
