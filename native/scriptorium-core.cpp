// scriptorium-core.exe - native helper for Scriptorium. Replaces Alt's closed native modules with
// Windows APIs and whisper.cpp:
//
//   scriptorium-core devices                       JSON list of audio endpoints
//   scriptorium-core decode <file>                 any audio/video file -> 16 kHz mono f32le on stdout
//                                         (Media Foundation; first stderr line: {"duration":s})
//   scriptorium-core capture [--mic <id|default|none>] [--no-system]
//                                         microphone + system audio (WASAPI loopback), mixed,
//                                         16 kHz mono f32le on stdout until stdin closes or "stop"
//   scriptorium-core whisper --model <file> [--lang ko] [--threads n] [--beam n] [--prompt text]
//                   [--no-gpu] [--gpu n]
//                                         persistent recognizer. Request on stdin:
//                                         "T <id> <offset_ms> <n_samples> [lang]\n" + n_samples float32;
//                                         reply on stdout: one JSON line per request.
//
// All diagnostics go to stderr as JSON lines. No network access anywhere.

#define WIN32_LEAN_AND_MEAN
#define NOMINMAX
#include <windows.h>
#include <initguid.h>
#include <mmdeviceapi.h>
#include <audioclient.h>
#include <functiondiscoverykeys_devpkey.h>
#include <mfapi.h>
#include <mfidl.h>
#include <mfreadwrite.h>
#include <fcntl.h>
#include <io.h>

#include <atomic>
#include <cmath>
#include <cstdint>
#include <cstdio>
#include <cstring>
#include <deque>
#include <string>
#include <thread>
#include <vector>

#include "ggml-backend.h"
#include "whisper.h"

#pragma comment(lib, "ole32.lib")
#pragma comment(lib, "mfplat.lib")
#pragma comment(lib, "mfreadwrite.lib")
#pragma comment(lib, "mfuuid.lib")

static const int SR = 16000;
static const double PI = 3.14159265358979323846;

// ---- small utilities --------------------------------------------------------------------------

static std::string utf8(const std::wstring &w) {
    if (w.empty()) return {};
    int n = WideCharToMultiByte(CP_UTF8, 0, w.c_str(), (int)w.size(), nullptr, 0, nullptr, nullptr);
    std::string s(n, '\0');
    WideCharToMultiByte(CP_UTF8, 0, w.c_str(), (int)w.size(), &s[0], n, nullptr, nullptr);
    return s;
}

static std::string jstr(const std::string &s) {
    std::string o = "\"";
    for (unsigned char c : s) {
        switch (c) {
            case '"': o += "\\\""; break;
            case '\\': o += "\\\\"; break;
            case '\n': o += "\\n"; break;
            case '\r': o += "\\r"; break;
            case '\t': o += "\\t"; break;
            default:
                if (c < 0x20) {
                    char b[8];
                    snprintf(b, sizeof b, "\\u%04x", c);
                    o += b;
                } else {
                    o += (char)c;
                }
        }
    }
    return o + "\"";
}

static void logj(const std::string &json) {
    fprintf(stderr, "%s\n", json.c_str());
    fflush(stderr);
}

static int fail(const std::string &msg, HRESULT hr = S_OK) {
    char b[32] = "";
    if (hr != S_OK) snprintf(b, sizeof b, " (0x%08lx)", (unsigned long)hr);
    logj("{\"error\":" + jstr(msg + b) + "}");
    return 1;
}

static void writeSamples(const float *p, size_t n) {
    if (n == 0) return;
    fwrite(p, sizeof(float), n, stdout);
    fflush(stdout);
}

static std::wstring exeDir() {
    wchar_t buf[MAX_PATH];
    DWORD n = GetModuleFileNameW(nullptr, buf, MAX_PATH);
    std::wstring p(buf, n);
    return p.substr(0, p.find_last_of(L"\\/"));
}

