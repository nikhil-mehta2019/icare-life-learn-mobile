import { useRouter, type Href } from 'expo-router';
import { useCallback, useEffect, useState } from 'react';
import {
  ActivityIndicator,
  FlatList,
  Image,
  Pressable,
  RefreshControl,
  StyleSheet,
  Text,
  View,
} from 'react-native';
import { fetchCourses, type Course } from '../../api/base44Client';

export default function HomeScreen() {
  const router = useRouter();
  const [courses, setCourses] = useState<Course[]>([]);
  const [loading, setLoading] = useState(true);
  const [refreshing, setRefreshing] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(async () => {
    try {
      setError(null);
      const data = await fetchCourses({ status: 'published', showInCatalog: true });
      setCourses(data);
    } catch (err: any) {
      setError(err?.message ?? 'Could not load courses');
    } finally {
      setLoading(false);
      setRefreshing(false);
    }
  }, []);

  useEffect(() => { load(); }, [load]);

  const onRefresh = useCallback(() => {
    setRefreshing(true);
    load();
  }, [load]);

  if (loading) {
    return (
      <View style={styles.center}>
        <ActivityIndicator size="large" color="#1D3D47" />
        <Text style={styles.muted}>Loading courses…</Text>
      </View>
    );
  }

  if (error) {
    return (
      <View style={styles.center}>
        <Text style={styles.errorText}>Could not load courses</Text>
        <Text style={styles.muted}>{error}</Text>
        <Pressable style={styles.retryBtn} onPress={load}>
          <Text style={styles.retryBtnText}>Retry</Text>
        </Pressable>
      </View>
    );
  }

  return (
    <FlatList
      data={courses}
      keyExtractor={(c) => c.id}
      contentContainerStyle={styles.list}
      refreshControl={
        <RefreshControl
          refreshing={refreshing}
          onRefresh={onRefresh}
          tintColor="#1D3D47"
        />
      }
      ListHeaderComponent={
        <View style={styles.header}>
          <Text style={styles.headerTitle}>iCare Life Learn</Text>
          <Text style={styles.headerSub}>
            {courses.length} {courses.length === 1 ? 'course' : 'courses'} available
          </Text>
        </View>
      }
      ListEmptyComponent={
        <View style={styles.center}>
          <Text style={styles.muted}>No courses available yet.</Text>
        </View>
      }
      renderItem={({ item }) => (
        <CourseCard
          course={item}
          onPress={() => router.push('/(tabs)/explore' as unknown as Href)}
        />
      )}
    />
  );
}

function CourseCard({ course, onPress }: { course: Course; onPress: () => void }) {
  const durationText = course.totalDurationMinutes
    ? `${Math.round(course.totalDurationMinutes / 60)}h`
    : null;

  return (
    <Pressable style={styles.card} onPress={onPress}>
      {course.thumbnailUrl ? (
        <Image
          source={{ uri: course.thumbnailUrl }}
          style={styles.thumbnail}
          resizeMode="cover"
        />
      ) : (
        <View style={[styles.thumbnail, styles.thumbnailPlaceholder]}>
          <Text style={styles.thumbnailPlaceholderText}>
            {course.title.charAt(0).toUpperCase()}
          </Text>
        </View>
      )}
      <View style={styles.cardBody}>
        <Text style={styles.courseTitle} numberOfLines={2}>
          {course.title}
        </Text>
        {course.shortDescription ? (
          <Text style={styles.courseDesc} numberOfLines={2}>
            {course.shortDescription}
          </Text>
        ) : null}
        <View style={styles.metaRow}>
          {course.totalChapters ? (
            <Text style={styles.metaChip}>{course.totalChapters} chapters</Text>
          ) : null}
          {durationText ? (
            <Text style={styles.metaChip}>{durationText}</Text>
          ) : null}
          {course.language && course.language !== 'english' ? (
            <Text style={styles.metaChip}>{course.language}</Text>
          ) : null}
          <AccessBadge course={course} />
        </View>
      </View>
    </Pressable>
  );
}

function AccessBadge({ course }: { course: Course }) {
  if (course.courseAccessType === 'free') {
    return <Text style={[styles.metaChip, styles.chipFree]}>Free</Text>;
  }
  if (course.courseAccessType === 'paid' && course.priceINR) {
    return <Text style={[styles.metaChip, styles.chipPaid]}>₹{course.priceINR}</Text>;
  }
  if (course.courseAccessType === 'subscription') {
    return <Text style={[styles.metaChip, styles.chipSub]}>Subscription</Text>;
  }
  return null;
}

const styles = StyleSheet.create({
  list: { paddingBottom: 24 },
  center: {
    flex: 1,
    alignItems: 'center',
    justifyContent: 'center',
    padding: 24,
    gap: 10,
    minHeight: 200,
  },
  header: {
    paddingHorizontal: 16,
    paddingTop: 20,
    paddingBottom: 12,
  },
  headerTitle: {
    fontSize: 24,
    fontWeight: '700',
    color: '#1D3D47',
  },
  headerSub: {
    fontSize: 13,
    color: '#666',
    marginTop: 4,
  },
  card: {
    flexDirection: 'row',
    backgroundColor: '#fff',
    marginHorizontal: 16,
    marginBottom: 12,
    borderRadius: 12,
    overflow: 'hidden',
    elevation: 2,
    shadowColor: '#000',
    shadowOffset: { width: 0, height: 1 },
    shadowOpacity: 0.08,
    shadowRadius: 4,
  },
  thumbnail: {
    width: 100,
    height: 100,
  },
  thumbnailPlaceholder: {
    backgroundColor: '#1D3D47',
    alignItems: 'center',
    justifyContent: 'center',
  },
  thumbnailPlaceholderText: {
    fontSize: 36,
    fontWeight: '700',
    color: '#fff',
  },
  cardBody: {
    flex: 1,
    padding: 12,
    gap: 4,
  },
  courseTitle: {
    fontSize: 15,
    fontWeight: '600',
    color: '#1a1a1a',
    lineHeight: 20,
  },
  courseDesc: {
    fontSize: 12,
    color: '#555',
    lineHeight: 17,
  },
  metaRow: {
    flexDirection: 'row',
    flexWrap: 'wrap',
    gap: 6,
    marginTop: 6,
  },
  metaChip: {
    fontSize: 11,
    color: '#555',
    backgroundColor: '#f0f0f0',
    paddingHorizontal: 7,
    paddingVertical: 3,
    borderRadius: 4,
  },
  chipFree: { backgroundColor: '#e6f4ea', color: '#2e7d32' },
  chipPaid: { backgroundColor: '#fff3e0', color: '#e65100' },
  chipSub: { backgroundColor: '#e8eaf6', color: '#3949ab' },
  muted: { color: '#888', fontSize: 13, textAlign: 'center' },
  errorText: { fontSize: 15, fontWeight: '600', color: '#c62828' },
  retryBtn: {
    backgroundColor: '#1D3D47',
    paddingHorizontal: 20,
    paddingVertical: 10,
    borderRadius: 8,
    marginTop: 4,
  },
  retryBtnText: { color: '#fff', fontWeight: '600' },
});
