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
import com.facebook.soloader.SoLoader
import expo.modules.ApplicationLifecycleDispatcher
import expo.modules.ReactNativeHostWrapper

class MainApplication : Application(), ReactApplication {

  companion object {
    init {
      Log.d("ICARE_INIT", ">>> companion object init — about to loadLibrary(fbjni)")
      try {
        System.loadLibrary("fbjni")
        Log.d("ICARE_INIT", ">>> fbjni loaded OK in companion object init")
      } catch (e: Throwable) {
        Log.e("ICARE_INIT", ">>> fbjni load FAILED in companion object init: ${e.message}")
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
    Log.d("ICARE_INIT", ">>> onCreate — calling SoLoader.init")
    SoLoader.init(this, false)
    Log.d("ICARE_INIT", ">>> SoLoader.init done — calling load()")
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
