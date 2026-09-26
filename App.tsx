import { StatusBar } from 'expo-status-bar';
import * as Haptics from 'expo-haptics';
import Ionicons from '@expo/vector-icons/Ionicons';
import { useKeepAwake } from 'expo-keep-awake';
import * as Location from 'expo-location';
import { useEffect, useMemo, useRef, useState } from 'react';
import {
  Alert,
  Linking,
  Modal,
  SafeAreaView,
  ScrollView,
  StyleSheet,
  Text,
  TextInput,
  TouchableOpacity,
  View,
  useWindowDimensions,
} from 'react-native';
import AsyncStorage from '@react-native-async-storage/async-storage';

const DEFAULT_SPEED_LIMIT = 120;
const SPEED_LIMIT_STORAGE_KEY = 'motorcycle_speed_limit';
const RIDE_STATS_STORAGE_KEY = 'motorcycle_ride_stats_v1';
const RIDE_HISTORY_STORAGE_KEY = 'motorcycle_ride_history_v1';
const MAX_RELIABLE_GPS_ACCURACY_METERS = 30;
const MOVING_SPEED_THRESHOLD_KMH = 2;
const COLORS = {
  background: '#080A0D',
  surface: '#0D1116',
  ink: '#F3F2EE',
  muted: '#9299A5',
  hairline: '#28303A',
  green: '#61D59A',
  amber: '#E0AA50',
  red: '#F06D67',
};
type GpsState = 'searching' | 'ready' | 'weak' | 'denied' | 'disabled' | 'error';
type RideStats = {
  distanceKm: number;
  maxSpeedKmh: number;
  movingSeconds: number;
};
type RideRecord = RideStats & {
  endedAt: string;
  id: string;
};

const EMPTY_RIDE_STATS: RideStats = { distanceKm: 0, maxSpeedKmh: 0, movingSeconds: 0 };

function parseSpeedLimit(value: string): number | null {
  if (!/^\d{1,3}$/.test(value)) {
    return null;
  }

  return Number(value);
}

function distanceBetweenMeters(first: Location.LocationObjectCoords, second: Location.LocationObjectCoords) {
  const earthRadiusMeters = 6_371_000;
  const latitudeDelta = ((second.latitude - first.latitude) * Math.PI) / 180;
  const longitudeDelta = ((second.longitude - first.longitude) * Math.PI) / 180;
  const firstLatitude = (first.latitude * Math.PI) / 180;
  const secondLatitude = (second.latitude * Math.PI) / 180;
  const a =
    Math.sin(latitudeDelta / 2) ** 2 +
    Math.cos(firstLatitude) * Math.cos(secondLatitude) * Math.sin(longitudeDelta / 2) ** 2;

  return 2 * earthRadiusMeters * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
}

function formatDuration(totalSeconds: number) {
  const hours = Math.floor(totalSeconds / 3600);
  const minutes = Math.floor((totalSeconds % 3600) / 60);
  const seconds = totalSeconds % 60;

  return hours > 0
    ? `${hours.toString().padStart(2, '0')}:${minutes.toString().padStart(2, '0')}`
    : `${minutes.toString().padStart(2, '0')}:${seconds.toString().padStart(2, '0')}`;
}

function formatHeading(heading: number | null) {
  if (heading === null) {
    return '—';
  }

  const directions = ['N', 'NE', 'E', 'SE', 'S', 'SW', 'W', 'NW'];
  return directions[Math.round(heading / 45) % directions.length];
}

function formatClock(date: Date) {
  return new Intl.DateTimeFormat(undefined, {
    hour: '2-digit',
    minute: '2-digit',
    hour12: false,
  }).format(date);
}

function formatRideDate(endedAt: string) {
  return new Intl.DateTimeFormat(undefined, {
    day: '2-digit',
    month: 'short',
  }).format(new Date(endedAt));
}

function KeepAwakeWhileRiding() {
  useKeepAwake();
  return null;
}

