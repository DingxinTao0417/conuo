import type { MetadataRoute } from "next";

export default function manifest(): MetadataRoute.Manifest {
  return {
    id: "/",
    name: "Conuo",
    short_name: "Conuo",
    description: "陪你把知识学会。",
    lang: "zh-CN",
    start_url: "/",
    scope: "/",
    display: "standalone",
    background_color: "#ffffff",
    theme_color: "#ffffff",
    categories: ["education", "productivity"],
    icons: [
      { src: "/conuo-icon-192.png", sizes: "192x192", type: "image/png", purpose: "any" },
      { src: "/conuo-icon-512.png", sizes: "512x512", type: "image/png", purpose: "any" },
    ],
    shortcuts: [
      {
        name: "资料库",
        short_name: "资料库",
        description: "打开资料库",
        url: "/#library",
      },
      {
        name: "问答",
        short_name: "问答",
        description: "打开学习问答",
        url: "/#questions",
      },
    ],
  };
}
