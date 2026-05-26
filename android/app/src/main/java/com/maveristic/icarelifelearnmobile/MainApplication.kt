package com.maveristic.icarelifelearnmobile

import android.app.Application
import android.content.Context
import android.content.res.Configuration
import com.facebook.react.PackageList
import com.facebook.react.ReactApplication
import com.facebook.react.ReactHost
import com.facebook.react.ReactNativeHost
import com.facebook.react.ReactPackage
import com.facebook.react.defaults.DefaultNewArchitectureEntryPoint.load
import com.facebook.react.defaults.DefaultReactHost.getDefaultReactHost
import com.facebook.react.defaults.DefaultReactNativeHost
import com.facebook.soloader.SoLoader
import expo.modules.ApplicationLifecycleDispatcher
import expo.modules.ReactNativeHostWrapper

class MainApplication : Application(), ReactApplication {

  override val reactNativeHost: ReactNativeHost =
    ReactNativeHostWrapper(this, object : DefaultReactNativeHost(this) {
      override fun getPackages(): List<ReactPackage> =
        PackageList(this).packages.apply {
          // Packages that cannot be autolinked yet can be added manually here
        }

      override fun getJSMainModuleName(): String = "index"

      override fun getUseDeveloperSupport(): Boolean = BuildConfig.DEBUG

      override val isNewArchEnabled: Boolean = BuildConfig.IS_NEW_ARCHITECTURE_ENABLED
      override val isHermesEnabled: Boolean = BuildConfig.IS_HERMES_ENABLED
    })

  override val reactHost: ReactHost
    get() = getDefaultReactHost(applicationContext, reactNativeHost)

  override fun attachBaseContext(base: Context) {
    super.attachBaseContext(base)
    // Pre-load libfbjni.so via System.loadLibrary (Java-frame path) before SoLoader.init()
    // and before any ContentProvider or Expo module can load it via native dlopen.
    //
    // Root cause of UnsatisfiedLinkError: some Expo/RN native library loads as an ELF
    // dependency early in the process (via native dlopen, no Java frame). This transitively
    // loads libfbjni.so via the ELF linker — also no Java frame. fbjni's JNI_OnLoad caches
    // the calling thread's class loader at first init; without a Java frame, it caches
    // null/system class loader. Later, jni_lib_merge inside libreactnative.so's JNI_OnLoad
    // calls fbjni.FindClass("ReactNativeFeatureFlagsCxxInterop") → returns null →
    // RegisterNatives is never called → UnsatisfiedLinkError at runtime.
    //
    // Fix: load libfbjni.so here, from a Java frame, so fbjni caches the correct app
    // PathClassLoader. The ELF linker won't call JNI_OnLoad again for already-loaded libs,
    // so this one-time early load wins and all subsequent FindClass calls work correctly.
    if (BuildConfig.IS_NEW_ARCHITECTURE_ENABLED) {
      System.loadLibrary("fbjni")
    }
  }

  override fun onCreate() {
    super.onCreate()
    SoLoader.init(this, false)
    if (BuildConfig.IS_NEW_ARCHITECTURE_ENABLED) {
      load()
    }
    ApplicationLifecycleDispatcher.onApplicationCreate(this)
  }

  override fun onConfigurationChanged(newConfig: Configuration) {
    super.onConfigurationChanged(newConfig)
    ApplicationLifecycleDispatcher.onConfigurationChanged(this, newConfig)
  }
}
