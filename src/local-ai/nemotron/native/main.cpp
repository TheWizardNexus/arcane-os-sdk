#include <nemo_speech/asr.h>

#include <cstdint>
#include <cstring>
#include <iomanip>
#include <iostream>
#include <limits>
#include <locale>
#include <memory>
#include <sstream>
#include <stdexcept>
#include <string>
#include <vector>

#ifdef _WIN32
#include <fcntl.h>
#include <io.h>
#include <windows.h>
#endif

namespace {

using Recognizer = std::unique_ptr<nemo_speech_asr_recognizer, decltype(&nemo_speech_asr_destroy)>;
using Stream = std::unique_ptr<nemo_speech_asr_stream, decltype(&nemo_speech_asr_stream_close)>;
using Result = std::unique_ptr<nemo_speech_asr_result, decltype(&nemo_speech_asr_result_destroy)>;

void check(nemo_speech_asr_status status) {
    if (status != NEMO_SPEECH_ASR_OK) {
        const char* message = nemo_speech_asr_last_error();
        throw std::runtime_error(message ? message : "The native ASR operation failed.");
    }
}

std::string json_string(const char* value) {
    std::ostringstream output;
    output << '"';
    if (value) {
        for (const unsigned char character : std::string(value)) {
            switch (character) {
                case '"': output << "\\\""; break;
                case '\\': output << "\\\\"; break;
                case '\n': output << "\\n"; break;
                case '\r': output << "\\r"; break;
                case '\t': output << "\\t"; break;
                default:
                    if (character < 0x20) {
                        output << "\\u" << std::hex << std::setw(4) << std::setfill('0')
                               << static_cast<unsigned int>(character) << std::dec;
                    } else {
                        output << character;
                    }
            }
        }
    }
    output << '"';
    return output.str();
}

void emit_error(uint64_t request, const std::string& message) {
    std::cout << "{\"request\":" << request << ",\"error\":" << json_string(message.c_str())
              << "}\n" << std::flush;
}

void emit_ack(uint64_t request) {
    std::cout << "{\"request\":" << request << ",\"ok\":true}\n" << std::flush;
}

void emit_running(uint64_t request) {
    std::cout << "{\"request\":" << request << ",\"running\":true}\n" << std::flush;
}

std::string read_text(size_t count) {
    std::string text(count, '\0');
    if (count && !std::cin.read(text.data(), count)) {
        throw std::runtime_error("Nemotron input ended during a language field.");
    }
    return text;
}

std::vector<float> read_audio(size_t samples) {
    std::vector<float> audio(samples);
    std::vector<unsigned char> encoded(samples * sizeof(float));
    if (!encoded.empty() && !std::cin.read(reinterpret_cast<char*>(encoded.data()), encoded.size())) {
        throw std::runtime_error("Nemotron input ended during a float32 audio frame.");
    }
    for (size_t index = 0; index < samples; ++index) {
        const auto* value = encoded.data() + index * sizeof(float);
        const uint32_t bits = static_cast<uint32_t>(value[0])
            | (static_cast<uint32_t>(value[1]) << 8)
            | (static_cast<uint32_t>(value[2]) << 16)
            | (static_cast<uint32_t>(value[3]) << 24);
        std::memcpy(&audio[index], &bits, sizeof(float));
    }
    return audio;
}

void emit_result(uint64_t request, uint64_t sequence, const nemo_speech_asr_result* result) {
    std::ostringstream output;
    output.imbue(std::locale::classic());
    output << std::setprecision(std::numeric_limits<float>::max_digits10);
    output << "{\"request\":" << request << ",\"update\":{\"sequence\":" << sequence
           << ",\"final\":" << (nemo_speech_asr_result_is_final(result) ? "true" : "false")
           << ",\"audioProcessedSeconds\":" << nemo_speech_asr_result_audio_processed(result)
           << ",\"channelTag\":" << nemo_speech_asr_result_channel_tag(result)
           << ",\"alternatives\":[";
    const size_t alternatives = nemo_speech_asr_result_alternative_count(result);
    for (size_t alternative = 0; alternative < alternatives; ++alternative) {
        if (alternative) output << ',';
        output << "{\"text\":" << json_string(nemo_speech_asr_result_transcript(result, alternative))
               << ",\"confidence\":" << nemo_speech_asr_result_confidence(result, alternative)
               << ",\"words\":[";
        const size_t words = nemo_speech_asr_result_word_count(result, alternative);
        for (size_t index = 0; index < words; ++index) {
            if (index) output << ',';
            output << "{\"word\":" << json_string(nemo_speech_asr_result_word_text(result, alternative, index))
                   << ",\"startTimeMs\":" << nemo_speech_asr_result_word_start_time(result, alternative, index)
                   << ",\"endTimeMs\":" << nemo_speech_asr_result_word_end_time(result, alternative, index)
                   << ",\"confidence\":" << nemo_speech_asr_result_word_confidence(result, alternative, index)
                   << ",\"speaker\":" << nemo_speech_asr_result_word_speaker_tag(result, alternative, index) << '}';
        }
        output << "],\"languageCodes\":[";
        const size_t languages = nemo_speech_asr_result_language_count(result, alternative);
        for (size_t index = 0; index < languages; ++index) {
            if (index) output << ',';
            output << json_string(nemo_speech_asr_result_language_code(result, alternative, index));
        }
        output << "]}";
    }
    output << "]}}\n";
    // A complete result is emitted before asking for the next one. An error
    // later in the drain cannot erase earlier native results.
    std::cout << output.str() << std::flush;
}

void drain(uint64_t request, nemo_speech_asr_stream* stream, uint64_t& sequence) {
    while (true) {
        nemo_speech_asr_result* raw = nullptr;
        const auto status = nemo_speech_asr_stream_next(stream, &raw);
        const Result result(raw, nemo_speech_asr_result_destroy);
        check(status);
        if (!result) return;
        emit_result(request, ++sequence, result.get());
    }
}

int serve(const std::string& model_path, const std::string& diarization_path, int gpu) {
#ifdef _WIN32
    _setmode(_fileno(stdin), _O_BINARY);
    _setmode(_fileno(stdout), _O_BINARY);
#endif
    nemo_speech_asr_backend_config backend{};
    backend.size = sizeof(backend);
    backend.gpu = gpu;
    nemo_speech_asr_model_config model{};
    model.size = sizeof(model);
    model.path = model_path.c_str();
    nemo_speech_asr_diar_config diarization{};
    diarization.size = sizeof(diarization);
    diarization.model_path = diarization_path.empty() ? nullptr : diarization_path.c_str();
    diarization.left_context_frames = -1;
    nemo_speech_asr_endpointing_config endpointing{};
    endpointing.size = sizeof(endpointing);
    endpointing.enable = false;
    nemo_speech_asr_recognizer_config configuration{};
    configuration.size = sizeof(configuration);
    configuration.backend = &backend;
    configuration.model = &model;
    configuration.diar = &diarization;
    configuration.endpointing = &endpointing;
    nemo_speech_asr_recognizer* raw_recognizer = nullptr;
    const auto status = nemo_speech_asr_create(&configuration, &raw_recognizer);
    const Recognizer recognizer(raw_recognizer, nemo_speech_asr_destroy);
    check(status);
    // The stream is destroyed before its recognizer. All stream calls stay on
    // this thread; the host owns capture, timing and conversational decisions.
    Stream stream(nullptr, nemo_speech_asr_stream_close);
    int sample_rate = 16000;
    uint64_t sequence = 0;
    std::string language;
    std::cout << "{\"ready\":true,\"version\":" << json_string(nemo_speech_asr_version())
              << ",\"requestedGpu\":" << gpu << "}\n" << std::flush;
    std::string line;
    while (std::getline(std::cin, line)) {
        uint64_t request = 0;
        std::string operation;
        std::istringstream command(line);
        if (!(command >> operation >> request)) {
            emit_error(0, "Unreadable Nemotron command.");
            return 1;
        }
        try {
            if (operation == "open") {
                size_t language_length = 0;
                int requested_rate = 0;
                if (!(command >> requested_rate >> language_length)) {
                    throw std::runtime_error("Unreadable Nemotron stream configuration.");
                }
                const std::string requested_language = read_text(language_length);
                if (stream) throw std::runtime_error("A Nemotron stream is already open.");
                language = requested_language;
                sample_rate = requested_rate;
                auto options = nemo_speech_asr_recognition_options_default();
                options.language_code = language.empty() ? nullptr : language.c_str();
                options.interim_results = true;
                options.enable_word_time_offsets = true;
                options.enable_speaker_diarization = !diarization_path.empty();
                options.enable_automatic_punctuation = false;
                options.profanity_filter = false;
                options.verbatim_transcripts = true;
                nemo_speech_asr_stream* raw_stream = nullptr;
                emit_running(request);
                const auto opened = nemo_speech_asr_streaming_recognize(recognizer.get(), &options, &raw_stream);
                stream.reset(raw_stream);
                check(opened);
                sequence = 0;
            } else if (operation == "close") {
                stream.reset();
            } else {
                std::vector<float> audio;
                if (operation == "push") {
                    size_t samples = 0;
                    if (!(command >> samples)) throw std::runtime_error("Unreadable Nemotron audio frame.");
                    audio = read_audio(samples);
                }
                if (!stream) throw std::runtime_error("No Nemotron stream is open.");
                emit_running(request);
                if (operation == "push") {
                    check(nemo_speech_asr_stream_push_f32(stream.get(), audio.data(), audio.size(), sample_rate));
                } else if (operation == "endpoint") {
                    check(nemo_speech_asr_stream_force_endpoint(stream.get()));
                } else if (operation == "finish") {
                    check(nemo_speech_asr_stream_finish(stream.get()));
                } else {
                    throw std::runtime_error("Unknown Nemotron operation.");
                }
                drain(request, stream.get(), sequence);
                if (operation == "finish") stream.reset();
            }
            emit_ack(request);
        } catch (const std::exception& error) {
            emit_error(request, error.what());
            if (!std::cin) return 1;
        }
    }
    return 0;
}

int run(const std::vector<std::string>& arguments) {
    try {
        if (arguments.size() != 4) {
            throw std::runtime_error("Usage: arcane-nemotron ASR.gguf DIARIZATION.gguf GPU_ORDINAL (-1 selects CPU).");
        }
        return serve(arguments[1], arguments[2], std::stoi(arguments[3]));
    } catch (const std::exception& error) {
        emit_error(0, error.what());
        return 1;
    }
}

} // namespace

#ifdef _WIN32
int wmain(int argc, wchar_t** argv) {
    std::vector<std::string> arguments;
    for (int index = 0; index < argc; ++index) {
        const int length = WideCharToMultiByte(CP_UTF8, 0, argv[index], -1, nullptr, 0, nullptr, nullptr);
        if (length == 0) {
            emit_error(0, "Windows could not encode a Nemotron argument as UTF-8.");
            return 1;
        }
        std::string argument(length, '\0');
        WideCharToMultiByte(CP_UTF8, 0, argv[index], -1, argument.data(), length, nullptr, nullptr);
        argument.pop_back();
        arguments.push_back(argument);
    }
    return run(arguments);
}
#else
int main(int argc, char** argv) {
    return run(std::vector<std::string>(argv, argv + argc));
}
#endif