export default function App() {
  const { width, height } = useWindowDimensions();
  const isLandscape = width > height;
  const [speedKmh, setSpeedKmh] = useState<number | null>(null);
  const [gpsState, setGpsState] = useState<GpsState>('searching');
  const [locationAttempt, setLocationAttempt] = useState(0);
  const [isRideMode, setIsRideMode] = useState(true);
  const [rideStats, setRideStats] = useState<RideStats>(EMPTY_RIDE_STATS);
  const [hasLoadedRideStats, setHasLoadedRideStats] = useState(false);
  const [rideHistory, setRideHistory] = useState<RideRecord[]>([]);
  const [hasLoadedRideHistory, setHasLoadedRideHistory] = useState(false);
  const [isSettingsVisible, setIsSettingsVisible] = useState(false);
  const [currentTime, setCurrentTime] = useState(() => new Date());
  const [heading, setHeading] = useState<number | null>(null);
  const [altitudeMeters, setAltitudeMeters] = useState<number | null>(null);
  const [gpsAccuracyMeters, setGpsAccuracyMeters] = useState<number | null>(null);
  const [limit, setLimit] = useState(String(DEFAULT_SPEED_LIMIT));
  const [isEditingLimit, setIsEditingLimit] = useState(false);
  const previousLocationRef = useRef<Location.LocationObject | null>(null);
  const lastStatsTimestampRef = useRef<number | null>(null);
  const wasOverLimitRef = useRef(false);

  useEffect(() => {
    const loadStoredLimit = async () => {
      try {
        const storedValue = await AsyncStorage.getItem(SPEED_LIMIT_STORAGE_KEY);
        if (storedValue !== null) {
          const numericValue = parseSpeedLimit(storedValue);
          if (numericValue !== null) {
            setLimit(String(numericValue));
          }
        }
      } catch {
        // Ignore storage errors and keep the default limit.
      }
    };

    loadStoredLimit();
  }, []);

  useEffect(() => {
    const updateClock = () => setCurrentTime(new Date());
    const interval = setInterval(updateClock, 1_000);

    return () => clearInterval(interval);
  }, []);

  useEffect(() => {
    const loadRideHistory = async () => {
      try {
        const storedValue = await AsyncStorage.getItem(RIDE_HISTORY_STORAGE_KEY);
        if (storedValue === null) {
          return;
        }

        const parsedValue: unknown = JSON.parse(storedValue);
        if (Array.isArray(parsedValue)) {
          setRideHistory(
            parsedValue.filter(
              (record): record is RideRecord =>
                typeof record === 'object' &&
                record !== null &&
                typeof record.id === 'string' &&
                typeof record.endedAt === 'string' &&
                typeof record.distanceKm === 'number' &&
                typeof record.maxSpeedKmh === 'number' &&
                typeof record.movingSeconds === 'number'
            )
          );
        }
      } catch {
        // Keep an empty history when local storage is unavailable or malformed.
      } finally {
        setHasLoadedRideHistory(true);
      }
    };

    loadRideHistory();
  }, []);

  useEffect(() => {
    const loadRideStats = async () => {
      try {
        const storedValue = await AsyncStorage.getItem(RIDE_STATS_STORAGE_KEY);
        if (storedValue === null) {
          return;
        }

        const parsedValue: unknown = JSON.parse(storedValue);
        if (
          typeof parsedValue === 'object' &&
          parsedValue !== null &&
          'distanceKm' in parsedValue &&
          'maxSpeedKmh' in parsedValue &&
          'movingSeconds' in parsedValue &&
          typeof parsedValue.distanceKm === 'number' &&
          typeof parsedValue.maxSpeedKmh === 'number' &&
          typeof parsedValue.movingSeconds === 'number'
        ) {
          setRideStats({
            distanceKm: parsedValue.distanceKm,
            maxSpeedKmh: parsedValue.maxSpeedKmh,
            movingSeconds: parsedValue.movingSeconds,
          });
        }
      } catch {
        // Keep the empty trip when local storage is unavailable or malformed.
      } finally {
        setHasLoadedRideStats(true);
      }
    };

    loadRideStats();
  }, []);

  useEffect(() => {
    if (!hasLoadedRideStats) {
      return;
    }

    AsyncStorage.setItem(RIDE_STATS_STORAGE_KEY, JSON.stringify(rideStats)).catch(() => {
      // The dashboard still works when ride statistics cannot be persisted.
    });
  }, [hasLoadedRideStats, rideStats]);

  useEffect(() => {
    if (!hasLoadedRideHistory) {
      return;
    }

    AsyncStorage.setItem(RIDE_HISTORY_STORAGE_KEY, JSON.stringify(rideHistory)).catch(() => {
      // History remains available for this session if local persistence fails.
    });
  }, [hasLoadedRideHistory, rideHistory]);

  useEffect(() => {
    let isMounted = true;
    let subscription: Location.LocationSubscription | undefined;

    if (!isRideMode) {
      setSpeedKmh(null);
      setGpsState('searching');
      return () => {
        isMounted = false;
      };
    }

    const watchSpeed = async () => {
      try {
        setGpsState('searching');
        const { status } = await Location.requestForegroundPermissionsAsync();

        if (!isMounted) {
          return;
        }

        if (status !== 'granted') {
          setGpsState('denied');
          setSpeedKmh(null);
          return;
        }

        const locationServicesEnabled = await Location.hasServicesEnabledAsync();

        if (!isMounted) {
          return;
        }

        if (!locationServicesEnabled) {
          setGpsState('disabled');
          setSpeedKmh(null);
          return;
        }

        subscription = await Location.watchPositionAsync(
          {
            accuracy: Location.Accuracy.BestForNavigation,
            timeInterval: 500,
            distanceInterval: 0,
          },
          (location) => {
            const metersPerSecond = location.coords.speed;
            const nextSpeedKmh =
              typeof metersPerSecond === 'number' && Number.isFinite(metersPerSecond)
                ? Math.max(0, metersPerSecond * 3.6)
                : null;
            const hasReliableAccuracy =
              location.coords.accuracy !== null && location.coords.accuracy <= MAX_RELIABLE_GPS_ACCURACY_METERS;

            if (!isMounted) {
              return;
            }

            setSpeedKmh(nextSpeedKmh);
            setHeading(location.coords.heading);
            setAltitudeMeters(location.coords.altitude);
            setGpsAccuracyMeters(location.coords.accuracy);
            setGpsState(nextSpeedKmh === null ? 'searching' : hasReliableAccuracy ? 'ready' : 'weak');

            const previousLocation = previousLocationRef.current;
            const previousTimestamp = lastStatsTimestampRef.current;
            previousLocationRef.current = location;
            lastStatsTimestampRef.current = location.timestamp;

            if (!hasReliableAccuracy || nextSpeedKmh === null) {
              return;
            }

            setRideStats((currentStats) => ({
              ...currentStats,
              maxSpeedKmh: Math.max(currentStats.maxSpeedKmh, nextSpeedKmh),
            }));

            if (previousLocation === null || previousTimestamp === null) {
              return;
            }

            const segmentMeters = distanceBetweenMeters(previousLocation.coords, location.coords);
            const elapsedSeconds = Math.max(0, Math.round((location.timestamp - previousTimestamp) / 1000));
            const isMoving = nextSpeedKmh >= MOVING_SPEED_THRESHOLD_KMH;

            if (segmentMeters > 500 || !isMoving) {
              return;
            }

            setRideStats((currentStats) => ({
              distanceKm: currentStats.distanceKm + segmentMeters / 1000,
              maxSpeedKmh: currentStats.maxSpeedKmh,
              movingSeconds: currentStats.movingSeconds + elapsedSeconds,
            }));
          },
          () => {
            if (isMounted) {
              setGpsState('error');
              setSpeedKmh(null);
            }
          }
        );

        if (!isMounted) {
          subscription.remove();
        }
      } catch {
        if (isMounted) {
          setGpsState('error');
          setSpeedKmh(null);
        }
      }
    };

    watchSpeed();

    return () => {
      isMounted = false;
      if (subscription) {
        subscription.remove();
      }
    };
  }, [isRideMode, locationAttempt]);

  const parsedLimit = parseSpeedLimit(limit);
  const safeLimit = parsedLimit ?? DEFAULT_SPEED_LIMIT;
  const isOverLimit = speedKmh !== null && speedKmh > safeLimit;

  useEffect(() => {
    if (isOverLimit && !wasOverLimitRef.current) {
      Haptics.notificationAsync(Haptics.NotificationFeedbackType.Warning).catch(() => {
        // Haptics are an enhancement; the visual warning remains the source of truth.
      });
    }

    wasOverLimitRef.current = isOverLimit;
  }, [isOverLimit]);

  const displaySpeed = useMemo(() => {
    if (speedKmh === null) {
      return '--';
    }

    return Math.round(speedKmh).toString();
  }, [speedKmh]);

  const speedFontSize = isLandscape
    ? Math.min(width * 0.23, 220)
    : Math.min(width * 0.34, 260);

  const unitFontSize = isLandscape ? Math.min(width * 0.04, 28) : Math.min(width * 0.08, 40);

  const activeGpsStatus = {
    searching: { label: 'GPS SEARCHING', color: COLORS.muted },
    ready: { label: 'GPS READY', color: COLORS.green },
    weak: { label: 'GPS WEAK', color: COLORS.amber },
    denied: { label: 'LOCATION NEEDED', color: COLORS.amber },
    disabled: { label: 'LOCATION OFF', color: COLORS.amber },
    error: { label: 'GPS RETRY', color: COLORS.red },
  }[gpsState];
  const gpsStatus = isRideMode ? activeGpsStatus : { label: 'PARKED', color: COLORS.muted };

  const handleGpsPress = async () => {
    if (!isRideMode) {
      setIsRideMode(true);
      return;
    }

    if (gpsState === 'denied' || gpsState === 'disabled') {
      try {
        await Linking.openSettings();
      } catch {
        Alert.alert('Open Settings', 'Enable location access for Speeeeed, then return to retry GPS.');
      }
      return;
    }

    setLocationAttempt((attempt) => attempt + 1);
  };

  const handleRideModePress = () => {
    if (isRideMode) {
      if (rideStats.distanceKm > 0 || rideStats.movingSeconds > 0) {
        setRideHistory((currentHistory) => [
          {
            ...rideStats,
            endedAt: new Date().toISOString(),
            id: String(Date.now()),
          },
          ...currentHistory,
        ].slice(0, 20));
      }
    } else {
      previousLocationRef.current = null;
      lastStatsTimestampRef.current = null;
      setRideStats(EMPTY_RIDE_STATS);
    }

    setIsRideMode(!isRideMode);
    Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Soft).catch(() => {
      // Some devices do not expose haptics.
    });
  };

  const handleResetTrip = () => {
    Alert.alert('Reset trip?', 'This clears the locally saved trip distance, maximum speed, and moving time.', [
      { text: 'Cancel', style: 'cancel' },
      {
        text: 'Reset',
        style: 'destructive',
        onPress: () => {
          previousLocationRef.current = null;
          lastStatsTimestampRef.current = null;
          setRideStats(EMPTY_RIDE_STATS);
        },
      },
    ]);
  };

  const handleClearRideHistory = () => {
    Alert.alert('Clear ride history?', 'This permanently removes all locally saved past rides.', [
      { text: 'Cancel', style: 'cancel' },
      { text: 'Clear', style: 'destructive', onPress: () => setRideHistory([]) },
    ]);
  };

  const handleLimitSave = async () => {
    const numericValue = parseSpeedLimit(limit);

    if (numericValue === null) {
      Alert.alert('Invalid limit', 'Enter a whole number from 0 to 999 km/h.');
      setLimit(String(safeLimit));
      setIsEditingLimit(false);
      return;
    }

    const nextLimit = String(numericValue);
    setLimit(nextLimit);
    Haptics.selectionAsync().catch(() => {
      // Some devices do not expose haptics.
    });

    try {
      await AsyncStorage.setItem(SPEED_LIMIT_STORAGE_KEY, nextLimit);
    } catch {
      Alert.alert('Storage error', 'The limit could not be saved.');
    }

    setIsEditingLimit(false);
  };

  return (
    <SafeAreaView style={styles.safeArea}>
      <StatusBar style="light" hidden />
      {isRideMode ? <KeepAwakeWhileRiding /> : null}

      <View style={styles.screen}>
        <View style={[styles.topBar, isLandscape ? styles.topBarLandscape : styles.topBarPortrait]}>
          <View>
            <Text style={styles.brand}>TRIUMPH</Text>
            <Text style={styles.clock}>{formatClock(currentTime)}</Text>
          </View>

          <View style={styles.topActions}>
            <TouchableOpacity
              accessibilityLabel="Open settings"
              accessibilityRole="button"
              hitSlop={8}
              onPress={() => setIsSettingsVisible(true)}
              style={styles.settingsButton}
            >
              <Ionicons color={COLORS.ink} name="settings-outline" size={22} />
            </TouchableOpacity>
            <TouchableOpacity
              accessibilityLabel={gpsStatus.label}
              accessibilityHint={
                gpsState === 'denied' || gpsState === 'disabled'
                  ? 'Opens Settings so you can enable location access.'
                  : 'Retries GPS.'
              }
              accessibilityRole="button"
              onPress={handleGpsPress}
              style={styles.gpsWrap}
            >
              <View style={[styles.gpsDot, { backgroundColor: gpsStatus.color }]} />
              <Text style={[styles.gpsText, { color: gpsStatus.color }]}>{gpsStatus.label}</Text>
            </TouchableOpacity>
          </View>
        </View>

        <View style={styles.readoutArea}>
          <View pointerEvents="none" style={[styles.speedArc, isLandscape ? styles.speedArcLandscape : styles.speedArcPortrait]} />
          <View style={[styles.speedWrap, isLandscape ? styles.speedWrapLandscape : styles.speedWrapPortrait]}>
            <Text style={[styles.speed, { fontSize: speedFontSize, color: isOverLimit ? COLORS.red : COLORS.ink }]}>
              {displaySpeed}
            </Text>
            <Text style={[styles.unit, { fontSize: unitFontSize, color: isOverLimit ? COLORS.red : COLORS.muted }]}>
              km/h
            </Text>
          </View>
        </View>

        {isOverLimit ? (
          <Text accessibilityLiveRegion="polite" style={styles.overLimitText}>
            OVER LIMIT
          </Text>
        ) : null}

        <View style={styles.rideMetrics}>
          <View style={styles.metric}>
            <Text style={styles.metricLabel}>TRIP</Text>
            <Text style={styles.metricValue}>{rideStats.distanceKm.toFixed(1)} km</Text>
          </View>
          <View style={styles.metricDivider} />
          <View style={styles.metric}>
            <Text style={styles.metricLabel}>MAX</Text>
            <Text style={styles.metricValue}>{Math.round(rideStats.maxSpeedKmh)} km/h</Text>
          </View>
          <View style={styles.metricDivider} />
          <View style={styles.metric}>
            <Text style={styles.metricLabel}>MOVING</Text>
            <Text style={styles.metricValue}>{formatDuration(rideStats.movingSeconds)}</Text>
          </View>
        </View>

        <View style={styles.sensorRow}>
          <Text style={styles.sensorText}>HDG {formatHeading(heading)}</Text>
          <Text style={styles.sensorText}>ALT {altitudeMeters === null ? '—' : `${Math.round(altitudeMeters)} m`}</Text>
          <Text style={styles.sensorText}>±{gpsAccuracyMeters === null ? '—' : `${Math.round(gpsAccuracyMeters)} m`}</Text>
        </View>

        <View style={styles.rideControls}>
          <TouchableOpacity
            accessibilityLabel={isRideMode ? 'End ride' : 'Start ride'}
            accessibilityRole="button"
            onPress={handleRideModePress}
            style={styles.rideButton}
          >
            <Text style={styles.rideButtonText}>{isRideMode ? 'END RIDE' : 'START RIDE'}</Text>
          </TouchableOpacity>
          <TouchableOpacity
            accessibilityLabel="Reset trip"
            accessibilityRole="button"
            onPress={handleResetTrip}
            style={styles.resetButton}
          >
            <Text style={styles.resetButtonText}>RESET TRIP</Text>
          </TouchableOpacity>
        </View>
      </View>

      <Modal animationType="slide" onRequestClose={() => setIsSettingsVisible(false)} visible={isSettingsVisible}>
        <SafeAreaView style={styles.settingsScreen}>
          <View style={styles.settingsHeader}>
            <Text style={styles.settingsTitle}>SETTINGS</Text>
            <TouchableOpacity
              accessibilityLabel="Close settings"
              accessibilityRole="button"
              onPress={() => setIsSettingsVisible(false)}
              style={styles.settingsCloseButton}
            >
              <Ionicons color={COLORS.ink} name="close" size={26} />
            </TouchableOpacity>
          </View>

          <ScrollView contentContainerStyle={styles.settingsContent}>
            <Text style={styles.settingsSectionTitle}>SPEED ALERT</Text>
            <View style={styles.settingsCard}>
              {isEditingLimit ? (
                <View style={styles.limitEditor}>
                  <TextInput
                    value={limit}
                    onChangeText={setLimit}
                    keyboardType="number-pad"
                    placeholder="Limit"
                    placeholderTextColor={COLORS.muted}
                    style={styles.limitInput}
                    maxLength={3}
                    selectTextOnFocus
                    autoFocus
                    onSubmitEditing={handleLimitSave}
                  />
                  <TouchableOpacity accessibilityLabel="Save speed limit" accessibilityRole="button" style={styles.limitButton} onPress={handleLimitSave}>
                    <Text style={styles.limitButtonText}>SAVE</Text>
                  </TouchableOpacity>
                </View>
              ) : (
                <TouchableOpacity
                  accessibilityHint="Edits the speed-limit warning threshold."
                  accessibilityLabel={`Speed limit ${safeLimit} kilometres per hour`}
                  accessibilityRole="button"
                  onPress={() => setIsEditingLimit(true)}
                  style={styles.settingRow}
                >
                  <View>
                    <Text style={styles.settingRowLabel}>SPEED LIMIT</Text>
                    <Text style={styles.settingRowHint}>Warning threshold</Text>
                  </View>
                  <Text style={styles.settingRowValue}>{safeLimit} km/h</Text>
                </TouchableOpacity>
              )}
            </View>

            <View style={styles.settingsHistoryHeader}>
              <Text style={styles.settingsSectionTitle}>PAST RIDES</Text>
              {rideHistory.length > 0 ? (
                <TouchableOpacity accessibilityLabel="Clear ride history" accessibilityRole="button" onPress={handleClearRideHistory}>
                  <Text style={styles.clearHistoryText}>CLEAR</Text>
                </TouchableOpacity>
              ) : null}
            </View>

            {rideHistory.length === 0 ? (
              <View style={styles.emptyHistory}>
                <Text style={styles.emptyHistoryTitle}>NO SAVED RIDES</Text>
                <Text style={styles.emptyHistoryText}>End a ride to store its distance, maximum speed, and moving time here.</Text>
              </View>
            ) : (
              rideHistory.map((ride) => (
                <View key={ride.id} style={styles.historyRow}>
                  <Text style={styles.historyDate}>{formatRideDate(ride.endedAt)}</Text>
                  <View style={styles.historyValues}>
                    <Text style={styles.historyValue}>{ride.distanceKm.toFixed(1)} km</Text>
                    <Text style={styles.historyValue}>{Math.round(ride.maxSpeedKmh)} km/h</Text>
                    <Text style={styles.historyValue}>{formatDuration(ride.movingSeconds)}</Text>
                  </View>
                </View>
              ))
            )}
          </ScrollView>
        </SafeAreaView>
      </Modal>
    </SafeAreaView>
  );
}

