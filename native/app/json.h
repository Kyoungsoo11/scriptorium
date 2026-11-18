// A small JSON reader and string escaper for Scriptorium.exe. Enough for the CLI's state files and
// command output: objects, arrays, strings (with \u escapes and surrogate pairs), numbers, true,
// false, null. Strings come back as UTF-16.
#pragma once

#include <cstdio>
#include <cstdlib>
#include <cstring>
#include <memory>
#include <string>
#include <utility>
#include <vector>

#include "util.h"

namespace app {

struct Json {
    enum Type { Null, Bool, Number, String, Array, Object } type = Null;
    bool b = false;
    double num = 0;
    std::wstring str;
    std::vector<Json> arr;
    std::vector<std::pair<std::wstring, Json>> obj;

    const Json *get(const wchar_t *key) const {
        if (type != Object) return nullptr;
        for (const auto &kv : obj)
            if (kv.first == key) return &kv.second;
        return nullptr;
    }
    std::wstring text(const wchar_t *key, const std::wstring &def = L"") const {
        const Json *v = get(key);
        return v && v->type == String ? v->str : def;
    }
    double number(const wchar_t *key, double def = 0) const {
        const Json *v = get(key);
        return v && v->type == Number ? v->num : def;
    }
    bool flag(const wchar_t *key, bool def = false) const {
        const Json *v = get(key);
        return v && v->type == Bool ? v->b : def;
    }
    bool has(const wchar_t *key) const {
        const Json *v = get(key);
        return v && v->type != Null;
    }
};

class JsonParser {
public:
    explicit JsonParser(const std::string &s) : s_(s) {}

    /** Parses the whole input; false on any syntax error. */
    bool parse(Json &out) {
        skipBom();
        if (!value(out, 0)) return false;
        ws();
        return i_ == s_.size();
    }

private:
    const std::string &s_;
    size_t i_ = 0;

