#include <jni.h>

// Stub shared library for React Native merged libraries.
// React Native 0.76+ merges several native libraries into libreactnative.so
// via the jni_lib_merge mechanism. The real JNI method registrations happen
// inside libreactnative.so's JNI_OnLoad (confirmed by jni_lib_merge log).
//
// These stubs exist solely so SoLoader.loadLibrary("<name>") succeeds when
// Java/Kotlin class initializers call it as a guard. They do NOT re-register
// any JNI methods — those are already bound when libreactnative.so loaded.
extern "C" JNIEXPORT jint JNI_OnLoad(JavaVM* vm, void* reserved) {
    return JNI_VERSION_1_6;
}
