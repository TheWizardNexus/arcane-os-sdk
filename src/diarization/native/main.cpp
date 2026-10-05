#include <nemo_speech/diar.h>

#include <cstdint>
#include <cstring>
#include <iomanip>
#include <iostream>
#include <limits>
#include <map>
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

using StreamHandle = std::unique_ptr<nemo_speech_diar_stream, decltype(&nemo_speech_diar_stream_close)>;
using ModelHandle = std::unique_ptr<nemo_speech_diar_model, decltype(&nemo_speech_diar_destroy)>;

struct Stream {
    StreamHandle handle;
    int sample_rate;
    bool probabilities;
    bool finished = false;
    int64_t delivered_frames = 0;
};

void check(nemo_speech_asr_status status) {
    if (status != NEMO_SPEECH_ASR_OK) {
        throw std::runtime_error(nemo_speech_asr_last_error());
    }
}

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

void emit_error(uint64_t request, const std::string& message) {
    std::cout << "{\"request\":" << request << ",\"error\":" << json_string(message)
              << "}\n" << std::flush;
}

void emit_ack(uint64_t request) {
    std::cout << "{\"request\":" << request << ",\"ok\":true}\n" << std::flush;
}

// Only transport framing uses sample count * sizeof(float). Samples are decoded
// losslessly from little-endian float32; the caller's audio is never normalized.
std::vector<float> read_audio(size_t samples) {
    std::vector<float> audio(samples);
    std::vector<unsigned char> encoded(samples * sizeof(float));
    if (!std::cin.read(reinterpret_cast<char*>(encoded.data()), encoded.size())) {
        throw std::runtime_error("Diarization input ended during an audio frame.");
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

void emit_result(uint64_t request, Stream& stream, int speakers, double seconds_per_frame) {
    const int64_t frame_count = nemo_speech_diar_frame_count(stream.handle.get());
    if (!stream.finished && frame_count == stream.delivered_frames) {
        // Many small caller pushes only fill the native right-context buffer.
        // Do not re-scan and serialize unchanged history for those pushes.
        emit_ack(request);
        return;
    }
    size_t count = 0;
    check(nemo_speech_diar_segments(stream.handle.get(), nullptr, nullptr, 0, &count));
    std::vector<nemo_speech_diar_segment> segments(count);
    if (count != 0) {
        check(nemo_speech_diar_segments(stream.handle.get(), nullptr, segments.data(), count, &count));
    }

    const int64_t retained_start = nemo_speech_diar_frame_probs_start(stream.handle.get());
    std::vector<float> probabilities;
    if (stream.probabilities) {
        if (retained_start > stream.delivered_frames) {
            throw std::runtime_error("Upstream compacted probability frames before they could be delivered.");
        }
        probabilities.resize(static_cast<size_t>(frame_count - retained_start) * speakers);
        if (!probabilities.empty()) {
            check(nemo_speech_diar_frame_probs(stream.handle.get(), probabilities.data(), probabilities.size()));
        }
    }

    // Build one complete protocol record before writing it. A C-ABI failure
    // therefore cannot leave a partially emitted result on stdout.
    std::ostringstream output;
    output << std::setprecision(std::numeric_limits<double>::max_digits10);
    output << "{\"request\":" << request << ",\"result\":{\"final\":"
           << (stream.finished ? "true" : "false")
           << ",\"speakers\":" << speakers
           << ",\"secondsPerFrame\":" << seconds_per_frame
           << ",\"frameCount\":" << frame_count << ",\"segments\":[";
    for (size_t index = 0; index < count; ++index) {
        const auto& segment = segments[index];
        if (index != 0) output << ',';
        output << "{\"speaker\":" << segment.speaker << ",\"startTime\":" << segment.start_time
               << ",\"endTime\":" << segment.end_time << '}';
    }
    output << ']';
    if (stream.probabilities) {
        output << ",\"probabilities\":{\"startFrame\":" << stream.delivered_frames
               << ",\"values\":[";
        const size_t first = static_cast<size_t>(stream.delivered_frames - retained_start) * speakers;
        for (size_t index = first; index < probabilities.size(); ++index) {
            if (index != first) output << ',';
            output << probabilities[index];
        }
        output << "]}";
    }
    output << "}}\n";
    std::cout << output.str() << std::flush;
    stream.delivered_frames = frame_count;
}

int serve(const std::string& model_path) {
#ifdef _WIN32
    _setmode(_fileno(stdin), _O_BINARY);
    _setmode(_fileno(stdout), _O_BINARY);
#endif
    nemo_speech_diar_model_config configuration = {};
    configuration.size = sizeof(configuration);
    configuration.model_path = model_path.c_str();
    configuration.gpu = -1;
    configuration.preset = "v3-streaming";
    configuration.left_context_frames = -1;
    nemo_speech_diar_model* raw_model = nullptr;
    check(nemo_speech_diar_create(&configuration, &raw_model));
    const ModelHandle model(raw_model, nemo_speech_diar_destroy);
    const int speakers = nemo_speech_diar_num_speakers(model.get());
    const double seconds_per_frame = nemo_speech_diar_seconds_per_frame(model.get());

    // Streams are destroyed before their retained model. The C ABI serializes
    // model compute internally; one command loop also preserves each stream's
    // required single-threaded access without duplicating the native scheduler.
    std::map<uint64_t, Stream> streams;
    std::cout << "{\"ready\":true,\"speakers\":" << speakers
              << ",\"secondsPerFrame\":" << std::setprecision(17) << seconds_per_frame
              << "}\n" << std::flush;

    std::string line;
    while (std::getline(std::cin, line)) {
        uint64_t request = 0;
        uint64_t id = 0;
        std::string operation;
        std::istringstream command(line);
        if (!(command >> operation >> request >> id)) {
            emit_error(request, "Unreadable diarization command.");
            return 1;
        }
        try {
            if (operation == "open") {
                int sample_rate = 0;
                int probabilities = 0;
                if (!(command >> sample_rate >> probabilities)) {
                    throw std::runtime_error("Unreadable stream configuration.");
                }
                if (streams.count(id)) throw std::runtime_error("The stream is already open.");
                nemo_speech_diar_stream* raw_stream = nullptr;
                check(nemo_speech_diar_stream_open(model.get(), &raw_stream));
                streams.emplace(id, Stream{
                    StreamHandle(raw_stream, nemo_speech_diar_stream_close), sample_rate, probabilities != 0
                });
                emit_ack(request);
            } else if (operation == "close") {
                streams.erase(id);
                emit_ack(request);
            } else {
                // Consume the complete framed audio before looking up its owner,
                // so an operation error cannot desynchronize the command stream.
                std::vector<float> audio;
                if (operation == "push") {
                    size_t samples = 0;
                    if (!(command >> samples)) throw std::runtime_error("Unreadable audio sample count.");
                    audio = read_audio(samples);
                }
                Stream& stream = streams.at(id);
                if (stream.finished) throw std::runtime_error("The stream has already finished.");
                if (operation == "push") {
                    check(nemo_speech_diar_stream_push_f32(
                        stream.handle.get(), audio.data(), audio.size(), stream.sample_rate
                    ));
                } else if (operation == "finish") {
                    check(nemo_speech_diar_stream_finish(stream.handle.get()));
                    stream.finished = true;
                } else {
                    throw std::runtime_error("Unknown diarization operation.");
                }
                emit_result(request, stream, speakers, seconds_per_frame);
            }
        } catch (const std::exception& error) {
            emit_error(request, error.what());
            if (!std::cin) return 1;
        }
    }
    // EOF is the owner's graceful shutdown. No stream outlives the model, and
    // there is no claim that EOF interrupts an active native inference call.
    return 0;
}

int run(const std::string& model_path) {
    try {
        return serve(model_path);
    } catch (const std::exception& error) {
        emit_error(0, error.what());
        return 1;
    }
}

} // namespace

#ifdef _WIN32
int wmain(int argc, wchar_t** argv) {
    if (argc != 2) {
        emit_error(0, "Usage: arcane-diarization MODEL.gguf");
        return 1;
    }
    const int length = WideCharToMultiByte(CP_UTF8, 0, argv[1], -1, nullptr, 0, nullptr, nullptr);
    if (length == 0) {
        emit_error(0, "Windows could not encode the selected model path as UTF-8.");
        return 1;
    }
    std::string model_path(length, '\0');
    WideCharToMultiByte(CP_UTF8, 0, argv[1], -1, model_path.data(), length, nullptr, nullptr);
    model_path.pop_back();
    return run(model_path);
}
#else
int main(int argc, char** argv) {
    if (argc != 2) {
        emit_error(0, "Usage: arcane-diarization MODEL.gguf");
        return 1;
    }
    return run(argv[1]);
}
#endif
