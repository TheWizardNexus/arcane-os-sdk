#include <nemo_speech/tts.h>

#include <atomic>
#include <condition_variable>
#include <cstdint>
#include <exception>
#include <iostream>
#include <memory>
#include <mutex>
#include <sstream>
#include <stdexcept>
#include <string>
#include <thread>
#include <utility>
#include <vector>

#ifdef _WIN32
#include <fcntl.h>
#include <io.h>
#include <windows.h>
#endif

namespace {

using Synthesizer = std::unique_ptr<nemo_speech_tts_synthesizer, decltype(&nemo_speech_tts_destroy)>;

struct Utterance {
    uint64_t id;
    int32_t speaker;
    std::string language;
    std::string text;
    std::atomic<bool> cancelled{false};
};

std::mutex output_mutex;

// Lengths belong only to this binary transport. Every PCM and text frame is complete.
void emit(const char* kind, uint64_t id, const char* content, size_t length) {
    const std::lock_guard<std::mutex> lock(output_mutex);
    std::cout << kind << '\t' << id << '\t' << length << '\n';
    std::cout.write(content, static_cast<std::streamsize>(length));
    std::cout.flush();
    if (!std::cout) throw std::runtime_error("The Magpie output pipe closed.");
}

void emit(const char* kind, uint64_t id, const std::string& content = {}) {
    emit(kind, id, content.data(), content.size());
}

struct Output {
    Utterance& utterance;
    std::string error;
};

bool deliver_audio(const uint8_t* pcm, size_t length, void* context) {
    auto& output = *static_cast<Output*>(context);
    if (output.utterance.cancelled.load()) return false;
    try {
        emit("audio", output.utterance.id, reinterpret_cast<const char*>(pcm), length);
        return !output.utterance.cancelled.load();
    } catch (const std::exception& error) {
        output.error = error.what();
        return false;
    }
}

std::string read_text(size_t length) {
    std::string text(length, '\0');
    if (!std::cin.read(text.data(), static_cast<std::streamsize>(length))) {
        throw std::runtime_error("The Magpie input pipe ended during a text frame.");
    }
    return text;
}

int serve(const std::vector<std::string>& arguments) {
#ifdef _WIN32
    _setmode(_fileno(stdin), _O_BINARY);
    _setmode(_fileno(stdout), _O_BINARY);
#endif
    if (arguments.size() != 6) {
        throw std::runtime_error("Usage: arcane-magpie MAGPIE.gguf CODEC.gguf TOKENIZER_DIR SPEAKER cpu|cuda");
    }
    const std::string& backend = arguments[5];
    if (backend != "cpu" && backend != "cuda") {
        throw std::runtime_error("Select the prepared CPU or CUDA TTS backend explicitly.");
    }
    nemo_speech_tts_model_config models = {};
    models.size = sizeof(models);
    models.magpie_model = arguments[1].c_str();
    models.codec_model = arguments[2].c_str();
    models.tokenizer_model_dir = arguments[3].c_str();
    // Leave optional written-to-spoken normalization absent: the caller owns its text.
    auto runtime = nemo_speech_tts_runtime_config_default();
    runtime.speaker = std::stoi(arguments[4]);
    runtime.lt_backend = backend == "cuda" ? NEMO_SPEECH_TTS_BACKEND_CUDA : NEMO_SPEECH_TTS_BACKEND_CPU;
    runtime.sampling_backend = runtime.lt_backend;
    runtime.codec_cpu = backend == "cpu";
    nemo_speech_tts_synthesizer_config configuration = {};
    configuration.size = sizeof(configuration);
    configuration.model = &models;
    configuration.runtime = &runtime;
    nemo_speech_tts_synthesizer* raw = nullptr;
    if (nemo_speech_tts_create(&configuration, &raw) != NEMO_SPEECH_TTS_OK) {
        const char* error = nemo_speech_tts_last_error();
        throw std::runtime_error(error && *error ? error : "The native TTS model creation failed without an error message.");
    }
    const Synthesizer synthesizer(raw, nemo_speech_tts_destroy);
    emit("ready", 0, std::to_string(nemo_speech_tts_sample_rate(synthesizer.get())));

    std::mutex work_mutex;
    std::condition_variable work_ready;
    std::shared_ptr<Utterance> pending;
    std::shared_ptr<Utterance> active;
    bool closing = false;
    std::exception_ptr worker_error;

    // Only this worker calls the synthesizer. The reader can flag the exact
    // active utterance while inference or PCM backpressure occupies that worker.
    std::thread worker([&]() {
        try {
            for (;;) {
                std::shared_ptr<Utterance> utterance;
                {
                    std::unique_lock<std::mutex> lock(work_mutex);
                    work_ready.wait(lock, [&]() { return closing || pending != nullptr; });
                    if (!pending) return;
                    utterance = std::move(pending);
                    active = utterance;
                }
                auto options = nemo_speech_tts_synthesis_options_default();
                const std::string request_id = std::to_string(utterance->id);
                options.request_id = request_id.c_str();
                options.language_code = utterance->language.c_str();
                options.speaker = utterance->speaker;
                Output output{*utterance, {}};
                nemo_speech_tts_status status = NEMO_SPEECH_TTS_ERROR_CANCELLED;
                if (!utterance->cancelled.load()) {
                    emit("started", utterance->id);
                    status = nemo_speech_tts_synthesize_text(
                        synthesizer.get(), &options, utterance->text.c_str(), deliver_audio, &output, nullptr
                    );
                }
                // Read the thread-local native error before any other native call.
                std::string native_error;
                if (status != NEMO_SPEECH_TTS_OK && status != NEMO_SPEECH_TTS_ERROR_CANCELLED) {
                    const char* message = nemo_speech_tts_last_error();
                    native_error = message && *message ? message
                        : "The native TTS call failed with status " + std::to_string(status) + ".";
                }
                {
                    const std::lock_guard<std::mutex> lock(work_mutex);
                    active.reset();
                }
                if (!output.error.empty()) emit("error", utterance->id, output.error);
                else if (!native_error.empty()) emit("error", utterance->id, native_error);
                else if (utterance->cancelled.load() || status == NEMO_SPEECH_TTS_ERROR_CANCELLED) {
                    emit("cancelled", utterance->id);
                } else emit("done", utterance->id);
            }
        } catch (...) {
            const auto failure = std::current_exception();
            {
                const std::lock_guard<std::mutex> lock(work_mutex);
                worker_error = failure;
                closing = true;
            }
            // A failed worker must wake the process owner, which closes input
            // and joins this process instead of leaving an unanswered request.
            try {
                try { std::rethrow_exception(failure); }
                catch (const std::exception& error) { emit("fatal", 0, error.what()); }
                catch (...) { emit("fatal", 0, "The native synthesis worker raised an unknown exception."); }
            } catch (...) {
                // A closed output pipe cannot carry another diagnostic.
            }
        }
    });

    std::exception_ptr reader_error;
    try {
        std::string line;
        while (std::getline(std::cin, line)) {
            std::istringstream command(line);
            std::string operation;
            uint64_t id = 0;
            if (!(command >> operation >> id)) throw std::runtime_error("Unreadable Magpie command.");
            if (operation == "synthesize") {
                int32_t speaker = 0;
                size_t language_length = 0;
                size_t text_length = 0;
                if (!(command >> speaker >> language_length >> text_length)) {
                    throw std::runtime_error("Unreadable Magpie synthesis framing.");
                }
                auto utterance = std::make_shared<Utterance>();
                utterance->id = id;
                utterance->speaker = speaker;
                utterance->language = read_text(language_length);
                utterance->text = read_text(text_length);
                if (utterance->language.find('\0') != std::string::npos || utterance->text.find('\0') != std::string::npos) {
                    emit("error", id, "The public TTS text interface cannot consume embedded NUL characters.");
                    continue;
                }
                {
                    const std::lock_guard<std::mutex> lock(work_mutex);
                    if (worker_error) std::rethrow_exception(worker_error);
                    if (closing || pending || active) {
                        emit("error", id, "The native synthesizer already owns an utterance.");
                        continue;
                    }
                    pending = utterance;
                }
                work_ready.notify_one();
            } else if (operation == "stop") {
                const std::lock_guard<std::mutex> lock(work_mutex);
                if (pending && pending->id == id) pending->cancelled.store(true);
                if (active && active->id == id) active->cancelled.store(true);
            } else if (operation == "close") {
                break;
            } else {
                emit("error", id, "Unknown Magpie command.");
            }
        }
    } catch (...) {
        reader_error = std::current_exception();
    }
    {
        const std::lock_guard<std::mutex> lock(work_mutex);
        closing = true;
        if (pending) pending->cancelled.store(true);
        if (active) active->cancelled.store(true);
    }
    work_ready.notify_one();
    worker.join();
    if (reader_error) std::rethrow_exception(reader_error);
    if (worker_error) std::rethrow_exception(worker_error);
    return 0;
}

int run(const std::vector<std::string>& arguments) {
    try {
        return serve(arguments);
    } catch (const std::exception& error) {
        std::cerr << error.what() << '\n';
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
            std::cerr << "Windows could not encode the selected TTS argument as UTF-8.\n";
            return 1;
        }
        std::string value(length, '\0');
        WideCharToMultiByte(CP_UTF8, 0, argv[index], -1, value.data(), length, nullptr, nullptr);
        value.pop_back();
        arguments.push_back(std::move(value));
    }
    return run(arguments);
}
#else
int main(int argc, char** argv) {
    return run(std::vector<std::string>(argv, argv + argc));
}
#endif
