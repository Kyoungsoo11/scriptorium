// Scriptorium.exe - the tray app (A0 spike). Proves that an unsigned, locally built GUI exe runs
// on this machine and can own a notification-area icon. Later units grow it into the real app
// (recording list, settings window, CLI integration); the pieces here are the ones they keep:
//
//   - one instance per user session (named mutex); a second launch tells the first to show itself
//   - a tray icon that is re-added when Explorer restarts ("TaskbarCreated")
//   - a small window that never gets a taskbar button; closing it hides it
//
//   Scriptorium.exe                 start (or bring the running instance forward)
//   Scriptorium.exe --probe <file>  start, add the tray icon, write a JSON report to <file>, exit
//                                   after 3 s (used by scripts to check the exe runs at all)

#define WIN32_LEAN_AND_MEAN
#define NOMINMAX
#include <windows.h>
#include <shellapi.h>
#include <windowsx.h>
#include <commctrl.h>

#include <cstdio>
#include <string>

namespace {

constexpr wchar_t kMutexName[] = L"Local\\Scriptorium.App";
constexpr wchar_t kWindowClass[] = L"Scriptorium.App";
constexpr wchar_t kShowMessageName[] = L"Scriptorium.App.Show";
constexpr UINT kTrayId = 1;
constexpr UINT WM_TRAY = WM_APP + 1;
constexpr UINT ID_SHOW = 100;
constexpr UINT ID_EXIT = 101;
constexpr UINT_PTR TIMER_PROBE = 1;

HINSTANCE g_inst;
HWND g_wnd;
UINT g_taskbarCreated;
UINT g_showMessage;
bool g_trayAdded = false;
std::wstring g_probeFile;

HICON loadAppIcon(int size) {
    return static_cast<HICON>(LoadImageW(g_inst, MAKEINTRESOURCEW(1), IMAGE_ICON, size, size, LR_DEFAULTCOLOR));
}

bool addTrayIcon() {
    NOTIFYICONDATAW nid{};
    nid.cbSize = sizeof nid;
    nid.hWnd = g_wnd;
    nid.uID = kTrayId;
    nid.uFlags = NIF_ICON | NIF_TIP | NIF_MESSAGE | NIF_SHOWTIP;
    nid.uCallbackMessage = WM_TRAY;
    nid.hIcon = loadAppIcon(GetSystemMetrics(SM_CXSMICON));
    wcscpy_s(nid.szTip, L"Scriptorium");
    bool ok = Shell_NotifyIconW(NIM_ADD, &nid) != FALSE;
    if (ok) {
        nid.uVersion = NOTIFYICON_VERSION_4;
        Shell_NotifyIconW(NIM_SETVERSION, &nid);
    }
    g_trayAdded = ok;
    return ok;
}

void removeTrayIcon() {
    NOTIFYICONDATAW nid{};
    nid.cbSize = sizeof nid;
    nid.hWnd = g_wnd;
    nid.uID = kTrayId;
    Shell_NotifyIconW(NIM_DELETE, &nid);
    g_trayAdded = false;
}

void showWindow() {
    // Not SW_SHOWNORMAL: on a process's first ShowWindow call Windows replaces SW_SHOWNORMAL with
    // the launcher's STARTUPINFO show state, which started the window minimized in testing.
    ShowWindow(g_wnd, SW_SHOW);
    if (IsIconic(g_wnd)) ShowWindow(g_wnd, SW_RESTORE);
    SetForegroundWindow(g_wnd);
}

/** Window size in device pixels for a size given at 96 DPI (100 % scaling). */
int scaled(int px, UINT dpi) { return MulDiv(px, (int)dpi, 96); }

void showMenu(POINT pt) {
    HMENU menu = CreatePopupMenu();
    AppendMenuW(menu, MF_STRING, ID_SHOW, L"열기");
    AppendMenuW(menu, MF_SEPARATOR, 0, nullptr);
    AppendMenuW(menu, MF_STRING, ID_EXIT, L"종료");
    SetMenuDefaultItem(menu, ID_SHOW, FALSE);
    SetForegroundWindow(g_wnd);  // otherwise the menu does not close when clicking elsewhere
    TrackPopupMenuEx(menu, TPM_RIGHTBUTTON | TPM_BOTTOMALIGN, pt.x, pt.y, g_wnd, nullptr);
    PostMessageW(g_wnd, WM_NULL, 0, 0);
    DestroyMenu(menu);
}

std::string utf8(const std::wstring &w) {
    if (w.empty()) return {};
    int n = WideCharToMultiByte(CP_UTF8, 0, w.c_str(), (int)w.size(), nullptr, 0, nullptr, nullptr);
    std::string s(n, '\0');
    WideCharToMultiByte(CP_UTF8, 0, w.c_str(), (int)w.size(), s.data(), n, nullptr, nullptr);
    return s;
}

void writeProbe() {
    FILE *f = _wfopen(g_probeFile.c_str(), L"wb");
    if (!f) return;
    wchar_t exe[MAX_PATH];
    GetModuleFileNameW(nullptr, exe, MAX_PATH);
    std::string path = utf8(exe);
    std::string esc;
    for (char c : path) {
        if (c == '\\' || c == '"') esc += '\\';
        esc += c;
    }
    fprintf(f, "{\"ok\":true,\"pid\":%lu,\"tray\":%s,\"dpi\":%u,\"exe\":\"%s\"}\n", GetCurrentProcessId(),
            g_trayAdded ? "true" : "false", GetDpiForWindow(g_wnd), esc.c_str());
    fclose(f);
}

LRESULT CALLBACK wndProc(HWND hwnd, UINT msg, WPARAM wp, LPARAM lp) {
    if (msg == g_taskbarCreated && g_taskbarCreated) {
        addTrayIcon();  // Explorer restarted: the icon is gone until we add it again
        return 0;
    }
    if (msg == g_showMessage && g_showMessage) {
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
        if (LOWORD(wp) == ID_SHOW) showWindow();
        else if (LOWORD(wp) == ID_EXIT) DestroyWindow(hwnd);
        return 0;
    case WM_TIMER:
        if (wp == TIMER_PROBE) {
            KillTimer(hwnd, TIMER_PROBE);
            writeProbe();
            DestroyWindow(hwnd);
        }
        return 0;
    case WM_DPICHANGED: {  // moved to a monitor with a different scale
        const RECT *r = reinterpret_cast<const RECT *>(lp);
        SetWindowPos(hwnd, nullptr, r->left, r->top, r->right - r->left, r->bottom - r->top,
                     SWP_NOZORDER | SWP_NOACTIVATE);
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
        HFONT font = static_cast<HFONT>(GetStockObject(DEFAULT_GUI_FONT));
        HGDIOBJ old = SelectObject(dc, font);
        DrawTextW(dc, L"Scriptorium (A0 spike)", -1, &rc, DT_CENTER | DT_VCENTER | DT_SINGLELINE);
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
    g_inst = inst;
    int argc = 0;
    wchar_t **argv = CommandLineToArgvW(GetCommandLineW(), &argc);
    for (int i = 1; i < argc; i++) {
        if (std::wstring(argv[i]) == L"--probe" && i + 1 < argc) g_probeFile = argv[++i];
    }
    LocalFree(argv);

    g_showMessage = RegisterWindowMessageW(kShowMessageName);
    // A probe runs alongside a real instance, so it skips the single-instance check.
    HANDLE mutex = nullptr;
    if (g_probeFile.empty()) {
        mutex = CreateMutexW(nullptr, TRUE, kMutexName);
        if (GetLastError() == ERROR_ALREADY_EXISTS) {
            // HWND_BROADCAST would reach every top-level window; find ours instead.
            if (HWND other = FindWindowW(kWindowClass, nullptr)) {
                DWORD pid = 0;
                GetWindowThreadProcessId(other, &pid);
                AllowSetForegroundWindow(pid);
                PostMessageW(other, g_showMessage, 0, 0);
            }
            return 0;
        }
    }

    INITCOMMONCONTROLSEX icc{sizeof icc, ICC_STANDARD_CLASSES};
    InitCommonControlsEx(&icc);

    WNDCLASSEXW wc{sizeof wc};
    wc.lpfnWndProc = wndProc;
    wc.hInstance = inst;
    wc.hIcon = loadAppIcon(GetSystemMetrics(SM_CXICON));
    wc.hIconSm = loadAppIcon(GetSystemMetrics(SM_CXSMICON));
    wc.hCursor = LoadCursorW(nullptr, IDC_ARROW);
    wc.lpszClassName = g_probeFile.empty() ? kWindowClass : L"Scriptorium.App.Probe";
    RegisterClassExW(&wc);

    g_taskbarCreated = RegisterWindowMessageW(L"TaskbarCreated");
    // WS_EX_TOOLWINDOW keeps the window off the taskbar; the tray icon is the way in.
    g_wnd = CreateWindowExW(WS_EX_TOOLWINDOW, wc.lpszClassName, L"Scriptorium",
                            WS_OVERLAPPED | WS_CAPTION | WS_SYSMENU, CW_USEDEFAULT, CW_USEDEFAULT, 340, 300,
                            nullptr, nullptr, inst, nullptr);
    if (!g_wnd) return 1;
    // Lets Explorer's TaskbarCreated broadcast through UIPI if we ever run elevated.
    ChangeWindowMessageFilterEx(g_wnd, g_taskbarCreated, MSGFLT_ALLOW, nullptr);
    ChangeWindowMessageFilterEx(g_wnd, g_showMessage, MSGFLT_ALLOW, nullptr);
    UINT dpi = GetDpiForWindow(g_wnd);
    SetWindowPos(g_wnd, nullptr, 0, 0, scaled(340, dpi), scaled(300, dpi), SWP_NOMOVE | SWP_NOZORDER | SWP_NOACTIVATE);

    addTrayIcon();
    if (!g_probeFile.empty()) SetTimer(g_wnd, TIMER_PROBE, 3000, nullptr);
    else showWindow();

    MSG m;
    while (GetMessageW(&m, nullptr, 0, 0) > 0) {
        TranslateMessage(&m);
        DispatchMessageW(&m);
    }
    if (mutex) CloseHandle(mutex);
    return 0;
}
