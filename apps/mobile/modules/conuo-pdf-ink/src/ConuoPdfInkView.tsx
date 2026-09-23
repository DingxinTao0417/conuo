import { requireNativeView } from 'expo';
import * as React from 'react';

import { ConuoPdfInkViewProps } from './ConuoPdfInk.types';

const NativeView: React.ComponentType<ConuoPdfInkViewProps> = requireNativeView('ConuoPdfInk');

export default function ConuoPdfInkView(props: ConuoPdfInkViewProps) {
  return <NativeView {...props} />;
}