    void skipBom() {
        if (s_.size() >= 3 && (unsigned char)s_[0] == 0xEF && (unsigned char)s_[1] == 0xBB && (unsigned char)s_[2] == 0xBF)
            i_ = 3;
    }
    void ws() {
        while (i_ < s_.size() && (s_[i_] == ' ' || s_[i_] == '\t' || s_[i_] == '\n' || s_[i_] == '\r')) i_++;
    }
    bool lit(const char *w) {
        size_t n = strlen(w);
        if (s_.compare(i_, n, w) != 0) return false;
        i_ += n;
        return true;
    }
    bool value(Json &out, int depth) {
        if (depth > 64) return false;
        ws();
        if (i_ >= s_.size()) return false;
        char c = s_[i_];
        if (c == '{') return object(out, depth);
        if (c == '[') return array(out, depth);
        if (c == '"') {
            out.type = Json::String;
            return string(out.str);
        }
        if (c == 't' && lit("true")) {
            out.type = Json::Bool;
            out.b = true;
            return true;
        }
        if (c == 'f' && lit("false")) {
            out.type = Json::Bool;
            return true;
        }
        if (c == 'n' && lit("null")) {
            out.type = Json::Null;
            return true;
        }
        if (c == '-' || (c >= '0' && c <= '9')) {
            const char *start = s_.c_str() + i_;
            char *end = nullptr;
            out.num = strtod(start, &end);
            if (end == start) return false;
            i_ += end - start;
            out.type = Json::Number;
            return true;
        }
        return false;
    }
    bool object(Json &out, int depth) {
        out.type = Json::Object;
        i_++;
        ws();
        if (i_ < s_.size() && s_[i_] == '}') {
            i_++;
            return true;
        }
        for (;;) {
            ws();
            std::wstring key;
            if (i_ >= s_.size() || s_[i_] != '"' || !string(key)) return false;
            ws();
            if (i_ >= s_.size() || s_[i_++] != ':') return false;
            Json v;
            if (!value(v, depth + 1)) return false;
            out.obj.emplace_back(std::move(key), std::move(v));
            ws();
            if (i_ >= s_.size()) return false;
            if (s_[i_] == ',') {
                i_++;
                continue;
            }
            if (s_[i_] == '}') {
                i_++;
                return true;
            }
            return false;
        }
    }
    bool array(Json &out, int depth) {
        out.type = Json::Array;
        i_++;
        ws();
        if (i_ < s_.size() && s_[i_] == ']') {
            i_++;
            return true;
        }
        for (;;) {
            Json v;
            if (!value(v, depth + 1)) return false;
            out.arr.push_back(std::move(v));
            ws();
            if (i_ >= s_.size()) return false;
            if (s_[i_] == ',') {
                i_++;
                continue;
            }
            if (s_[i_] == ']') {
                i_++;
                return true;
            }
            return false;
        }
    }
    static int hex(char c) {
        if (c >= '0' && c <= '9') return c - '0';
        if (c >= 'a' && c <= 'f') return c - 'a' + 10;
        if (c >= 'A' && c <= 'F') return c - 'A' + 10;
        return -1;
    }
    bool hex4(unsigned &u) {
        if (i_ + 4 > s_.size()) return false;
        u = 0;
        for (int k = 0; k < 4; k++) {
            int h = hex(s_[i_ + k]);
            if (h < 0) return false;
            u = u * 16 + h;
        }
        i_ += 4;
        return true;
    }
    bool string(std::wstring &out) {
        i_++;  // opening quote
        std::string raw;  // UTF-8 bytes, converted once at the end
        while (i_ < s_.size()) {
            char c = s_[i_++];
            if (c == '"') {
                out = wide(raw);
                return true;
            }
            if (c != '\\') {
                raw += c;
                continue;
            }
            if (i_ >= s_.size()) return false;
            char e = s_[i_++];
            switch (e) {
            case '"': raw += '"'; break;
            case '\\': raw += '\\'; break;
            case '/': raw += '/'; break;
            case 'b': raw += '\b'; break;
            case 'f': raw += '\f'; break;
            case 'n': raw += '\n'; break;
            case 'r': raw += '\r'; break;
            case 't': raw += '\t'; break;
            case 'u': {
                unsigned u;
                if (!hex4(u)) return false;
                if (u >= 0xD800 && u <= 0xDBFF && i_ + 6 <= s_.size() && s_[i_] == '\\' && s_[i_ + 1] == 'u') {
                    size_t save = i_;
                    i_ += 2;
                    unsigned lo;
                    if (hex4(lo) && lo >= 0xDC00 && lo <= 0xDFFF) u = 0x10000 + ((u - 0xD800) << 10) + (lo - 0xDC00);
                    else i_ = save;
                }
                appendUtf8(raw, u);
                break;
            }
            default:
                return false;
            }
        }
        return false;
    }
    static void appendUtf8(std::string &s, unsigned u) {
        if (u < 0x80) s += (char)u;
        else if (u < 0x800) {
            s += (char)(0xC0 | (u >> 6));
            s += (char)(0x80 | (u & 0x3F));
        } else if (u < 0x10000) {
            s += (char)(0xE0 | (u >> 12));
            s += (char)(0x80 | ((u >> 6) & 0x3F));
            s += (char)(0x80 | (u & 0x3F));
        } else {
            s += (char)(0xF0 | (u >> 18));
            s += (char)(0x80 | ((u >> 12) & 0x3F));
            s += (char)(0x80 | ((u >> 6) & 0x3F));
            s += (char)(0x80 | (u & 0x3F));
        }
    }
};

inline bool parseJson(const std::string &s, Json &out) { return JsonParser(s).parse(out); }

/** A JSON string literal (with quotes) for a UTF-16 string. */
inline std::string jsonString(const std::wstring &w) {
    std::string s = utf8(w), out = "\"";
    for (unsigned char c : s) {
        switch (c) {
        case '"': out += "\\\""; break;
        case '\\': out += "\\\\"; break;
        case '\n': out += "\\n"; break;
        case '\r': out += "\\r"; break;
        case '\t': out += "\\t"; break;
        default:
            if (c < 0x20) {
                char buf[8];
                snprintf(buf, sizeof buf, "\\u%04x", c);
                out += buf;
            } else {
                out += (char)c;
            }
        }
    }
    return out + "\"";
}

}  // namespace app