template <class T> struct Com {
    T *p = nullptr;
    ~Com() { if (p) p->Release(); }
    T **operator&() { return &p; }
    T *operator->() const { return p; }
    operator T *() const { return p; }
};

// ---- streaming resampler (windowed sinc) -------------------------------------------------------

class Resampler {
public:
    Resampler(int inRate, int outRate) : step_((double)inRate / outRate) {
        cutoff_ = std::min(1.0, (double)outRate / inRate) * 0.95;
    }
    // Appends resampled output of `in` (mono) to `out`.
    void process(const float *in, size_t n, std::vector<float> &out) {
        buf_.insert(buf_.end(), in, in + n);
        if (step_ == 1.0) {
            out.insert(out.end(), buf_.begin(), buf_.end());
            base_ += (double)buf_.size();
            buf_.clear();
            return;
        }
        for (;;) {
            double rel = pos_ - base_;
            long long center = (long long)std::floor(rel);
            if (center + H >= (long long)buf_.size()) break;
            double acc = 0, wsum = 0;
            for (long long k = center - H + 1; k <= center + H; k++) {
                double x = rel - (double)k;
                double s = (x == 0) ? 1.0 : std::sin(PI * cutoff_ * x) / (PI * cutoff_ * x);
                double w = 0.42 + 0.5 * std::cos(PI * x / H) + 0.08 * std::cos(2 * PI * x / H);
                double c = cutoff_ * s * w;
                float v = (k >= 0) ? buf_[(size_t)k] : 0.f;
                acc += c * v;
                wsum += c;
            }
            out.push_back((float)(wsum != 0 ? acc / wsum : 0));
            pos_ += step_;
        }
        // Drop input no longer needed (keep H samples of history before the next center).
        long long keep = (long long)std::floor(pos_ - base_) - H;
        if (keep > 0) {
            buf_.erase(buf_.begin(), buf_.begin() + (size_t)std::min<long long>(keep, (long long)buf_.size()));
            base_ += (double)keep;
        }
    }
    void flush(std::vector<float> &out) {
        std::vector<float> pad(H * 2, 0.f);
        process(pad.data(), pad.size(), out);
    }

private:
    static const int H = 24;
    double step_, cutoff_;
    double pos_ = 0, base_ = 0;
    std::vector<float> buf_;
};

// ---- devices ------------------------------------------------------------------------------------

static std::string deviceName(IMMDevice *d) {
    Com<IPropertyStore> ps;
    if (FAILED(d->OpenPropertyStore(STGM_READ, &ps))) return "";
    PROPVARIANT v;
    PropVariantInit(&v);
    std::string name;
    if (SUCCEEDED(ps->GetValue(PKEY_Device_FriendlyName, &v)) && v.vt == VT_LPWSTR) name = utf8(v.pwszVal);
    PropVariantClear(&v);
    return name;
}

static std::string deviceId(IMMDevice *d) {
    LPWSTR id = nullptr;
    std::string s;
    if (SUCCEEDED(d->GetId(&id))) {
        s = utf8(id);
        CoTaskMemFree(id);
    }
    return s;
}

static int cmdDevices() {
    Com<IMMDeviceEnumerator> en;
    HRESULT hr = CoCreateInstance(__uuidof(MMDeviceEnumerator), nullptr, CLSCTX_ALL, IID_PPV_ARGS(&en));
    if (FAILED(hr)) return fail("cannot open audio devices", hr);
    std::string out = "[";
    bool first = true;
    for (EDataFlow flow : {eCapture, eRender}) {
        std::string def;
        Com<IMMDevice> d0;
        if (SUCCEEDED(en->GetDefaultAudioEndpoint(flow, eConsole, &d0))) def = deviceId(d0);
        Com<IMMDeviceCollection> col;
        if (FAILED(en->EnumAudioEndpoints(flow, DEVICE_STATE_ACTIVE, &col))) continue;
        UINT n = 0;
        col->GetCount(&n);
        for (UINT i = 0; i < n; i++) {
            Com<IMMDevice> d;
            if (FAILED(col->Item(i, &d))) continue;
            std::string id = deviceId(d);
            out += std::string(first ? "" : ",") + "{\"id\":" + jstr(id) + ",\"name\":" + jstr(deviceName(d)) +
                   ",\"input\":" + (flow == eCapture ? "true" : "false") +
                   ",\"output\":" + (flow == eRender ? "true" : "false") +
                   ",\"default\":" + (id == def ? "true" : "false") + "}";
            first = false;
        }
    }
    printf("%s]\n", out.c_str());
    return 0;
}

