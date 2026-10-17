cmake_minimum_required(VERSION 3.26)
project(ArcaneMagpie LANGUAGES CXX)

find_package(NeMoSpeech REQUIRED COMPONENTS TTS)
find_package(Threads REQUIRED)

add_executable(arcane-magpie main.cpp)
target_compile_features(arcane-magpie PRIVATE cxx_std_17)
target_link_libraries(arcane-magpie PRIVATE NeMoSpeech::TTS Threads::Threads)
install(TARGETS arcane-magpie RUNTIME DESTINATION bin)
