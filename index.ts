import { registerRootComponent } from 'expo';

// ⚠️ P1 TEST BUILD (branch rico/fut-149-p1-ffs-ble-native-module, FUT-149).
// This entry points at the ffs-ble driver test harness, NOT the real app shell,
// so our own from-scratch CoreBluetooth stack can be exercised on-glass in
// isolation (no @mentra/bluetooth-sdk contending for the peripheral). The real
// `App` is restored before this branch merges.
import App from './src/os/FfsBleTestApp';

// registerRootComponent calls AppRegistry.registerComponent('main', () => App);
// It also ensures that whether you load the app in Expo Go or in a native build,
// the environment is set up appropriately
registerRootComponent(App);