// ---- decode (Media Foundation) -----------------------------------------------------------------

static int cmdDecode(const std::wstring &path) {
    HRESULT hr = MFStartup(MF_VERSION);
    if (FAILED(hr)) return fail("Media Foundation is not available", hr);
    Com<IMFSourceReader> reader;
    hr = MFCreateSourceReaderFromURL(path.c_str(), nullptr, &reader);
    if (FAILED(hr)) return fail("cannot open " + utf8(path), hr);
    reader->SetStreamSelection((DWORD)MF_SOURCE_READER_ALL_STREAMS, FALSE);
    hr = reader->SetStreamSelection((DWORD)MF_SOURCE_READER_FIRST_AUDIO_STREAM, TRUE);
    if (FAILED(hr)) return fail("no audio track in " + utf8(path), hr);

    Com<IMFMediaType> want;
    MFCreateMediaType(&want);
    want->SetGUID(MF_MT_MAJOR_TYPE, MFMediaType_Audio);
    want->SetGUID(MF_MT_SUBTYPE, MFAudioFormat_Float);
    hr = reader->SetCurrentMediaType((DWORD)MF_SOURCE_READER_FIRST_AUDIO_STREAM, nullptr, want);
    if (FAILED(hr)) return fail("cannot decode the audio track (missing codec?)", hr);
    Com<IMFMediaType> cur;
    reader->GetCurrentMediaType((DWORD)MF_SOURCE_READER_FIRST_AUDIO_STREAM, &cur);
    UINT32 channels = MFGetAttributeUINT32(cur, MF_MT_AUDIO_NUM_CHANNELS, 1);
    UINT32 rate = MFGetAttributeUINT32(cur, MF_MT_AUDIO_SAMPLES_PER_SECOND, SR);

    PROPVARIANT dur;
    PropVariantInit(&dur);
    double seconds = -1;
    if (SUCCEEDED(reader->GetPresentationAttribute((DWORD)MF_SOURCE_READER_MEDIASOURCE, MF_PD_DURATION, &dur)))
        seconds = dur.uhVal.QuadPart / 1e7;
    PropVariantClear(&dur);
    char b[160];
    snprintf(b, sizeof b, "{\"duration\":%.3f,\"sourceRate\":%u,\"channels\":%u}", seconds, rate, channels);
    logj(b);

    Resampler rs((int)rate, SR);
    std::vector<float> mono, out;
    for (;;) {
        DWORD flags = 0;
        Com<IMFSample> sample;
        hr = reader->ReadSample((DWORD)MF_SOURCE_READER_FIRST_AUDIO_STREAM, 0, nullptr, &flags, nullptr, &sample);
        if (FAILED(hr)) return fail("decoding failed", hr);
        if (sample) {
            Com<IMFMediaBuffer> buf;
            sample->ConvertToContiguousBuffer(&buf);
            BYTE *data = nullptr;
            DWORD len = 0;
            buf->Lock(&data, nullptr, &len);
            const float *f = (const float *)data;
            size_t frames = len / sizeof(float) / channels;
            mono.resize(frames);
            for (size_t i = 0; i < frames; i++) {
                float s = 0;
                for (UINT32 c = 0; c < channels; c++) s += f[i * channels + c];
                mono[i] = s / channels;
            }
            buf->Unlock();
            out.clear();
            rs.process(mono.data(), frames, out);
            writeSamples(out.data(), out.size());
        }
        if (flags & MF_SOURCE_READERF_ENDOFSTREAM) break;
    }
    out.clear();
    rs.flush(out);
    writeSamples(out.data(), out.size());
    MFShutdown();
    return 0;
}

