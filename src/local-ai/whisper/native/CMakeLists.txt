cmake_minimum_required(VERSION 3.26)
project(ArcaneWhisper LANGUAGES CXX)

set(WHISPER_SOURCE_DIRECTORY "" CACHE PATH "Matching upstream whisper.cpp source directory")
set(WHISPER_RUNTIME_DIRECTORY "" CACHE PATH "Selected complete upstream runtime directory")

find_path(WHISPER_INCLUDE_DIRECTORY whisper.h
    PATHS "${WHISPER_SOURCE_DIRECTORY}/include" REQUIRED NO_DEFAULT_PATH)
find_path(GGML_INCLUDE_DIRECTORY ggml-backend.h
    PATHS "${WHISPER_SOURCE_DIRECTORY}/ggml/include" REQUIRED NO_DEFAULT_PATH)

function(import_whisper_library name)
    if(WIN32)
        find_file(${name}_DLL "${name}.dll"
            PATHS "${WHISPER_RUNTIME_DIRECTORY}" "${WHISPER_RUNTIME_DIRECTORY}/bin"
            REQUIRED NO_DEFAULT_PATH)
        find_library(${name}_IMPORT_LIBRARY NAMES "${name}"
            PATHS "${WHISPER_RUNTIME_DIRECTORY}" "${WHISPER_RUNTIME_DIRECTORY}/lib"
            NO_DEFAULT_PATH)
        if(NOT ${name}_IMPORT_LIBRARY)
            if(NOT MSVC)
                message(FATAL_ERROR "This upstream Windows runtime needs MSVC to generate its missing import library.")
            endif()
            get_filename_component(compiler_directory "${CMAKE_CXX_COMPILER}" DIRECTORY)
            find_program(DUMPBIN_EXECUTABLE dumpbin HINTS "${compiler_directory}" REQUIRED)
            find_program(LIB_EXECUTABLE lib HINTS "${compiler_directory}" REQUIRED)
            execute_process(COMMAND "${DUMPBIN_EXECUTABLE}" /NOLOGO /EXPORTS "${${name}_DLL}"
                OUTPUT_VARIABLE export_table ERROR_VARIABLE export_error RESULT_VARIABLE export_result)
            if(NOT export_result EQUAL 0)
                message(FATAL_ERROR "${export_table}${export_error}")
            endif()
            file(WRITE "${CMAKE_CURRENT_BINARY_DIR}/${name}-exports.txt" "${export_table}${export_error}")
            string(REGEX MATCHALL "[\r\n][ \t]+[0-9]+[ \t]+[0-9A-Fa-f]+[ \t]+[0-9A-Fa-f]+[ \t]+[^ \t\r\n]+" rows "${export_table}")
            set(definition "LIBRARY ${name}.dll\nEXPORTS\n")
            foreach(row IN LISTS rows)
                string(REGEX REPLACE "^[\r\n][ \t]+[0-9]+[ \t]+[0-9A-Fa-f]+[ \t]+[0-9A-Fa-f]+[ \t]+" "" symbol "${row}")
                string(APPEND definition "${symbol}\n")
            endforeach()
            set(definition_path "${CMAKE_CURRENT_BINARY_DIR}/${name}.def")
            set(${name}_IMPORT_LIBRARY "${CMAKE_CURRENT_BINARY_DIR}/${name}.lib")
            file(WRITE "${definition_path}" "${definition}")
            if(CMAKE_SYSTEM_PROCESSOR MATCHES "[Aa][Rr][Mm]64|aarch64" OR CMAKE_GENERATOR_PLATFORM STREQUAL "ARM64")
                set(import_machine ARM64)
            elseif(CMAKE_SIZEOF_VOID_P EQUAL 8)
                set(import_machine X64)
            else()
                set(import_machine X86)
            endif()
            execute_process(COMMAND "${LIB_EXECUTABLE}" /NOLOGO "/DEF:${definition_path}"
                "/OUT:${${name}_IMPORT_LIBRARY}" "/MACHINE:${import_machine}"
                OUTPUT_VARIABLE import_output ERROR_VARIABLE import_error RESULT_VARIABLE import_result)
            if(NOT import_result EQUAL 0)
                message(FATAL_ERROR "${import_output}${import_error}")
            endif()
        endif()
        add_library(upstream_${name} SHARED IMPORTED)
        set_target_properties(upstream_${name} PROPERTIES
            IMPORTED_LOCATION "${${name}_DLL}"
            IMPORTED_IMPLIB "${${name}_IMPORT_LIBRARY}")
    else()
        find_library(${name}_LIBRARY NAMES "${name}"
            PATHS "${WHISPER_RUNTIME_DIRECTORY}" "${WHISPER_RUNTIME_DIRECTORY}/lib"
            REQUIRED NO_DEFAULT_PATH)
        add_library(upstream_${name} SHARED IMPORTED)
        set_target_properties(upstream_${name} PROPERTIES IMPORTED_LOCATION "${${name}_LIBRARY}")
    endif()
endfunction()

import_whisper_library(whisper)
import_whisper_library(ggml)
find_package(Threads REQUIRED)

add_executable(arcane-whisper main.cpp)
target_compile_features(arcane-whisper PRIVATE cxx_std_17)
target_compile_definitions(arcane-whisper PRIVATE WHISPER_SHARED GGML_SHARED)
target_include_directories(arcane-whisper PRIVATE "${WHISPER_INCLUDE_DIRECTORY}" "${GGML_INCLUDE_DIRECTORY}")
target_link_libraries(arcane-whisper PRIVATE upstream_whisper upstream_ggml Threads::Threads)
if(MSVC)
    target_compile_options(arcane-whisper PRIVATE /utf-8 /EHsc)
endif()
if(APPLE)
    set_target_properties(arcane-whisper PROPERTIES INSTALL_RPATH "@loader_path;@loader_path/../lib")
elseif(UNIX)
    set_target_properties(arcane-whisper PROPERTIES INSTALL_RPATH "$ORIGIN;$ORIGIN/../lib")
endif()
install(TARGETS arcane-whisper RUNTIME DESTINATION bin)

if(WIN32 AND MSVC)
    # The published Whisper DLLs and this helper share the release MSVC CRT.
    # Keep its permitted app-local redistributables beside the executable.
    set(CMAKE_INSTALL_SYSTEM_RUNTIME_DESTINATION bin)
    set(CMAKE_INSTALL_DEBUG_LIBRARIES FALSE)
    set(CMAKE_INSTALL_DEBUG_LIBRARIES_ONLY FALSE)
    set(CMAKE_INSTALL_UCRT_LIBRARIES FALSE)
    set(CMAKE_INSTALL_MFC_LIBRARIES FALSE)
    set(CMAKE_INSTALL_OPENMP_LIBRARIES FALSE)
    include(InstallRequiredSystemLibraries)
endif()
