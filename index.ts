import { registerRootComponent } from 'expo';

// FFS Glasses OS entry — the launcher/home shell (FUT-163, Phase 1).
// Our own stack end-to-end: useFfsBluetooth → connection supervisor → screenOwner
// → hud (FfsBle.showText), NO @mentra. The old ffs-ble test harness (FfsBleTestApp)
// stays in the repo for isolated driver bring-up, but the app now boots the real OS.
import App from './src/os/App';

// registerRootComponent calls AppRegistry.registerComponent('main', () => App);
// It also ensures that whether you load the app in Expo Go or in a native build,
// the environment is set up appropriately
registerRootComponent(App);
