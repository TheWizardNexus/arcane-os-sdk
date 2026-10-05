cmake_minimum_required(VERSION 3.26)
project(ArcaneDiarization LANGUAGES CXX)

find_package(NeMoSpeech REQUIRED COMPONENTS Diarization)

add_executable(arcane-diarization main.cpp)
target_compile_features(arcane-diarization PRIVATE cxx_std_17)
target_link_libraries(arcane-diarization PRIVATE NeMoSpeech::Diarization)
install(TARGETS arcane-diarization RUNTIME DESTINATION bin)
