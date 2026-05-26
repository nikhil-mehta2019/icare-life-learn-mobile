cmake_minimum_required(VERSION 3.22.1)
project(rnmergedstubs)

# These libraries are all merged into libreactnative.so via jni_lib_merge in
# React Native 0.76+. They do NOT exist as standalone .so files, but SoLoader
# still tries to find them by file when Java class initializers call
# SoLoader.loadLibrary("<name>"). We build minimal stubs to satisfy that check.
# The real JNI methods are registered by libreactnative.so's JNI_OnLoad.

set(MERGED_LIBS
    react_featureflagsjni
    fabricjni
    react_devsupportjni
    react_newarchdefaults
    reactnativeblob
    reactnativejni
    reactnativejni_common
    rninstance
    turbomodulejsijni
    uimanagerjni
    yoga
)

foreach(LIB_NAME ${MERGED_LIBS})
    add_library(${LIB_NAME} SHARED stub.cpp)
endforeach()
