package expo.modules.icareofflinedrm

import expo.modules.kotlin.exception.CodedException
import expo.modules.kotlin.modules.Module
import expo.modules.kotlin.modules.ModuleDefinition

class IcareLanguagePreferencesModule : Module() {
  override fun definition() = ModuleDefinition {
    Name("IcareLanguagePreferences")

    AsyncFunction("setPreferredLanguages") { codes: List<String>, promise: expo.modules.kotlin.Promise ->
      try {
        val ctx = appContext.reactContext
          ?: throw CodedException("ENO_CONTEXT", "Android context unavailable", null)
        LanguagePreferenceStore.save(ctx, codes)
        promise.resolve(LanguagePreferenceStore.get(ctx))
      } catch (e: Throwable) {
        promise.reject("ELANGUAGE_PREF_SAVE", e.message ?: "Failed to save language preferences", e)
      }
    }

    AsyncFunction("getPreferredLanguages") { promise: expo.modules.kotlin.Promise ->
      try {
        val ctx = appContext.reactContext
          ?: throw CodedException("ENO_CONTEXT", "Android context unavailable", null)
        promise.resolve(LanguagePreferenceStore.get(ctx))
      } catch (e: Throwable) {
        promise.reject("ELANGUAGE_PREF_READ", e.message ?: "Failed to read language preferences", e)
      }
    }
  }
}