// ---- capture (WASAPI) ---------------------------------------------------------------------------

struct Source {
    const char *label;
    bool loopback;
    Com<IAudioClient> client;
    Com<IAudioCaptureClient> cap;
    int channels = 1;
    bool isFloat = true;
    int bits = 32;
    Resampler *rs = nullptr;  // only when the device would not convert for us
    std::deque<float> q;
    bool alive = false;

    HRESULT open(IMMDevice *dev) {
        HRESULT hr = dev->Activate(__uuidof(IAudioClient), CLSCTX_ALL, nullptr, (void **)&client);
        if (FAILED(hr)) return hr;
        DWORD flags = loopback ? AUDCLNT_STREAMFLAGS_LOOPBACK : 0;
        // First choice: let Windows convert to 16 kHz mono float.
        WAVEFORMATEX f{};
        f.wFormatTag = WAVE_FORMAT_IEEE_FLOAT;
        f.nChannels = 1;
        f.nSamplesPerSec = SR;
        f.wBitsPerSample = 32;
        f.nBlockAlign = 4;
        f.nAvgBytesPerSec = SR * 4;
        hr = client->Initialize(AUDCLNT_SHAREMODE_SHARED,
                                flags | AUDCLNT_STREAMFLAGS_AUTOCONVERTPCM | AUDCLNT_STREAMFLAGS_SRC_DEFAULT_QUALITY,
                                2000000, 0, &f, nullptr);
        if (FAILED(hr)) {
            // Fallback: device mix format, converted here.
            client.p->Release();
            client.p = nullptr;
            hr = dev->Activate(__uuidof(IAudioClient), CLSCTX_ALL, nullptr, (void **)&client);
            if (FAILED(hr)) return hr;
            WAVEFORMATEX *mix = nullptr;
            hr = client->GetMixFormat(&mix);
            if (FAILED(hr)) return hr;
            channels = mix->nChannels;
            bits = mix->wBitsPerSample;
            isFloat = mix->wFormatTag == WAVE_FORMAT_IEEE_FLOAT ||
                      (mix->wFormatTag == WAVE_FORMAT_EXTENSIBLE &&
                       ((WAVEFORMATEXTENSIBLE *)mix)->SubFormat == KSDATAFORMAT_SUBTYPE_IEEE_FLOAT);
            rs = new Resampler((int)mix->nSamplesPerSec, SR);
            hr = client->Initialize(AUDCLNT_SHAREMODE_SHARED, flags, 2000000, 0, mix, nullptr);
            CoTaskMemFree(mix);
            if (FAILED(hr)) return hr;
        }
        hr = client->GetService(IID_PPV_ARGS(&cap));
        if (FAILED(hr)) return hr;
        hr = client->Start();
        alive = SUCCEEDED(hr);
        return hr;
    }

    // Moves available packets into q. Returns false when the device went away.
    bool poll() {
        if (!alive) return true;
        std::vector<float> mono, conv;
        for (;;) {
            UINT32 packet = 0;
            HRESULT hr = cap->GetNextPacketSize(&packet);
            if (FAILED(hr)) { alive = false; return false; }
            if (packet == 0) return true;
            BYTE *data = nullptr;
            UINT32 frames = 0;
            DWORD fl = 0;
            hr = cap->GetBuffer(&data, &frames, &fl, nullptr, nullptr);
            if (FAILED(hr)) { alive = false; return false; }
            mono.assign(frames, 0.f);
            if (!(fl & AUDCLNT_BUFFERFLAGS_SILENT)) {
                for (UINT32 i = 0; i < frames; i++) {
                    float s = 0;
                    for (int c = 0; c < channels; c++) {
                        size_t k = (size_t)i * channels + c;
                        if (isFloat) s += ((const float *)data)[k];
                        else if (bits == 16) s += ((const int16_t *)data)[k] / 32768.f;
                        else if (bits == 32) s += ((const int32_t *)data)[k] / 2147483648.f;
                    }
                    mono[i] = s / channels;
                }
            }
            cap->ReleaseBuffer(frames);
            if (rs) {
                conv.clear();
                rs->process(mono.data(), mono.size(), conv);
                q.insert(q.end(), conv.begin(), conv.end());
            } else {
                q.insert(q.end(), mono.begin(), mono.end());
            }
        }
    }
};

