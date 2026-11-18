// Small helpers for Scriptorium.exe: UTF-8 <-> UTF-16, paths, files, processes.
#pragma once

#define WIN32_LEAN_AND_MEAN
#define NOMINMAX
#include <windows.h>

#include <string>
#include <vector>

namespace app {

inline std::wstring wide(const std::string &s) {
    if (s.empty()) return {};
    int n = MultiByteToWideChar(CP_UTF8, 0, s.data(), (int)s.size(), nullptr, 0);
    std::wstring w(n, L'\0');
    MultiByteToWideChar(CP_UTF8, 0, s.data(), (int)s.size(), w.data(), n);
    return w;
}

inline std::string utf8(const std::wstring &w) {
    if (w.empty()) return {};
    int n = WideCharToMultiByte(CP_UTF8, 0, w.data(), (int)w.size(), nullptr, 0, nullptr, nullptr);
    std::string s(n, '\0');
    WideCharToMultiByte(CP_UTF8, 0, w.data(), (int)w.size(), s.data(), n, nullptr, nullptr);
    return s;
}

inline std::wstring joinPath(const std::wstring &a, const std::wstring &b) {
    if (a.empty()) return b;
    wchar_t last = a.back();
    return (last == L'\\' || last == L'/') ? a + b : a + L"\\" + b;
}

inline std::wstring parentDir(const std::wstring &p) {
    size_t i = p.find_last_of(L"\\/");
    return i == std::wstring::npos ? std::wstring() : p.substr(0, i);
}

inline std::wstring fileName(const std::wstring &p) {
    size_t i = p.find_last_of(L"\\/");
    return i == std::wstring::npos ? p : p.substr(i + 1);
}

inline bool fileExists(const std::wstring &p) {
    DWORD a = GetFileAttributesW(p.c_str());
    return a != INVALID_FILE_ATTRIBUTES && !(a & FILE_ATTRIBUTE_DIRECTORY);
}

inline bool dirExists(const std::wstring &p) {
    DWORD a = GetFileAttributesW(p.c_str());
    return a != INVALID_FILE_ATTRIBUTES && (a & FILE_ATTRIBUTE_DIRECTORY);
}

inline std::wstring fullPath(const std::wstring &p) {
    wchar_t buf[MAX_PATH * 4];
    DWORD n = GetFullPathNameW(p.c_str(), (DWORD)std::size(buf), buf, nullptr);
    return n && n < std::size(buf) ? std::wstring(buf, n) : p;
}

inline std::wstring envVar(const wchar_t *name) {
    wchar_t buf[MAX_PATH * 4];
    DWORD n = GetEnvironmentVariableW(name, buf, (DWORD)std::size(buf));
    return n && n < std::size(buf) ? std::wstring(buf, n) : std::wstring();
}

inline std::wstring exePath() {
    wchar_t buf[MAX_PATH * 4];
    DWORD n = GetModuleFileNameW(nullptr, buf, (DWORD)std::size(buf));
    return std::wstring(buf, n);
}

/** Whole file as bytes; empty with ok=false when it cannot be read. */
inline std::string readFile(const std::wstring &p, bool *ok = nullptr) {
    std::string out;
    HANDLE h = CreateFileW(p.c_str(), GENERIC_READ, FILE_SHARE_READ | FILE_SHARE_WRITE | FILE_SHARE_DELETE, nullptr,
                           OPEN_EXISTING, FILE_ATTRIBUTE_NORMAL, nullptr);
    if (h == INVALID_HANDLE_VALUE) {
        if (ok) *ok = false;
        return out;
    }
    char buf[16384];
    DWORD got = 0;
    while (ReadFile(h, buf, sizeof buf, &got, nullptr) && got) out.append(buf, got);
    CloseHandle(h);
    if (ok) *ok = true;
    return out;
}

/** Writes via a temporary file and a rename, so readers never see half a file. */
inline bool writeFileAtomic(const std::wstring &p, const std::string &data) {
    std::wstring tmp = p + L".tmp";
    HANDLE h = CreateFileW(tmp.c_str(), GENERIC_WRITE, 0, nullptr, CREATE_ALWAYS, FILE_ATTRIBUTE_NORMAL, nullptr);
    if (h == INVALID_HANDLE_VALUE) return false;
    DWORD put = 0;
    bool ok = WriteFile(h, data.data(), (DWORD)data.size(), &put, nullptr) && put == data.size();
    CloseHandle(h);
    if (!ok || !MoveFileExW(tmp.c_str(), p.c_str(), MOVEFILE_REPLACE_EXISTING)) {
        DeleteFileW(tmp.c_str());
        return false;
    }
    return true;
}

/** Creates a directory and its parents. */
inline void makeDirs(const std::wstring &p) {
    if (p.empty() || dirExists(p)) return;
    makeDirs(parentDir(p));
    CreateDirectoryW(p.c_str(), nullptr);
}

/** Quotes one argument for CreateProcess the way CommandLineToArgvW / the MSVC CRT parse it. */
inline std::wstring quoteArg(const std::wstring &a) {
    if (!a.empty() && a.find_first_of(L" \t\n\v\"") == std::wstring::npos) return a;
    std::wstring q = L"\"";
    size_t backslashes = 0;
    for (wchar_t c : a) {
        if (c == L'\\') {
            backslashes++;
        } else if (c == L'"') {
            q.append(backslashes * 2 + 1, L'\\');
            q += L'"';
            backslashes = 0;
        } else {
            q.append(backslashes, L'\\');
            q += c;
            backslashes = 0;
        }
    }
    q.append(backslashes * 2, L'\\');
    q += L'"';
    return q;
}

inline std::wstring commandLine(const std::vector<std::wstring> &args) {
    std::wstring cmd;
    for (const auto &a : args) {
        if (!cmd.empty()) cmd += L' ';
        cmd += quoteArg(a);
    }
    return cmd;
}

/** True while the process exists (a pid from a state file may belong to a recorder that died). */
inline bool processAlive(DWORD pid) {
    if (!pid) return false;
    HANDLE h = OpenProcess(SYNCHRONIZE | PROCESS_QUERY_LIMITED_INFORMATION, FALSE, pid);
    if (!h) return GetLastError() == ERROR_ACCESS_DENIED;  // exists, owned by someone else
    bool alive = WaitForSingleObject(h, 0) == WAIT_TIMEOUT;
    CloseHandle(h);
    return alive;
}

/** Starts a program with no console window and does not wait for it. */
inline bool launchDetached(const std::vector<std::wstring> &args, DWORD *pidOut = nullptr) {
    std::wstring cmd = commandLine(args);
    STARTUPINFOW si{sizeof si};
    PROCESS_INFORMATION pi{};
    if (!CreateProcessW(args[0].c_str(), cmd.data(), nullptr, nullptr, FALSE,
                        CREATE_NO_WINDOW | CREATE_NEW_PROCESS_GROUP, nullptr, nullptr, &si, &pi))
        return false;
    if (pidOut) *pidOut = pi.dwProcessId;
    CloseHandle(pi.hThread);
    CloseHandle(pi.hProcess);
    return true;
}

/**
 * Runs a program with no console window, waits for it, and returns its exit code with stdout and
 * stderr. Output goes through temporary files rather than pipes: `record --detach` leaves a
 * recorder running that may inherit the handles, and a pipe would then never report its end.
 * The files are delete-on-close, so they vanish once the last holder (maybe that recorder) closes.
 */
struct RunResult {
    bool started = false;
    DWORD exitCode = 1;
    std::string out, err;
};

inline HANDLE tempCaptureFile(SECURITY_ATTRIBUTES *sa) {
    wchar_t dir[MAX_PATH], name[MAX_PATH];
    GetTempPathW(MAX_PATH, dir);
    if (!GetTempFileNameW(dir, L"scr", 0, name)) return INVALID_HANDLE_VALUE;
    return CreateFileW(name, GENERIC_READ | GENERIC_WRITE, FILE_SHARE_READ | FILE_SHARE_WRITE | FILE_SHARE_DELETE, sa,
                       CREATE_ALWAYS, FILE_ATTRIBUTE_TEMPORARY | FILE_FLAG_DELETE_ON_CLOSE, nullptr);
}

inline std::string readFromStart(HANDLE h) {
    std::string out;
    if (h == INVALID_HANDLE_VALUE) return out;
    SetFilePointer(h, 0, nullptr, FILE_BEGIN);
    char buf[16384];
    DWORD got = 0;
    while (ReadFile(h, buf, sizeof buf, &got, nullptr) && got) out.append(buf, got);
    return out;
}

inline RunResult runAndCapture(const std::vector<std::wstring> &args, DWORD timeoutMs = INFINITE) {
    RunResult r;
    SECURITY_ATTRIBUTES sa{sizeof sa, nullptr, TRUE};
    HANDLE out = tempCaptureFile(&sa);
    HANDLE err = tempCaptureFile(&sa);
    HANDLE nul = CreateFileW(L"NUL", GENERIC_READ, FILE_SHARE_READ | FILE_SHARE_WRITE, &sa, OPEN_EXISTING, 0, nullptr);
    std::wstring cmd = commandLine(args);
    STARTUPINFOW si{sizeof si};
    si.dwFlags = STARTF_USESTDHANDLES;
    si.hStdInput = nul;
    si.hStdOutput = out;
    si.hStdError = err;
    PROCESS_INFORMATION pi{};
    if (out != INVALID_HANDLE_VALUE && err != INVALID_HANDLE_VALUE &&
        CreateProcessW(args[0].c_str(), cmd.data(), nullptr, nullptr, TRUE, CREATE_NO_WINDOW, nullptr, nullptr, &si,
                       &pi)) {
        r.started = true;
        if (WaitForSingleObject(pi.hProcess, timeoutMs) == WAIT_TIMEOUT) TerminateProcess(pi.hProcess, 1);
        GetExitCodeProcess(pi.hProcess, &r.exitCode);
        CloseHandle(pi.hThread);
        CloseHandle(pi.hProcess);
    }
    r.out = readFromStart(out);
    r.err = readFromStart(err);
    if (out != INVALID_HANDLE_VALUE) CloseHandle(out);
    if (err != INVALID_HANDLE_VALUE) CloseHandle(err);
    if (nul != INVALID_HANDLE_VALUE) CloseHandle(nul);
    return r;
}

}  // namespace app
