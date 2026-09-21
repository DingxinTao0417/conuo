import { cp, mkdir } from "node:fs/promises";
await mkdir(new URL("../dist/ui/", import.meta.url), { recursive: true });
await cp(
  new URL("../src/ui/", import.meta.url),
  new URL("../dist/ui/", import.meta.url),
  { recursive: true },
);
await cp(
  new URL("../../web/public/conuo-icon-512.png", import.meta.url),
  new URL("../dist/ui/icon.png", import.meta.url),
);