static int cmdCapture(const std::wstring &micArg, bool useSystem) {
    bool useMic = micArg != L"none";
    if (!useMic && !useSystem) return fail("nothing to capture: microphone and system audio are both off");
    Com<IMMDeviceEnumerator> en;
    HRESULT hr = CoCreateInstance(__uuidof(MMDeviceEnumerator), nullptr, CLSCTX_ALL, IID_PPV_ARGS(&en));
    if (FAILED(hr)) return fail("cannot open audio devices", hr);

    Source mic{"microphone", false}, sys{"system", true};
    std::string micName, sysName;
    if (useMic) {
        Com<IMMDevice> d;
        hr = (micArg.empty() || micArg == L"default") ? en->GetDefaultAudioEndpoint(eCapture, eConsole, &d)
                                                      : en->GetDevice(micArg.c_str(), &d);
        if (FAILED(hr)) return fail("microphone not found", hr);
        micName = deviceName(d);
        hr = mic.open(d);
        if (FAILED(hr)) return fail("cannot start the microphone " + micName, hr);
    }
    if (useSystem) {
        Com<IMMDevice> d;
        hr = en->GetDefaultAudioEndpoint(eRender, eConsole, &d);
        if (SUCCEEDED(hr)) {
            sysName = deviceName(d);
            hr = sys.open(d);
        }
        if (FAILED(hr)) {
            if (!useMic) return fail("cannot capture system audio", hr);
            logj("{\"warning\":\"system audio unavailable, recording the microphone only\"}");
            useSystem = false;
        }
    }
    logj("{\"event\":\"started\",\"microphone\":" + (useMic ? jstr(micName) : std::string("null")) +
         ",\"system\":" + (useSystem ? jstr(sysName) : std::string("null")) + "}");

    std::atomic<bool> stop{false};
    std::thread watcher([&] {
        char line[64];
        while (fgets(line, sizeof line, stdin)) {
            if (strncmp(line, "stop", 4) == 0) break;
        }
        stop = true;
    });
    watcher.detach();

    const size_t MAX_SYS_BACKLOG = SR / 2;  // drop system audio that falls more than 0.5 s behind
    ULONGLONG start = GetTickCount64();
    unsigned long long emitted = 0;
    std::vector<float> out;
    while (!stop) {
        Sleep(10);
        if (useMic && !mic.poll()) return fail("the microphone stopped (device removed?)");
        if (useSystem && !sys.poll()) {
            logj("{\"warning\":\"system audio stopped, continuing with the microphone\"}");
            useSystem = false;
            if (!useMic) return fail("system audio stopped");
        }
        out.clear();
        if (useMic) {
            // Microphone is the clock; system audio is added where it has samples (Alt's mixer).
            size_t n = mic.q.size();
            out.resize(n);
            for (size_t i = 0; i < n; i++) {
                float v = mic.q.front();
                mic.q.pop_front();
                if (useSystem && !sys.q.empty()) {
                    v += sys.q.front();
                    sys.q.pop_front();
                }
                out[i] = std::max(-1.f, std::min(1.f, v));
            }
        } else {
            // Loopback delivers nothing while nothing plays: keep time with the wall clock,
            // 100 ms behind to let late packets arrive.
            long long due = (long long)((GetTickCount64() - start) * (SR / 1000)) - SR / 10 - (long long)emitted;
            for (long long i = 0; i < due; i++) {
                float v = 0;
                if (!sys.q.empty()) {
                    v = sys.q.front();
                    sys.q.pop_front();
                }
                out.push_back(v);
            }
        }
        while (sys.q.size() > MAX_SYS_BACKLOG) sys.q.pop_front();
        emitted += out.size();
        writeSamples(out.data(), out.size());
    }
    if (mic.alive) mic.client->Stop();
    if (sys.alive) sys.client->Stop();
    char b[96];
    snprintf(b, sizeof b, "{\"event\":\"stopped\",\"seconds\":%.2f}", emitted / (double)SR);
    logj(b);
    return 0;
}

