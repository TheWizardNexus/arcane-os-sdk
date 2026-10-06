#include <whisper.h>
#include <ggml-backend.h>

#include <atomic>
#include <condition_variable>
#include <cstdint>
#include <cstring>
#include <filesystem>
#include <fstream>
#include <iomanip>
#include <iostream>
#include <limits>
#include <locale>
#include <memory>
#include <mutex>
#include <sstream>
#include <stdexcept>
#include <string>
#include <thread>
#include <vector>

#ifdef _WIN32
#include <fcntl.h>
#include <io.h>
#endif

namespace {

struct Configuration {
    std::string model;
    std::string runtime;
    std::string backend = "gpu";
    int threads = 1;
};

struct Segment {
    int index;
    std::string text;
    double start;
    double end;
};

struct Request {
    std::string id;
    std::string audio_path;
    std::string language;
    bool translate = false;
    std::atomic<bool> cancelled{false};
    std::vector<Segment> segments;
    std::string text;
    std::string detected_language;
    std::string error;
    std::string error_code;
    double duration = 0;
};

struct Commands {
    std::mutex mutex;
    std::condition_variable changed;
    std::shared_ptr<Request> active;
    bool stopping = false;
};

struct NativeLog {
    std::mutex mutex;
    std::string pending;
    std::string backend;

