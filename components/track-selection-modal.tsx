import { useEffect, useState } from 'react';
import { Modal, Pressable, StyleSheet, Text, View } from 'react-native';
import { Platform } from 'react-native';

const BRAND = '#1D3D47';
const CARD_BG = '#1C2B35';
const SURFACE = '#243344';
const TEXT = '#F0F4F8';
const TEXT_MUTED = '#8A9BB0';
const ACCENT = '#4FC3F7';

// Language codes commonly used for English across HLS/Mux track metadata.
const ENGLISH_CODES = new Set(['en', 'eng', 'en-us', 'en-gb']);

function isEnglish(lang: string): boolean {
  return ENGLISH_CODES.has(lang.trim().toLowerCase());
}

interface TrackSelectionModalProps {
  visible: boolean;
  audioLanguages: string[];
  captionLanguages: string[];
  onCancel: () => void;
  onConfirm: (selection: { languages: string[]; audioLanguages: string[]; captionLanguages: string[] }) => void;
}

/**
 * Lets the user pick one or more languages before starting an offline
 * download — each selected language contributes BOTH its audio track and
 * its caption track (whichever exist) to the download. English is always
 * pre-selected and cannot be unchecked; other languages are optional
 * additions on top of it. Only shown when there's an actual choice to make
 * (>1 language available across audio/captions combined) — callers should
 * skip this modal entirely otherwise and fall back to "download everything".
 */
export function TrackSelectionModal({
  visible,
  audioLanguages,
  captionLanguages,
  onCancel,
  onConfirm,
}: TrackSelectionModalProps) {
  // The pickable list is every language that appears in either track type —
  // picking one includes its audio track (if present) and its caption track
  // (if present).
  const allLanguages = Array.from(new Set([...audioLanguages, ...captionLanguages]));
  const englishLanguages = allLanguages.filter(isEnglish);
  const [selected, setSelected] = useState<string[]>(englishLanguages);

  // This modal is mounted once per screen and reused across downloads, so
  // re-default to English-only each time it opens for a new chapter instead
  // of carrying over the previous selection.
  useEffect(() => {
    if (visible) setSelected(englishLanguages);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [visible]);

  const toggleLanguage = (lang: string) => {
    if (isEnglish(lang)) return; // English is locked on — cannot be deselected.
    setSelected((prev) =>
      prev.includes(lang) ? prev.filter((l) => l !== lang) : [...prev, lang]
    );
  };

  return (
    <Modal
      visible={visible}
      transparent
      animationType="slide"
      statusBarTranslucent
      onRequestClose={onCancel}
    >
      <Pressable style={styles.overlay} onPress={onCancel} />
      <View style={styles.sheet}>
        <View style={styles.handle} />

        <Text style={styles.title}>Download options</Text>
        <Text style={styles.sub}>Choose languages for audio and captions. English is always included.</Text>

        {allLanguages.map((lang) => {
          const locked = isEnglish(lang);
          const checked = selected.includes(lang);
          return (
            <Pressable
              key={lang}
              style={[styles.row, locked && styles.rowDisabled]}
              onPress={() => toggleLanguage(lang)}
              disabled={locked}
            >
              <Text style={styles.checkIcon}>{checked ? '☑' : '☐'}</Text>
              <Text style={styles.rowLabel}>{lang}</Text>
              {locked && <Text style={styles.lockedTag}>Always included</Text>}
            </Pressable>
          );
        })}

        <Pressable
          style={styles.confirmRow}
          onPress={() => {
            if (selected.length === 0) return;
            onConfirm({
              languages: selected,
              audioLanguages: selected.filter((l) => audioLanguages.includes(l)),
              captionLanguages: selected.filter((l) => captionLanguages.includes(l)),
            });
          }}
        >
          <Text style={styles.confirmText}>Download</Text>
        </Pressable>

        <Pressable style={styles.cancelRow} onPress={onCancel}>
          <Text style={styles.cancelText}>Cancel</Text>
        </Pressable>
      </View>
    </Modal>
  );
}

const styles = StyleSheet.create({
  overlay: {
    flex: 1,
    backgroundColor: 'rgba(0,0,0,0.6)',
  },
  sheet: {
    backgroundColor: CARD_BG,
    borderTopLeftRadius: 20,
    borderTopRightRadius: 20,
    paddingTop: 12,
    paddingBottom: Platform.OS === 'android' ? 24 : 36,
    paddingHorizontal: 20,
  },
  handle: {
    alignSelf: 'center',
    width: 40,
    height: 4,
    borderRadius: 2,
    backgroundColor: SURFACE,
    marginBottom: 16,
  },
  title: { color: TEXT, fontSize: 16, fontWeight: '700', marginBottom: 4 },
  sub: { color: TEXT_MUTED, fontSize: 12, marginBottom: 12 },
  row: {
    flexDirection: 'row',
    alignItems: 'center',
    paddingVertical: 12,
    gap: 16,
  },
  rowDisabled: { opacity: 0.7 },
  checkIcon: { fontSize: 18, width: 24, textAlign: 'center', color: ACCENT },
  rowLabel: { color: TEXT, fontSize: 15, textTransform: 'uppercase' },
  lockedTag: { color: TEXT_MUTED, fontSize: 11, marginLeft: 'auto' },
  confirmRow: {
    marginTop: 8,
    paddingVertical: 14,
    alignItems: 'center',
    backgroundColor: BRAND,
    borderRadius: 12,
  },
  confirmText: { color: TEXT, fontSize: 15, fontWeight: '700' },
  cancelRow: { marginTop: 8, paddingVertical: 14, alignItems: 'center' },
  cancelText: { color: TEXT_MUTED, fontSize: 15 },
});