// ---- whisper ------------------------------------------------------------------------------------

struct FileCtx { FILE *f; };
static size_t rd(void *c, void *out, size_t n) { return fread(out, 1, n, ((FileCtx *)c)->f); }
static bool eofp(void *c) { return feof(((FileCtx *)c)->f) != 0; }
static void cls(void *c) { fclose(((FileCtx *)c)->f); }

static void quietLog(ggml_log_level, const char *, void *) {}

static bool readExact(void *dst, size_t n) {
    char *p = (char *)dst;
    while (n > 0) {
        size_t r = fread(p, 1, n, stdin);
        if (r == 0) return false;
        p += r;
        n -= r;
    }
    return true;
}

static int cmdWhisper(const std::wstring &model, const std::string &lang, int threads, int beam,
                      const std::string &prompt, bool useGpu, int gpu, bool verbose) {
    if (!verbose) whisper_log_set(quietLog, nullptr);
    ggml_backend_load_all_from_path(utf8(exeDir()).c_str());
    FILE *f = _wfopen(model.c_str(), L"rb");
    if (!f) return fail("cannot open model " + utf8(model));
    FileCtx fc{f};
    whisper_model_loader loader{&fc, rd, eofp, cls};
    whisper_context_params cp = whisper_context_default_params();
    cp.use_gpu = useGpu;
    cp.gpu_device = gpu;
    cp.flash_attn = useGpu;
    whisper_context *ctx = whisper_init_with_params(&loader, cp);
    if (!ctx) return fail("cannot load model " + utf8(model));
    logj("{\"event\":\"ready\",\"multilingual\":" + std::string(whisper_is_multilingual(ctx) ? "true" : "false") +
         ",\"system\":" + jstr(whisper_print_system_info()) + "}");

    std::vector<float> pcm;
    char line[256];
    while (fgets(line, sizeof line, stdin)) {
        long long id = 0, offsetMs = 0, n = 0;
        char reqLang[16] = "";
        // Optional 5th field: a language for this request only (e.g. "auto" for a retry).
        if (sscanf(line, "T %lld %lld %lld %15s", &id, &offsetMs, &n, reqLang) < 3 || n < 0) {
            logj("{\"error\":\"bad request header\"}");
            continue;
        }
        pcm.resize((size_t)n);
        if (!readExact(pcm.data(), (size_t)n * sizeof(float))) break;
        std::string useLang = reqLang[0] ? reqLang : lang;

        whisper_full_params p = whisper_full_default_params(beam > 1 ? WHISPER_SAMPLING_BEAM_SEARCH : WHISPER_SAMPLING_GREEDY);
        if (beam > 1) p.beam_search.beam_size = beam;
        p.n_threads = threads;
        p.language = useLang.c_str();
        p.translate = false;
        p.no_context = true;  // chunks are independent; avoids repetition carried across chunks
        p.print_progress = p.print_realtime = p.print_special = p.print_timestamps = false;
        p.suppress_nst = true;
        p.token_timestamps = true;  // per-token times: tighter than segment times
        if (!prompt.empty()) p.initial_prompt = prompt.c_str();

        std::string out = "{\"id\":" + std::to_string(id);
        // Whisper needs at least ~1 s; pad short chunks with silence.
        if (pcm.size() < (size_t)SR) pcm.resize(SR + SR / 10, 0.f);
        if (whisper_full(ctx, p, pcm.data(), (int)pcm.size()) != 0) {
            out += ",\"error\":\"recognition failed\"}";
        } else {
            out += ",\"lang\":" + jstr(whisper_lang_str(whisper_full_lang_id(ctx))) + ",\"segments\":[";
            int ns = whisper_full_n_segments(ctx);
            for (int i = 0; i < ns; i++) {
                long long t0 = whisper_full_get_segment_t0(ctx, i) * 10 + offsetMs;
                long long t1 = whisper_full_get_segment_t1(ctx, i) * 10 + offsetMs;
                // Span of the segment's text tokens (special tokens excluded), or -1.
                long long k0 = -1, k1 = -1;
                int nt = whisper_full_n_tokens(ctx, i);
                for (int j = 0; j < nt; j++) {
                    whisper_token_data td = whisper_full_get_token_data(ctx, i, j);
                    if (td.id >= whisper_token_eot(ctx) || td.t0 < 0 || td.t1 <= td.t0) continue;
                    if (k0 < 0 || td.t0 * 10 + offsetMs < k0) k0 = td.t0 * 10 + offsetMs;
                    if (td.t1 * 10 + offsetMs > k1) k1 = td.t1 * 10 + offsetMs;
                }
                char b[192];
                snprintf(b, sizeof b,
                         "{\"start\":%lld,\"end\":%lld,\"tokStart\":%lld,\"tokEnd\":%lld,\"noSpeech\":%.3f,\"text\":", t0,
                         t1, k0, k1, whisper_full_get_segment_no_speech_prob(ctx, i));
                out += std::string(i ? "," : "") + b + jstr(whisper_full_get_segment_text(ctx, i)) + "}";
            }
            out += "]}";
        }
        fprintf(stdout, "%s\n", out.c_str());
        fflush(stdout);
    }
    whisper_free(ctx);
    return 0;
}