    ~NativeLog() {
        whisper_log_set(nullptr, nullptr);
    }
};

std::mutex output_mutex;

std::string json_string(const std::string& value) {
    std::ostringstream output;
    output << '"';
    for (const unsigned char character : value) {
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
    output << '"';
    return output.str();
}

std::string decode_base64(const std::string& encoded) {
    const std::string alphabet = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";
    std::string decoded;
    uint32_t accumulator = 0;
    int remaining = 0;
    bool padding = false;
    for (const char character : encoded) {
        if (character == '=') {
            padding = true;
            continue;
        }
        const auto digit = alphabet.find(character);
        if (padding || digit == std::string::npos) {
            throw std::runtime_error("Unreadable base64 command field.");
        }
        accumulator = (accumulator << 6) | static_cast<uint32_t>(digit);
        remaining += 6;
        if (remaining >= 8) {
            remaining -= 8;
            decoded.push_back(static_cast<char>((accumulator >> remaining) & 0xff));
        }
    }
    return decoded;
}

void emit(const std::string& record) {
    const std::lock_guard<std::mutex> lock(output_mutex);
    std::cout << record << '\n' << std::flush;
}

void emit_error(const std::string& request_id, const std::string& message, const std::string& code = "") {
    emit("{\"type\":\"error\",\"requestId\":" + json_string(request_id)
        + ",\"message\":" + json_string(message)
        + (code.empty() ? "" : ",\"code\":" + json_string(code)) + "}");
}

std::string segment_json(const Segment& segment) {
    std::ostringstream output;
    output.imbue(std::locale::classic());
    output << std::setprecision(std::numeric_limits<double>::max_digits10)
           << "{\"index\":" << segment.index << ",\"text\":" << json_string(segment.text)
           << ",\"start\":" << segment.start << ",\"end\":" << segment.end << '}';
    return output.str();
}

Segment read_segment(whisper_state* state, int index) {
    return Segment{
        index,
        whisper_full_get_segment_text_from_state(state, index),
        whisper_full_get_segment_t0_from_state(state, index) * 0.01,
        whisper_full_get_segment_t1_from_state(state, index) * 0.01
    };
}

void on_segment(whisper_context*, whisper_state* state, int added, void* data) {
    Request& request = *static_cast<Request*>(data);
    const int total = whisper_full_n_segments_from_state(state);
    for (int index = total - added; index < total; ++index) {
        const Segment segment = read_segment(state, index);
        emit("{\"type\":\"segment\",\"requestId\":" + json_string(request.id)
            + ",\"index\":" + std::to_string(segment.index)
            + ",\"text\":" + json_string(segment.text)
            + ",\"start\":" + std::to_string(segment.start)
            + ",\"end\":" + std::to_string(segment.end) + "}");
    }
}

void on_progress(whisper_context*, whisper_state*, int progress, void* data) {
    const Request& request = *static_cast<Request*>(data);
    emit("{\"type\":\"progress\",\"requestId\":" + json_string(request.id)
        + ",\"progress\":" + std::to_string(progress) + "}");
}

bool should_abort(void* data) {
    return static_cast<Request*>(data)->cancelled.load();
}

bool before_encoder(whisper_context*, whisper_state*, void* data) {
    return !should_abort(data);
}

void native_log(ggml_log_level, const char* text, void* data) {
    NativeLog& log = *static_cast<NativeLog*>(data);
    const std::lock_guard<std::mutex> lock(log.mutex);
    std::cerr << text << std::flush;
    log.pending += text;
    std::string::size_type newline;
    while ((newline = log.pending.find('\n')) != std::string::npos) {
        const std::string line = log.pending.substr(0, newline);
        log.pending.erase(0, newline + 1);
        const std::string selected = "whisper_backend_init_gpu: using ";
        const std::string failed = "whisper_backend_init_gpu: failed to initialize ";
        if (line.compare(0, selected.size(), selected) == 0) {
            const auto end = line.rfind(" backend");
            if (end != std::string::npos) {
                log.backend = line.substr(selected.size(), end - selected.size());
            }
        } else if (line.compare(0, failed.size(), failed) == 0
                || line == "whisper_backend_init_gpu: no GPU found") {
            log.backend = "CPU";
        }
    }
}

std::vector<float> read_audio(Request& request) {
    std::ifstream input(std::filesystem::u8path(request.audio_path), std::ios::binary);
    if (!input) {
        throw std::runtime_error("Could not open the selected decoded audio: " + request.audio_path);
    }
    std::vector<float> audio;
    unsigned char sample[4];
    while (input.read(reinterpret_cast<char*>(sample), sizeof(sample))) {
        if (request.cancelled.load()) {
            return {};
        }
        // This is the decoder's f32le transport representation, not a content
        // policy or an audio normalization step.
        const uint32_t bits = static_cast<uint32_t>(sample[0])
            | (static_cast<uint32_t>(sample[1]) << 8)
            | (static_cast<uint32_t>(sample[2]) << 16)
            | (static_cast<uint32_t>(sample[3]) << 24);
        float value;
        std::memcpy(&value, &bits, sizeof(value));
        audio.push_back(value);
    }
    if (input.bad() || input.gcount() != 0) {
        throw std::runtime_error("The decoded audio ended inside an f32le sample or could not be read.");
    }
    return audio;
}

void transcribe(whisper_context* context, const Configuration& configuration, Request& request) {
    try {
        if (request.cancelled.load()) {
            return;
        }
        const std::vector<float> audio = read_audio(request);
        if (request.cancelled.load()) {
            return;
        }
        request.duration = static_cast<double>(audio.size()) / WHISPER_SAMPLE_RATE;
        if (audio.size() > static_cast<size_t>(std::numeric_limits<int>::max())) {
            throw std::runtime_error("The complete recording exceeds whisper_full's native signed-int sample argument; no audio was submitted or shortened.");
        }
        if (audio.empty()) {
            throw std::runtime_error("The decoder returned no audio samples.");
        }
        if (!request.language.empty() && request.language != "auto"
                && whisper_lang_id(request.language.c_str()) < 0) {
            throw std::runtime_error("Whisper does not recognize the requested language: " + request.language);
        }
        whisper_full_params parameters = whisper_full_default_params(WHISPER_SAMPLING_GREEDY);
        parameters.n_threads = configuration.threads;
        parameters.offset_ms = 0;
        parameters.duration_ms = 0;
        parameters.no_context = true;
        parameters.translate = request.translate;
        parameters.language = request.language.c_str();
        parameters.print_realtime = false;
        parameters.print_progress = false;
        parameters.print_timestamps = false;
        parameters.new_segment_callback = on_segment;
        parameters.new_segment_callback_user_data = &request;
        parameters.progress_callback = on_progress;
        parameters.progress_callback_user_data = &request;
        parameters.encoder_begin_callback = before_encoder;
        parameters.encoder_begin_callback_user_data = &request;
        parameters.abort_callback = should_abort;
        parameters.abort_callback_user_data = &request;
        const int result = whisper_full(context, parameters, audio.data(), static_cast<int>(audio.size()));
        if (request.cancelled.load()) {
            return;
        }
        if (result != 0) {
            request.error_code = "WHISPER_INFERENCE_FAILED";
            throw std::runtime_error("whisper_full returned " + std::to_string(result) + ".");
        }
        const char* language = whisper_lang_str(whisper_full_lang_id(context));
        request.detected_language = language == nullptr ? "" : language;
        const int total = whisper_full_n_segments(context);
        for (int index = 0; index < total; ++index) {
            Segment segment{
                index,
                whisper_full_get_segment_text(context, index),
                whisper_full_get_segment_t0(context, index) * 0.01,
                whisper_full_get_segment_t1(context, index) * 0.01
            };
            request.text += segment.text;
            request.segments.push_back(std::move(segment));
        }
    } catch (const std::exception& error) {
        request.error = error.what();
    }
}

void emit_result(const Request& request) {
    if (request.cancelled.load()) {
        emit("{\"type\":\"cancelled\",\"requestId\":" + json_string(request.id) + "}");
        return;
    }
    if (!request.error.empty()) {
        emit_error(request.id, request.error, request.error_code);
        return;
    }
    std::ostringstream output;
    output.imbue(std::locale::classic());
    output << std::setprecision(std::numeric_limits<double>::max_digits10)
           << "{\"type\":\"complete\",\"requestId\":" << json_string(request.id)
           << ",\"language\":" << json_string(request.detected_language)
           << ",\"duration\":" << request.duration
           << ",\"text\":" << json_string(request.text) << ",\"segments\":[";
    for (size_t index = 0; index < request.segments.size(); ++index) {
        if (index != 0) {
            output << ',';
        }
        output << segment_json(request.segments[index]);
    }
    output << "]}";
    emit(output.str());
}

std::vector<std::string> command_fields(const std::string& line) {
    std::vector<std::string> fields;
    size_t start = 0;
    while (true) {
        const size_t separator = line.find('\t', start);
        fields.push_back(line.substr(start, separator == std::string::npos ? separator : separator - start));
        if (separator == std::string::npos) {
            return fields;
        }
        start = separator + 1;
    }
}

void read_commands(Commands& commands) {
    std::string line;
    while (std::getline(std::cin, line)) {
        std::string request_id;
        try {
            const std::vector<std::string> fields = command_fields(line);
            if (fields.size() > 1) {
                request_id = fields[1];
            }
            std::unique_lock<std::mutex> lock(commands.mutex);
            if (fields[0] == "shutdown") {
                break;
            }
            if (fields[0] == "cancel" && fields.size() == 2) {
                if (commands.active && commands.active->id == request_id) {
                    commands.active->cancelled.store(true);
                }
            } else if (fields[0] == "transcribe" && fields.size() == 5) {
                if (commands.active) {
                    throw std::runtime_error("The retained model is already transcribing an active request.");
                }
                const auto request = std::make_shared<Request>();
                request->id = request_id;
                request->audio_path = decode_base64(fields[2]);
                request->language = decode_base64(fields[3]);
                if (fields[4] != "0" && fields[4] != "1") {
                    throw std::runtime_error("Unreadable translation command field.");
                }
                request->translate = fields[4] == "1";
                commands.active = request;
                emit("{\"type\":\"accepted\",\"requestId\":" + json_string(request_id) + "}");
                commands.changed.notify_one();
            } else {
                throw std::runtime_error("Unreadable Whisper command.");
            }
        } catch (const std::exception& error) {
            emit_error(request_id, error.what());
        }
    }
    const std::lock_guard<std::mutex> lock(commands.mutex);
    commands.stopping = true;
    if (commands.active) {
        commands.active->cancelled.store(true);
    }
    commands.changed.notify_one();
}

Configuration read_configuration(int argc, char** argv) {
    Configuration configuration;
    const unsigned int available = std::thread::hardware_concurrency();
    configuration.threads = available == 0 ? 1 : static_cast<int>(available);
    for (int index = 1; index < argc; index += 2) {
        if (index + 1 == argc) {
            throw std::runtime_error("A helper argument is missing its value.");
        }
        const std::string option = argv[index];
        const std::string value = argv[index + 1];
        if (option == "--model-base64") {
            configuration.model = decode_base64(value);
        } else if (option == "--runtime-base64") {
            configuration.runtime = decode_base64(value);
        } else if (option == "--backend") {
            configuration.backend = value;
        } else if (option == "--threads") {
            configuration.threads = std::stoi(value);
        } else {
            throw std::runtime_error("Unknown helper argument: " + option);
        }
    }
    if (configuration.model.empty() || configuration.runtime.empty()) {
        throw std::runtime_error("The selected model and runtime paths are required.");
    }
    if (configuration.backend != "gpu" && configuration.backend != "cpu") {
        throw std::runtime_error("The requested backend must be gpu or cpu.");
    }
    if (configuration.threads < 1) {
        throw std::runtime_error("Native inference requires a positive thread count.");
    }
    return configuration;
}

int serve(const Configuration& configuration) {
    NativeLog log;
    whisper_log_set(native_log, &log);
    emit("{\"type\":\"loading\",\"model\":" + json_string(configuration.model)
        + ",\"requestedBackend\":" + json_string(configuration.backend)
        + ",\"observedBackend\":null,\"backendEvidence\":null}");
    ggml_backend_load_all_from_path(configuration.runtime.c_str());
    whisper_context_params parameters = whisper_context_default_params();
    parameters.use_gpu = configuration.backend == "gpu";
    using Context = std::unique_ptr<whisper_context, decltype(&whisper_free)>;
    Context context(whisper_init_from_file_with_params(configuration.model.c_str(), parameters), whisper_free);
    if (!context) {
        throw std::runtime_error("Whisper could not load the selected model.");
    }
    {
        const std::lock_guard<std::mutex> lock(log.mutex);
        // The public C API exposes available devices, not a context backend
        // getter. This observation is explicitly attributed to completed native
        // initialization logs; it does not claim every operation uses a GPU.
        emit("{\"type\":\"ready\",\"model\":" + json_string(configuration.model)
            + ",\"requestedBackend\":" + json_string(configuration.backend)
            + ",\"observedBackend\":" + (log.backend.empty() ? "null" : json_string(log.backend))
            + ",\"backendEvidence\":" + (log.backend.empty() ? "null" : "\"runtime-log\"") + "}");
    }
    Commands commands;
    std::thread reader(read_commands, std::ref(commands));
    while (true) {
        std::shared_ptr<Request> request;
        {
            std::unique_lock<std::mutex> lock(commands.mutex);
            commands.changed.wait(lock, [&commands] { return commands.stopping || commands.active != nullptr; });
            request = commands.active;
            if (!request) {
                break;
            }
        }
        // The command reader stays responsive while this exact worker owns the
        // opaque context. Joining precedes every terminal event and model reuse.
        try {
            std::thread inference(transcribe, context.get(), std::cref(configuration), std::ref(*request));
            inference.join();
        } catch (const std::exception& error) {
            request->error = error.what();
        }
        {
            const std::lock_guard<std::mutex> lock(commands.mutex);
            emit_result(*request);
            commands.active.reset();
            if (commands.stopping) {
                break;
            }
        }
    }
    reader.join();
    context.reset();
    whisper_log_set(nullptr, nullptr);
    emit("{\"type\":\"stopped\"}");
    return 0;
}

} // namespace

int main(int argc, char** argv) {
#ifdef _WIN32
    _setmode(_fileno(stdin), _O_BINARY);
    _setmode(_fileno(stdout), _O_BINARY);
    _setmode(_fileno(stderr), _O_BINARY);
#endif
    try {
        return serve(read_configuration(argc, argv));
    } catch (const std::exception& error) {
        whisper_log_set(nullptr, nullptr);
        emit_error("", error.what());
        return 1;
    }
}
