// Scriptorium.exe - the tray app. A small Win32 program that lives in the notification area while
// Scriptorium is working: it shows what is recording or transcribing, starts new recordings and
// stops running ones. It does no audio work itself; it runs the CLI (`scriptorium record --detach`)
// and watches the state files the CLI keeps in <data>\run, so recordings started from the CLI or
// from Claude (MCP) show up here too, and closing the app never stops a recording.
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

enum MenuId : UINT { ID_SHOW = 100, ID_OPEN_DATA, ID_EXIT };
enum TimerId : UINT_PTR { TIMER_PROBE = 1, TIMER_POLL };
constexpr ULONGLONG kIdleExitMs = 15000;  // background mode: linger so the last notice can be read

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

// ---- state ------------------------------------------------------------------------

enum class TrayState { Idle, Recording, Working };

struct App {
    HINSTANCE inst = nullptr;
    HWND wnd = nullptr;
    Paths paths;
    bool resident = false;  // opened by the user: stays until "종료"
    bool probe = false;
    std::wstring probeFile;
    UINT taskbarCreated = 0;
    UINT showMessage = 0;
    bool trayAdded = false;
    TrayState trayState = TrayState::Idle;
    std::wstring tip = L"Scriptorium";
    HICON trayIcons[3] = {};
    UINT trayIconDpi = 0;
    HFONT font = nullptr;
    UINT fontDpi = 0;
    ULONGLONG idleSince = 0;
} g;

UINT windowDpi() { return g.wnd ? GetDpiForWindow(g.wnd) : 96; }
int scaled(int px, UINT dpi) { return MulDiv(px, (int)dpi, 96); }

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

// ---- window -------------------------------------------------------------------------------

HFONT uiFont() {
    UINT dpi = windowDpi();
    if (g.font && g.fontDpi == dpi) return g.font;
    if (g.font) DeleteObject(g.font);
    NONCLIENTMETRICSW ncm{sizeof ncm};
    SystemParametersInfoForDpi(SPI_GETNONCLIENTMETRICS, sizeof ncm, &ncm, 0, dpi);
    g.font = CreateFontIndirectW(&ncm.lfMessageFont);
    g.fontDpi = dpi;
    return g.font;
}

/** Puts the window in the lower right of the work area, next to the notification area. */
void placeNearTray() {
    RECT wr;
    GetWindowRect(g.wnd, &wr);
    MONITORINFO mi{sizeof mi};
    HWND taskbar = FindWindowW(L"Shell_TrayWnd", nullptr);
    GetMonitorInfoW(MonitorFromWindow(taskbar ? taskbar : g.wnd, MONITOR_DEFAULTTOPRIMARY), &mi);
    int margin = scaled(12, windowDpi());
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

// ---- running work -------------------------------------------------------------------

/** True while anything is recording or transcribing (filled in by the activity monitor). */
bool busy() { return false; }

/** Background mode ends by itself a little while after the last piece of work. */
void checkIdleExit() {
    if (g.resident || g.probe) {
        g.idleSince = 0;
        return;
    }
    if (busy()) {
        g.idleSince = 0;
        return;
    }
    ULONGLONG now = GetTickCount64();
    if (!g.idleSince) g.idleSince = now;
    else if (now - g.idleSince >= kIdleExitMs) DestroyWindow(g.wnd);
}

void requestExit() { DestroyWindow(g.wnd); }

// ---- menu -----------------------------------------------------------------------------------

void showMenu(POINT pt) {
    HMENU menu = CreatePopupMenu();
    AppendMenuW(menu, MF_STRING, ID_SHOW, L"열기");
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
    switch (id) {
    case ID_SHOW: showWindow(); break;
    case ID_OPEN_DATA: openDataFolder(); break;
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
    json += "}\n";
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
        if (wp == 1) g.resident = true;  // the user opened the app: it stays
        showWindow();
        return 0;
    }
    switch (msg) {
    case WM_TRAY:
        switch (LOWORD(lp)) {
        case WM_LBUTTONUP:
        case NIN_SELECT:
        case NIN_KEYSELECT:
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
            checkIdleExit();
        }
        return 0;
    case WM_DPICHANGED: {  // moved to a monitor with a different scale
        const RECT *r = reinterpret_cast<const RECT *>(lp);
        SetWindowPos(hwnd, nullptr, r->left, r->top, r->right - r->left, r->bottom - r->top,
                     SWP_NOZORDER | SWP_NOACTIVATE);
        g.trayIconDpi = 0;
        setTray(g.trayState, g.tip);
        InvalidateRect(hwnd, nullptr, TRUE);
        return 0;
    }
    case WM_CLOSE:
        ShowWindow(hwnd, SW_HIDE);  // closing hides; "종료" in the tray menu exits
        return 0;
    case WM_PAINT: {
        PAINTSTRUCT ps;
        HDC dc = BeginPaint(hwnd, &ps);
        RECT rc;
        GetClientRect(hwnd, &rc);
        FillRect(dc, &rc, GetSysColorBrush(COLOR_WINDOW));
        SetBkMode(dc, TRANSPARENT);
        SetTextColor(dc, GetSysColor(COLOR_GRAYTEXT));
        HGDIOBJ old = SelectObject(dc, uiFont());
        DrawTextW(dc, L"진행 중인 작업이 없어요", -1, &rc, DT_CENTER | DT_VCENTER | DT_SINGLELINE);
        SelectObject(dc, old);
        EndPaint(hwnd, &ps);
        return 0;
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
    g.wnd = CreateWindowExW(WS_EX_TOOLWINDOW, wc.lpszClassName, L"Scriptorium", WS_OVERLAPPED | WS_CAPTION | WS_SYSMENU,
                            CW_USEDEFAULT, CW_USEDEFAULT, 340, 300, nullptr, nullptr, inst, nullptr);
    if (!g.wnd) return 1;
    // Lets Explorer's TaskbarCreated broadcast through UIPI if we ever run elevated.
    ChangeWindowMessageFilterEx(g.wnd, g.taskbarCreated, MSGFLT_ALLOW, nullptr);
    ChangeWindowMessageFilterEx(g.wnd, g.showMessage, MSGFLT_ALLOW, nullptr);
    UINT dpi = windowDpi();
    SetWindowPos(g.wnd, nullptr, 0, 0, scaled(340, dpi), scaled(300, dpi), SWP_NOMOVE | SWP_NOZORDER | SWP_NOACTIVATE);

    addTrayIcon();
    SetTimer(g.wnd, TIMER_POLL, 1000, nullptr);
    if (g.probe) SetTimer(g.wnd, TIMER_PROBE, 3000, nullptr);
    else if (g.resident) showWindow();

    MSG m;
    while (GetMessageW(&m, nullptr, 0, 0) > 0) {
        TranslateMessage(&m);
        DispatchMessageW(&m);
    }
    for (HICON i : g.trayIcons)
        if (i) DestroyIcon(i);
    if (mutex) CloseHandle(mutex);
    return 0;
}