// ---- main ---------------------------------------------------------------------------------------

int wmain(int argc, wchar_t **argv) {
    _setmode(_fileno(stdout), _O_BINARY);
    _setmode(_fileno(stdin), _O_BINARY);
    CoInitializeEx(nullptr, COINIT_MULTITHREADED);
    if (argc < 2) return fail("usage: scriptorium-core devices | decode <file> | capture [...] | whisper --model <file> [...]");
    std::wstring cmd = argv[1];
    auto opt = [&](const wchar_t *name, const std::wstring &def) {
        for (int i = 2; i + 1 < argc; i++)
            if (name == std::wstring(argv[i])) return std::wstring(argv[i + 1]);
        return def;
    };
    auto flag = [&](const wchar_t *name) {
        for (int i = 2; i < argc; i++)
            if (name == std::wstring(argv[i])) return true;
        return false;
    };
    if (cmd == L"devices") return cmdDevices();
    if (cmd == L"decode") return argc < 3 ? fail("decode needs a file") : cmdDecode(argv[2]);
    if (cmd == L"capture") return cmdCapture(opt(L"--mic", L"default"), !flag(L"--no-system"));
    if (cmd == L"whisper") {
        std::wstring model = opt(L"--model", L"");
        if (model.empty()) return fail("whisper needs --model");
        unsigned hw = std::thread::hardware_concurrency();
        int threads = _wtoi(opt(L"--threads", std::to_wstring(std::max(1u, std::min(16u, hw)))).c_str());
        return cmdWhisper(model, utf8(opt(L"--lang", L"auto")), threads, _wtoi(opt(L"--beam", L"5").c_str()),
                          utf8(opt(L"--prompt", L"")), !flag(L"--no-gpu"), _wtoi(opt(L"--gpu", L"0").c_str()),
                          flag(L"--verbose"));
    }
    return fail("unknown command");
}
