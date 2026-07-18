cmake_minimum_required(VERSION 3.14)
project(splayer-madlad-worker C CXX)

if(NOT LLAMA_SOURCE_DIR)
  message(FATAL_ERROR "LLAMA_SOURCE_DIR must point to the pinned llama.cpp source")
endif()

set(BUILD_SHARED_LIBS OFF CACHE BOOL "" FORCE)
set(LLAMA_BUILD_TESTS OFF CACHE BOOL "" FORCE)
set(LLAMA_BUILD_EXAMPLES OFF CACHE BOOL "" FORCE)
set(LLAMA_BUILD_SERVER OFF CACHE BOOL "" FORCE)
set(LLAMA_CURL OFF CACHE BOOL "" FORCE)

add_subdirectory("${LLAMA_SOURCE_DIR}" llama.cpp)

add_executable(splayer-madlad-worker main.cpp)
target_compile_features(splayer-madlad-worker PRIVATE cxx_std_11)
target_link_libraries(splayer-madlad-worker PRIVATE common llama)