const styles = StyleSheet.create({
  safeArea: {
    flex: 1,
    backgroundColor: COLORS.background,
  },
  screen: {
    flex: 1,
    backgroundColor: COLORS.background,
    justifyContent: 'center',
    alignItems: 'center',
    paddingHorizontal: 20,
    paddingVertical: 18,
  },
  topBar: {
    width: '100%',
    maxWidth: 900,
    flexDirection: 'row',
    justifyContent: 'space-between',
    alignItems: 'center',
    borderBottomWidth: 1,
    borderBottomColor: COLORS.hairline,
    paddingBottom: 14,
  },
  topBarPortrait: {
    marginBottom: 8,
  },
  topBarLandscape: {
    marginBottom: 2,
  },
  brand: {
    color: COLORS.ink,
    fontSize: 13,
    fontWeight: '700',
    letterSpacing: 4,
  },
  clock: {
    color: COLORS.muted,
    fontSize: 12,
    fontVariant: ['tabular-nums'],
    fontWeight: '700',
    letterSpacing: 1.2,
    marginTop: 5,
  },
  topActions: {
    alignItems: 'center',
    flexDirection: 'row',
    gap: 12,
  },
  settingsButton: {
    alignItems: 'center',
    borderColor: COLORS.hairline,
    borderRadius: 24,
    borderWidth: 1,
    height: 52,
    justifyContent: 'center',
    width: 52,
  },
  gpsWrap: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 6,
    minHeight: 48,
  },
  gpsDot: {
    width: 8,
    height: 8,
    borderRadius: 4,
  },
  gpsText: {
    color: COLORS.muted,
    fontSize: 10,
    fontWeight: '700',
    letterSpacing: 2,
    textTransform: 'uppercase',
  },
  speedWrap: {
    flexDirection: 'row',
    justifyContent: 'center',
    alignItems: 'flex-end',
    width: '100%',
  },
  speedWrapPortrait: {
    justifyContent: 'center',
    alignItems: 'center',
  },
  speedWrapLandscape: {
    justifyContent: 'center',
    alignItems: 'center',
    marginBottom: 10,
  },
  speed: {
    fontWeight: '800',
    fontVariant: ['tabular-nums'],
    letterSpacing: -7,
    textAlign: 'center',
    includeFontPadding: false,
  },
  unit: {
    fontWeight: '700',
    letterSpacing: 1.5,
    marginLeft: 10,
    marginBottom: 24,
    textTransform: 'lowercase',
  },
  readoutArea: {
    alignItems: 'center',
    flex: 1,
    justifyContent: 'center',
    maxWidth: 900,
    width: '100%',
  },
  speedArc: {
    borderColor: COLORS.hairline,
    borderRadius: 999,
    borderWidth: 1,
    opacity: 0.8,
    position: 'absolute',
  },
  speedArcPortrait: {
    height: 290,
    width: 290,
  },
  speedArcLandscape: {
    height: 250,
    width: 250,
  },
  overLimitText: {
    color: COLORS.red,
    fontSize: 12,
    fontWeight: '800',
    letterSpacing: 2,
    marginTop: -18,
    textTransform: 'uppercase',
  },
  rideMetrics: {
    alignItems: 'center',
    flexDirection: 'row',
    justifyContent: 'center',
    marginTop: 4,
    width: '100%',
  },
  metric: {
    alignItems: 'center',
    minWidth: 84,
  },
  metricDivider: {
    backgroundColor: COLORS.hairline,
    height: 26,
    width: 1,
  },
  metricLabel: {
    color: COLORS.muted,
    fontSize: 9,
    fontWeight: '700',
    letterSpacing: 1.6,
  },
  metricValue: {
    color: COLORS.ink,
    fontSize: 13,
    fontVariant: ['tabular-nums'],
    fontWeight: '700',
    marginTop: 3,
  },
  sensorRow: {
    flexDirection: 'row',
    gap: 14,
    justifyContent: 'center',
    marginTop: 12,
  },
  sensorText: {
    color: COLORS.muted,
    fontSize: 9,
    fontVariant: ['tabular-nums'],
    fontWeight: '700',
    letterSpacing: 1.3,
  },
  limitEditor: {
    flexDirection: 'row',
    alignItems: 'center',
    borderWidth: 1,
    borderColor: COLORS.hairline,
    borderRadius: 999,
    backgroundColor: COLORS.surface,
    paddingLeft: 16,
    overflow: 'hidden',
  },
  limitInput: {
    flex: 1,
    color: COLORS.ink,
    fontSize: 18,
    fontWeight: '700',
    minHeight: 56,
    paddingVertical: 10,
  },
  limitButton: {
    backgroundColor: COLORS.ink,
    justifyContent: 'center',
    minHeight: 56,
    paddingHorizontal: 16,
    paddingVertical: 10,
  },
  limitButtonText: {
    color: COLORS.background,
    fontSize: 11,
    fontWeight: '800',
    letterSpacing: 2,
  },
  rideControls: {
    flexDirection: 'row',
    gap: 10,
    marginTop: 14,
    maxWidth: 900,
    width: '100%',
  },
  rideButton: {
    alignItems: 'center',
    borderColor: COLORS.hairline,
    borderRadius: 999,
    borderWidth: 1,
    justifyContent: 'center',
    flex: 1.4,
    minHeight: 64,
    paddingHorizontal: 16,
  },
  rideButtonText: {
    color: COLORS.ink,
    fontSize: 10,
    fontWeight: '800',
    letterSpacing: 1.6,
  },
  resetButton: {
    alignItems: 'center',
    borderColor: COLORS.hairline,
    borderRadius: 999,
    borderWidth: 1,
    flex: 1,
    justifyContent: 'center',
    minHeight: 64,
    paddingHorizontal: 16,
  },
  resetButtonText: {
    color: COLORS.muted,
    fontSize: 10,
    fontWeight: '800',
    letterSpacing: 1.6,
  },
  settingsScreen: {
    backgroundColor: COLORS.background,
    flex: 1,
  },
  settingsHeader: {
    alignItems: 'center',
    borderBottomColor: COLORS.hairline,
    borderBottomWidth: 1,
    flexDirection: 'row',
    justifyContent: 'space-between',
    paddingHorizontal: 20,
    paddingVertical: 14,
  },
  settingsTitle: {
    color: COLORS.ink,
    fontSize: 13,
    fontWeight: '800',
    letterSpacing: 3,
  },
  settingsCloseButton: {
    alignItems: 'center',
    height: 48,
    justifyContent: 'center',
    width: 48,
  },
  settingsContent: {
    padding: 20,
    paddingBottom: 44,
  },
  settingsSectionTitle: {
    color: COLORS.muted,
    fontSize: 10,
    fontWeight: '800',
    letterSpacing: 2,
  },
  settingsCard: {
    backgroundColor: COLORS.surface,
    borderColor: COLORS.hairline,
    borderRadius: 16,
    borderWidth: 1,
    marginTop: 10,
    overflow: 'hidden',
  },
  settingRow: {
    alignItems: 'center',
    flexDirection: 'row',
    justifyContent: 'space-between',
    minHeight: 72,
    paddingHorizontal: 18,
  },
  settingRowLabel: {
    color: COLORS.ink,
    fontSize: 13,
    fontWeight: '800',
    letterSpacing: 1.2,
  },
  settingRowHint: {
    color: COLORS.muted,
    fontSize: 12,
    marginTop: 4,
  },
  settingRowValue: {
    color: COLORS.ink,
    fontSize: 17,
    fontVariant: ['tabular-nums'],
    fontWeight: '700',
  },
  settingsHistoryHeader: {
    alignItems: 'center',
    flexDirection: 'row',
    justifyContent: 'space-between',
    marginTop: 30,
  },
  clearHistoryText: {
    color: COLORS.red,
    fontSize: 10,
    fontWeight: '800',
    letterSpacing: 1.6,
  },
  emptyHistory: {
    borderColor: COLORS.hairline,
    borderRadius: 16,
    borderWidth: 1,
    marginTop: 10,
    padding: 20,
  },
  emptyHistoryTitle: {
    color: COLORS.ink,
    fontSize: 12,
    fontWeight: '800',
    letterSpacing: 1.4,
  },
  emptyHistoryText: {
    color: COLORS.muted,
    fontSize: 13,
    lineHeight: 19,
    marginTop: 8,
  },
  historyRow: {
    alignItems: 'center',
    borderBottomColor: COLORS.hairline,
    borderBottomWidth: 1,
    flexDirection: 'row',
    justifyContent: 'space-between',
    minHeight: 64,
  },
  historyDate: {
    color: COLORS.ink,
    fontSize: 13,
    fontWeight: '700',
  },
  historyValues: {
    alignItems: 'flex-end',
    gap: 3,
  },
  historyValue: {
    color: COLORS.muted,
    fontSize: 11,
    fontVariant: ['tabular-nums'],
    fontWeight: '700',
  },
});
