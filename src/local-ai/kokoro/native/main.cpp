#include <espeak-ng/speak_lib.h>
#include <opusenc.h>

#include <array>
#include <cstdint>
#include <cstring>
#include <filesystem>
#include <iostream>
#include <limits>
#include <sstream>
#include <stdexcept>
#include <string>
#include <vector>

#ifdef _WIN32
#include <fcntl.h>
#include <io.h>
#include <windows.h>
#endif

// This private pipe uses length framing solely to transport complete text and float PCM.
// No inference runtime is linked into this helper.
static void send(const std::string &kind, const std::string &id, const char *data, std::size_t length) {
    std::cout << kind << '\t' << id << '\t' << length << '\n';
    std::size_t offset = 0;
    while (offset < length) {
        const auto remaining = length - offset;
        const auto portion = remaining > static_cast<std::size_t>(std::numeric_limits<std::streamsize>::max())
            ? std::numeric_limits<std::streamsize>::max() : static_cast<std::streamsize>(remaining);
        std::cout.write(data + offset, portion);
        offset += static_cast<std::size_t>(portion);
    }
    std::cout.flush();
    if (!std::cout) throw std::runtime_error("Writing the complete Kokoro helper response failed.");
}

static void send(const std::string &kind, const std::string &id, const std::string &data = {}) {
    send(kind, id, data.data(), data.length());
}

static void receive(char *data, std::size_t length) {
    std::size_t offset = 0;
    while (offset < length) {
        const auto remaining = length - offset;
        const auto portion = remaining > static_cast<std::size_t>(std::numeric_limits<std::streamsize>::max())
            ? std::numeric_limits<std::streamsize>::max() : static_cast<std::streamsize>(remaining);
        std::cin.read(data + offset, portion);
        if (std::cin.gcount() != portion) throw std::runtime_error("The Kokoro command ended before its complete payload arrived.");
        offset += static_cast<std::size_t>(portion);
    }
}

static std::string jsonString(const std::string &text) {
    const char *hex = "0123456789abcdef";
    std::string result = "\"";
    for (const unsigned char character : text) {
        if (character == '\"' || character == '\\') {
            result += '\\';
            result += static_cast<char>(character);
        } else if (character < 0x20) {
            result += "\\u00";
            result += hex[character >> 4];
            result += hex[character & 15];
        } else result += static_cast<char>(character);
    }
    result += '\"';
    return result;
}

static void selectLanguage(const std::string &language) {
    espeak_VOICE properties{};
    properties.languages = language.c_str();
    if (espeak_SetVoiceByProperties(&properties) != EE_OK) throw std::runtime_error("eSpeak could not select " + language + ".");
    const espeak_VOICE *voice = espeak_GetCurrentVoice();
    // Public languages records consist of priority, language, NUL, repeated, then NUL.
    const char *languages = voice ? voice->languages : nullptr;
    while (languages && *languages) {
        ++languages;
        if (language == languages) return;
        languages += std::strlen(languages) + 1;
    }
    throw std::runtime_error("The matching eSpeak language data for " + language + " is unavailable.");
}

static void phonemize(const std::string &id, std::size_t length, const std::string &language) {
    std::string text(length, '\0');
    receive(text.data(), text.length());
    if (text.find('\0') != std::string::npos) throw std::runtime_error("The public eSpeak text interface cannot consume embedded NUL characters.");
    selectLanguage(language);
    const void *cursor = text.c_str();
    const char *end = text.c_str() + text.length();
    while (cursor) {
        const char *begin = static_cast<const char *>(cursor);
        const char *phonemes = espeak_TextToPhonemes(&cursor, espeakCHARS_UTF8,
            espeakPHONEMES_IPA | espeakPHONEMES_TIE | ('^' << 8));
        if (!phonemes) throw std::runtime_error("eSpeak did not return phonemes for the current clause.");
        // Copy the library-owned result before calling eSpeak again.
        const std::string translated(phonemes);
        const char *next = cursor ? static_cast<const char *>(cursor) : end;
        if (next < begin || next > end || (cursor && next == begin)) {
            throw std::runtime_error("eSpeak did not advance through the supplied text.");
        }
        const std::string consumed(begin, next);
        send("clause", id, "{\"source\":" + jsonString(consumed) + ",\"phonemes\":" + jsonString(translated) + "}");
    }
    send("done", id);
}

struct EncoderOutput {
    std::string id;
    std::string error;
};

static int writePage(void *context, const unsigned char *data, opus_int32 length) {
    auto &output = *static_cast<EncoderOutput *>(context);
    try {
        send("page", output.id, reinterpret_cast<const char *>(data), static_cast<std::size_t>(length));
        return 0;
    } catch (const std::exception &error) {
        output.error = error.what();
        return 1;
    }
}

static int closeEncoder(void *) { return 0; }

