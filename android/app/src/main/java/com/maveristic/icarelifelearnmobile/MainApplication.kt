package com.maveristic.icarelifelearnmobile

import android.app.Application
import android.content.Context
import android.content.res.Configuration
import android.util.Log
import com.facebook.react.PackageList
import com.facebook.react.ReactApplication
import com.facebook.react.ReactHost
import com.facebook.react.ReactNativeHost
import com.facebook.react.ReactPackage
import com.facebook.react.defaults.DefaultNewArchitectureEntryPoint.load
import com.facebook.react.defaults.DefaultReactHost.getDefaultReactHost
import com.facebook.react.defaults.DefaultReactNativeHost
import com.facebook.react.soloader.OpenSourceMergedSoMapping
import com.facebook.soloader.SoLoader
import expo.modules.ApplicationLifecycleDispatcher
import expo.modules.ReactNativeHostWrapper

class MainApplication : Application(), ReactApplication {

  companion object {
    init {
      // Load fbjni then reactnative via System.loadLibrary (Java-frame path) at
      // class-load time — before property initializers, attachBaseContext, or SoLoader.
      //
      // WHY THIS IS NECESSARY:
      // SoLoader.loadLibrary("reactnative") routes through BackupSoSource when
      // ApplicationSoSource can't find the file, using native dlopen() with no Java
      // frame on the stack. In that context env->FindClass() inside libreactnative.so's
      // JNI_OnLoad receives the boot ClassLoader (not the app's PathClassLoader), so
      // FindClass("ReactNativeFeatureFlagsCxxInterop") returns null and RegisterNatives
      // is silently skipped → UnsatisfiedLinkError at runtime.
      //
      // System.loadLibrary() always has a Java frame → env->FindClass() gets the app's
      // PathClassLoader → FindClass succeeds → jni_lib_merge RegisterNatives succeeds.
      // When SoLoader.loadLibrary("reactnative") is called later inside load(), the
      // library is already in memory so JNI_OnLoad is not called again — the methods
      // registered here persist.
      Log.d("ICARE_INIT", ">>> companion: loading fbjni")
      try {
        System.loadLibrary("fbjni")
        Log.d("ICARE_INIT", ">>> companion: fbjni OK")
      } catch (e: Throwable) {
        Log.e("ICARE_INIT", ">>> companion: fbjni FAILED — ${e.message}")
      }
      Log.d("ICARE_INIT", ">>> companion: loading reactnative")
      try {
        System.loadLibrary("reactnative")
        Log.d("ICARE_INIT", ">>> companion: reactnative OK")
      } catch (e: Throwable) {
        Log.e("ICARE_INIT", ">>> companion: reactnative FAILED — ${e.message}")
      }
    }
  }

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
    Log.d("ICARE_INIT", ">>> attachBaseContext — IS_NEW_ARCH=${BuildConfig.IS_NEW_ARCHITECTURE_ENABLED}")
  }

  override fun onCreate() {
    super.onCreate()
    Log.d("ICARE_INIT", ">>> onCreate — calling SoLoader.init with OpenSourceMergedSoMapping")
    SoLoader.init(this, OpenSourceMergedSoMapping)
    Log.d("ICARE_INIT", ">>> SoLoader.init done")
    // Explicitly invoke reactnativejni's JNI_OnLoad via the merged SO mapping.
    // In New Architecture mode, BridgeSoLoader (@LegacyArchitecture) is not used,
    // so nothing else calls SoLoader.loadLibrary("reactnativejni"). Without this,
    // Java TurboModules like PlatformConstants are never registered.
    Log.d("ICARE_INIT", ">>> loading reactnativejni")
    SoLoader.loadLibrary("reactnativejni")
    Log.d("ICARE_INIT", ">>> reactnativejni loaded — calling load()")
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
