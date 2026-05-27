cmake_minimum_required(VERSION 3.13)

# Build appmodules.so — the glue library for React Native New Architecture.
# Its JNI_OnLoad sets DefaultTurboModuleManagerDelegate::javaModuleProvider
# (and cxxModuleProvider / registerComponentDescriptorsFromEntryPoint).
# Without this, javaModuleProvider stays nullptr and ALL Java TurboModules
# (PlatformConstants, DeviceInfo, etc.) are unreachable from C++.
#
# ReactNative-application.cmake:
#   - Picks up default-app-setup/OnLoad.cpp (no .cpp in this dir → no override)
#   - Includes generated autolinking sources from ${PROJECT_BUILD_DIR}/generated/
#   - Links against ReactAndroid prefab (reactnative, jsi, fbjni)
#   - REACT_ANDROID_DIR / PROJECT_BUILD_DIR are injected by NdkConfiguratorUtils
#     in the react-native-gradle-plugin via autolinkLibrariesWithApp()

project(appmodules)
include(${REACT_ANDROID_DIR}/cmake-utils/ReactNative-application.cmake)
