const {
  withAppDelegate,
  withInfoPlist,
  withPodfile,
} = require("@expo/config-plugins");
const { withBuildSourceFile } = require("@expo/config-plugins/build/ios/XcodeProjectFile");

const sceneDelegate = `internal import Expo

final class SceneDelegate: ExpoAppSceneDelegate {}
`;

/**
 * Xcode 27 requires UIKit apps to opt into the scene lifecycle. Expo SDK 57
 * already ships ExpoAppSceneDelegate; this plugin wires it into the generated
 * app and keeps the CocoaPods project selection explicit for CocoaPods 1.17.
 */
module.exports = function withSceneLifecycle(config) {
  config = withBuildSourceFile(config, {
    filePath: "SceneDelegate.swift",
    contents: sceneDelegate,
    overwrite: true,
  });

  config = withAppDelegate(config, (mod) => {
    if (!mod.modResults.contents.includes("ExpoReactNativeFactoryProvider")) {
      mod.modResults.contents = mod.modResults.contents.replace(
        "class AppDelegate: ExpoAppDelegate {",
        "class AppDelegate: ExpoAppDelegate, ExpoReactNativeFactoryProvider {"
      );
    }
    return mod;
  });

  config = withInfoPlist(config, (mod) => {
    mod.modResults.UIApplicationSceneManifest = {
      UIApplicationSupportsMultipleScenes: true,
      UISceneConfigurations: {
        UIWindowSceneSessionRoleApplication: [
          {
            UISceneConfigurationName: "Default Configuration",
            UISceneDelegateClassName: "$(PRODUCT_MODULE_NAME).SceneDelegate",
          },
        ],
      },
    };
    return mod;
  });

  config = withPodfile(config, (mod) => {
    if (!mod.modResults.contents.includes("project 'Conuo.xcodeproj'")) {
      mod.modResults.contents = mod.modResults.contents.replace(
        "prepare_react_native_project!",
        "prepare_react_native_project!\n\nproject 'Conuo.xcodeproj'"
      );
    }
    return mod;
  });

  return config;
};