static void encodeOpus(const std::string &id, std::size_t length) {
    if (length % sizeof(float) != 0) throw std::runtime_error("The Opus input is not complete float32 PCM framing.");
    EncoderOutput output{id, {}};
    const OpusEncCallbacks callbacks{writePage, closeEncoder};
    OggOpusComments *comments = ope_comments_create();
    if (!comments) throw std::runtime_error("Creating Opus comments failed.");
    int error = OPE_OK;
    OggOpusEnc *encoder = ope_encoder_create_callbacks(&callbacks, &output, comments, 24000, 1, 0, &error);
    ope_comments_destroy(comments);
    if (!encoder) throw std::runtime_error(ope_strerror(error));
    try {
        std::array<unsigned char, 4096 * 4> encoded{};
        std::array<float, 4096> samples{};
        std::size_t remaining = length / 4;
        while (remaining) {
            const auto count = remaining < samples.size() ? remaining : samples.size();
            receive(reinterpret_cast<char *>(encoded.data()), count * 4);
            for (std::size_t index = 0; index < count; ++index) {
                const auto offset = index * 4;
                const std::uint32_t bits = static_cast<std::uint32_t>(encoded[offset])
                    | (static_cast<std::uint32_t>(encoded[offset + 1]) << 8)
                    | (static_cast<std::uint32_t>(encoded[offset + 2]) << 16)
                    | (static_cast<std::uint32_t>(encoded[offset + 3]) << 24);
                std::memcpy(&samples[index], &bits, sizeof(float));
            }
            error = ope_encoder_write_float(encoder, samples.data(), static_cast<int>(count));
            if (error != OPE_OK) throw std::runtime_error(ope_strerror(error));
            remaining -= count;
        }
        error = ope_encoder_drain(encoder);
        if (error != OPE_OK) throw std::runtime_error(ope_strerror(error));
        if (!output.error.empty()) throw std::runtime_error(output.error);
        ope_encoder_destroy(encoder);
        encoder = nullptr;
        send("done", id);
    } catch (...) {
        if (encoder) ope_encoder_destroy(encoder);
        throw;
    }
}

static int run(const std::vector<std::string> &arguments) {
    std::string data;
    if (arguments.size() == 3 && arguments[1] == "--data") data = arguments[2];
    else throw std::runtime_error("Kokoro requires --data with the parent of the matching espeak-ng-data directory.");
    if (espeak_Initialize(AUDIO_OUTPUT_SYNCHRONOUS, 0, data.c_str(), espeakINITIALIZE_DONT_EXIT) < 0) {
        throw std::runtime_error("Initializing the matching eSpeak language data failed.");
    }
    try {
        // eSpeak may choose an environment/installed data directory when the supplied path is absent.
        // Read its public selection so helper readiness describes the configured resources.
        const char *selectedData = nullptr;
        espeak_Info(&selectedData);
        const auto expectedData = (std::filesystem::u8path(data) / "espeak-ng-data").lexically_normal();
        if (!selectedData || std::filesystem::u8path(selectedData).lexically_normal() != expectedData) {
            throw std::runtime_error("eSpeak selected a different data directory: " + std::string(selectedData ? selectedData : "<none>")
                + "; requested " + expectedData.u8string());
        }
        // Resolve both supported dialects before reporting helper readiness.
        selectLanguage("en-us");
        selectLanguage("en-gb");
        send("ready", "0");
        std::string header;
        while (std::getline(std::cin, header)) {
            std::istringstream fields(header);
            std::string kind, id, lengthText, language;
            std::getline(fields, kind, '\t');
            std::getline(fields, id, '\t');
            std::getline(fields, lengthText, '\t');
            std::getline(fields, language);
            try {
                const auto length = std::stoull(lengthText);
                if (length > std::numeric_limits<std::size_t>::max()) throw std::runtime_error("The helper platform cannot represent this transport frame.");
                if (kind == "phonemize") phonemize(id, static_cast<std::size_t>(length), language);
                else if (kind == "opus") encodeOpus(id, static_cast<std::size_t>(length));
                else throw std::runtime_error("Unknown Kokoro helper command: " + kind);
            } catch (const std::exception &error) {
                send("error", id, error.what());
                throw;
            }
        }
        if (!std::cin.eof()) throw std::runtime_error("Reading the Kokoro command stream failed.");
        espeak_Terminate();
        return 0;
    } catch (...) {
        espeak_Terminate();
        throw;
    }
}

#ifdef _WIN32
static std::string utf8(const wchar_t *text) {
    const int length = WideCharToMultiByte(CP_UTF8, 0, text, -1, nullptr, 0, nullptr, nullptr);
    if (!length) throw std::runtime_error("Reading the Unicode Kokoro helper argument failed.");
    std::string result(static_cast<std::size_t>(length), '\0');
    if (!WideCharToMultiByte(CP_UTF8, 0, text, -1, result.data(), length, nullptr, nullptr)) {
        throw std::runtime_error("Converting the Unicode Kokoro helper argument failed.");
    }
    result.pop_back();
    return result;
}

int wmain(int argc, wchar_t **argv) {
    _setmode(_fileno(stdin), _O_BINARY);
    _setmode(_fileno(stdout), _O_BINARY);
#else
int main(int argc, char **argv) {
#endif
    try {
        std::vector<std::string> arguments;
        for (int index = 0; index < argc; ++index) {
#ifdef _WIN32
            arguments.push_back(utf8(argv[index]));
#else
            arguments.emplace_back(argv[index]);
#endif
        }
        return run(arguments);
    } catch (const std::exception &error) {
        std::cerr << error.what() << '\n';
        return 1;
    }
}
