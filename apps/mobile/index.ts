import "react-native-url-polyfill/auto";
import "@expo/metro-runtime";
import { createElement, useState } from "react";
import { registerRootComponent } from "expo";
import App from "./src/App";
import PdfInkProbe from "./src/PdfInkProbe";

function Root() {
  const [showProbe, setShowProbe] = useState(
    process.env.EXPO_PUBLIC_CONUO_PDF_INK_PROBE === "1",
  );

  return showProbe
    ? createElement(PdfInkProbe, { onExit: () => setShowProbe(false) })
    : createElement(App);
}

registerRootComponent(Root);
