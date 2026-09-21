import "react-native-url-polyfill/auto";
import "@expo/metro-runtime";
import { registerRootComponent } from "expo";
import App from "./src/App";

registerRootComponent(App);
